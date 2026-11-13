// Supervisor 编排：recon → 拆解 → 扇出 worker → 独立复核 → 台账/报告。
// 设计约束：不猜、不硬撑、不把长文本塞回上下文；预算与并发由这里硬控，不靠提示词。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Ledger, BudgetStop } from './ledger.mjs'
import { effectiveRunBudget, admitTurn } from './budget.mjs'
import { extractJson, str, arr } from './jsonx.mjs'
import { MockBridge } from './sdk.mjs'
import { composeRecon, composeScaffold, composeWorker, composeVerifier } from './prompts.mjs'
import { listFiles, renderFileList, ensureTaskDir, findProbes, renderProbes } from './context.mjs'

// 账号/适配器级错误：重试与降级都没有意义，必须整条流水线立即停止。
/** 认领本段产物：名字不完全一致时，取最近写入的 json/txt/md（>200 B），复制成 artifact 名。 */
function adoptArtifact(dirAbs, wantName) {
  const want = path.basename(String(wantName || ''))
  if (!want) return null
  const direct = resolveArtifact([dirAbs], want)
  if (direct) return direct
  const fresh = safeList(dirAbs)
    .filter((f) => !/^(finding|probe_report)\.json$/i.test(f) && f !== want)
    .filter((f) => /\.(json|txt|md)$/i.test(f))
    .map((f) => ({ f, st: statSafe(path.join(dirAbs, f)) }))
    .filter((x) => x.st && x.st.size > 200 && x.st.size < 8 * 1024 * 1024)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  if (!fresh.length) return null
  if (!copyFileSafe(path.join(dirAbs, fresh[0].f), path.join(dirAbs, want))) return null
  return { ...resolveArtifact([dirAbs], want), adoptedFrom: fresh[0].f }
}
function safeList(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => {
      try { return fs.statSync(path.join(dir, f)).isFile() } catch { return false }
    })
  } catch {
    return []
  }
}

function statSafe(p) {
  try { return fs.statSync(p) } catch { return null }
}

function copyFileSafe(from, to) {
  try { fs.copyFileSync(from, to); return true } catch { return false }
}

const FATAL_RE =
  /Insufficient Balance|no adapter registered|invalid exact model metadata|missing API key|invalid api key|dsh runtime exited|ENOENT|EACCES/i

export class FatalStop extends Error {
  constructor(message) {
    super(message)
    this.name = 'FatalStop'
  }
}

const DIFFICULTY_WORKERS = { easy: 1, medium: 2, hard: 2 }

export function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`
}

function nowIso() {
  return new Date().toISOString()
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function normalizeSurface(raw, files) {
  const hypotheses = arr(raw?.hypotheses)
    .map((h, index) => ({
      id: str(h?.id, `t${index + 1}`),
      goal: str(h?.goal),
      deliverable: str(h?.deliverable),
      acceptance: str(h?.acceptance),
      // 串行阶段：依赖谁、这一阶段必须落哪个文件。
      artifact: str(h?.artifact),
      dependsOn: arr(h?.dependsOn).map((x) => str(x)).filter(Boolean),
      // 串行阶段：这一段允许的墙钟（秒）；0 表示用全局 stagedTurnSec。
      maxSeconds: Math.min(1200, Math.max(0, Number(h?.maxSeconds) || 0)),
    }))
    .filter((h) => h.goal && h.deliverable && h.acceptance)
    .slice(0, 4)
  return {
    category: str(raw?.category, 'misc'),
    difficulty: ['easy', 'medium', 'hard'].includes(raw?.difficulty) ? raw.difficulty : 'medium',
    entry: str(raw?.entry, files.length ? `附件 ${files[0].path}` : '未知入口'),
    attachments: arr(raw?.attachments).map((x) => str(x)).filter(Boolean),
    hypotheses,
    notes: str(raw?.notes).slice(0, 600),
  }
}

function fallbackSurface(files) {
  const first = files.find((f) => !f.dir)?.path ?? ''
  return {
    category: 'misc',
    difficulty: 'easy',
    entry: first ? `附件 ${first}` : '未知入口',
    attachments: first ? [first] : [],
    hypotheses: [
      {
        id: 't1',
        goal: '识别附件容器类型，提取可复核的结构与可见内容',
        deliverable: 'super/t1/notes.md',
        acceptance: 'notes.md 记录类型判断依据（魔数/结构）与至少 3 条可复核观察',
      },
    ],
    notes: 'recon 未产出可用 JSON，降级为单线最小任务。',
  }
}

function normalizeFinding(raw, taskId) {
  return {
    taskId: str(raw?.taskId, taskId),
    hypothesis: str(raw?.hypothesis),
    finding: str(raw?.finding),
    candidate: str(raw?.candidate),
    // Worker 把候选写进文件、只在 JSON 里给出路径：flag 不回传到对话里。
    candidateFile: str(raw?.candidateFile),
    evidence: arr(raw?.evidence).map((e) => ({
      path: str(e?.path),
      line: Number(e?.line) || 0,
      cmd: str(e?.cmd),
    })),
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
    next: str(raw?.next),
  }
}

/**
 * 兜底扫描：worker 常把还原出的字符串当「载体/中间产物」而不认作答案，
 * 这里在题目目录的 super/ 下按 flag 形态找一遍本轮新写的文本文件，命中即落成候选。
 */
const FLAG_SHAPE = /(flag\{[^}\n]{2,200}\}|FLAG:[0-9a-zA-Z_\-{}]{4,200}|^[0-9a-f]{32,128}$)/i
// 产物常是 JSON：答案躺在 inner_text/plaintext/candidate 这类字段里，不是 flag{…} 形态。
const FIELD_SHAPE = /"(?:candidate|plaintext|inner_text|answer|solution|key|secret)"\s*:\s*"((?:[^"\\]|\\.){8,200})"/i

function scanCandidateFiles(root, sinceMs) {
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!/^(node_modules|\.git|runs|turns)$/.test(entry.name)) walk(p, depth + 1)
        continue
      }
      try {
        const st = fs.statSync(p)
        if (!st.isFile() || st.size === 0 || st.size > 65536 || st.mtimeMs < sinceMs) continue
        const buf = fs.readFileSync(p)
        if (buf.includes(0)) continue
        const text = buf.toString('utf8')
        const m = text.match(FLAG_SHAPE)
        if (m) {
          hits.push({ file: p, text: m[1] ?? m[0] })
          continue
        }
        // JSON 字段：可能有多个候选，优先收可打印的那些（乱码候选由 verifier 排除）。
        const unescape = (s) => s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        for (const mm of text.matchAll(new RegExp(FIELD_SHAPE.source, 'gi'))) {
          const value = unescape(mm[1])
          if (!/^[\x20-\x7e]{8,200}$/.test(value)) continue
          hits.push({ file: p, text: value })
        }
      } catch {
        /* 跳过不可读文件 */
      }
    }
  }
  walk(root, 0)
  return hits
}

/** 只接受工作区或题目目录内、文本形态、≤2KB 的候选文件；返回工作区相对路径或 null。 */
function resolveCandidateFile(bases, rel) {
  const raw = str(rel)
  if (!raw) return null
  for (const base of bases) {
    if (!base) continue
    const root = path.resolve(base)
    const abs = path.resolve(root, raw)
    if (abs !== root && !abs.startsWith(root + path.sep)) continue
    let buf
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size === 0 || st.size > 2048) continue
      buf = fs.readFileSync(abs)
    } catch {
      continue
    }
    // 候选应是可读文本（flag 一行），二进制产物重新交回 worker 处理。
    if (buf.includes(0)) continue
    const text = buf.toString('utf8').trim()
    if (!text || text.length > 512) continue
    if (!/^[\x20-\x7e\u00a0-\uffff\r\n]+$/.test(text)) continue
    return path.relative(path.resolve(bases[0]), abs).split(path.sep).join('/')
  }
  return null
}

/** 阶段产物：taskDir 或题目目录下的文件，返回摘要供下一阶段直接引用。 */
function resolveArtifact(bases, name) {
  const raw = str(name)
  if (!raw) return null
  for (const base of bases) {
    if (!base) continue
    const root = path.resolve(base)
    const abs = path.resolve(root, raw)
    if (abs !== root && !abs.startsWith(root + path.sep)) continue
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size === 0 || st.size > 64 * 1024) continue
      const buf = fs.readFileSync(abs)
      const head = buf.includes(0) ? `(${st.size} B，二进制)` : buf.toString('utf8').trim().slice(0, 600)
      return { abs, path: abs.split(path.sep).join('/'), head, bytes: st.size }
    } catch {
      continue
    }
  }
  return null
}

/** 按 dependsOn 排串行顺序；有环/引用不存在时返回 null（退回并行模式）。 */
// 串行阶段：单段墙钟秒数 = min(1200, 该段声明的 maxSeconds || 全局 stagedTurnSec)。
export function stageSeconds(task, stagedTurnSec) {
  const want = Number(task?.maxSeconds) > 0 ? Number(task.maxSeconds) : Number(stagedTurnSec) || 600
  return Math.min(1200, Math.max(60, want))
}

export function orderStages(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const done = new Set()
  const order = []
  let guard = tasks.length * tasks.length + 4
  while (order.length < tasks.length && guard-- > 0) {
    const ready = tasks.filter((t) => !done.has(t.id) && (t.dependsOn ?? []).every((d) => done.has(d)))
    if (!ready.length) return null
    for (const t of ready) {
      done.add(t.id)
      order.push(t)
    }
  }
  // 依赖了不存在的 id：直接判非法，交给并行路径，避免静默丢任务。
  for (const t of tasks) for (const d of t.dependsOn ?? []) if (!byId.has(d)) return null
  return order.length === tasks.length ? order : null
}

function normalizeVerdict(raw) {
  const verdict = ['pass', 'needs_revision', 'reject'].includes(raw?.verdict) ? raw.verdict : 'reject'
  return {
    candidate: str(raw?.candidate),
    verdict,
    reasons: arr(raw?.reasons).map((x) => str(x)).filter(Boolean),
    replay: { cmd: str(raw?.replay?.cmd), exit: Number(raw?.replay?.exit) || 0 },
    checkedAt: str(raw?.checkedAt, nowIso()),
  }
}

/** 固定并发池：某一项抛错不影响其他项，结果按输入顺序返回。 */
async function pool(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        try {
          results[index] = { ok: true, value: await worker(items[index], index) }
        } catch (error) {
          results[index] = { ok: false, error }
        }
      }
    }),
  )
  return results
}

export async function orchestrate(options) {
  const {
    workspace,
    challengeDir,
    outRoot,
    budgetConfig,
    submitPolicy = {},
    bridgeFactory,
    model = '',
    provider = '',
    dryRun = false,
    logger = console.log,
    signal = null,
    taskText = '',
    hintText = '',
    priorSpent = 0,
  deadlineMs = 0,
  } = options

  const challengeName = path.basename(challengeDir)
  // 串行阶段：每段 10 分钟硬超时、必须落盘；预算按阶段预留。
  const staged = Boolean(budgetConfig.staged)
  const stagedTurnSec = Math.max(60, Number(budgetConfig.stagedTurnSec) || 600)
  const roleCap = (role) =>
    Number(role === 'supervisor' ? budgetConfig.supervisorTokens : role === 'verifier' ? budgetConfig.verifierTokens : budgetConfig.workerTokens) || 0
  const runId = makeRunId()
  const runDir = path.join(outRoot, runId)
  const turnsDir = path.join(runDir, 'turns')
  const eventsFile = path.join(runDir, 'events.jsonl')
  fs.mkdirSync(turnsDir, { recursive: true })

  // 单题预算：先扣掉这道题历史上已经花掉的（costs.jsonl / 历史 runs），再与本 run 上限取小。
  const { budget: runBudget, remaining } = effectiveRunBudget({
    perRunTokens: budgetConfig.perRunTokens,
    perChallengeTokens: budgetConfig.perChallengeTokens,
    priorSpent,
  })

  const ledger = new Ledger({
    budget: runBudget,
    convergeAt: budgetConfig.convergeAt,
    file: path.join(runDir, 'ledger.json'),
    log: (line) => logger(line),
    priorSpent,
  })

  const state = {
    runId,
    challenge: challengeName,
    challengeDir,
    task: taskText,
    status: 'init',
    step: '',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    turns: 0,
    tasks: [],
    findings: [],
  }

  let seq = 0
  const bridges = []
  // finish() 在 plan 之前定义，用这个可变对象汇报「本轮启用了哪些机制」。
  const runFlags = { staged: false, probes: 0 }

  const appendEvent = (type, data = {}) => {
    try {
      fs.appendFileSync(eventsFile, `${JSON.stringify({ ts: nowIso(), type, ...data })}\n`)
    } catch {
      /* ignore */
    }
  }

  const saveState = (patch = {}) => {
    Object.assign(state, patch, { updatedAt: nowIso() })
    writeJson(path.join(runDir, 'state.json'), state)
  }

  const newBridge = () => {
    const bridge = bridgeFactory()
    bridges.push(bridge)
    return bridge
  }

  /** 一轮对话：记账、落盘、抛错（recon 自己兜底）。 */
  const turn = async (bridge, sessionId, prompt, { role, label, timeoutMs, stagesLeft = 1 }) => {
    ledger.check(role)
    // 起跑前预留：按「剩余 / 剩余阶段数」给这一轮设上限，避免最后一个阶段把预算吃光。
    const adm = admitTurn({
      remaining: ledger.remainingRun(),
      stagesLeft,
      roleCap: roleCap(role),
      reserveShare: Number(budgetConfig.reserveShare ?? 0.2),
    })
    if (!adm.ok) {
      throw new BudgetStop(
        `准入拒绝：${role}/${label} 起跑前剩余 ${adm.remaining} tok，cap=${adm.cap}（预算已不足以覆盖后续 ${adm.stagesLeft} 段）`,
      )
    }
    appendEvent('turn/admit', { role, label, cap: adm.cap, reserve: adm.reserve, stagesLeft: adm.stagesLeft, remaining: adm.remaining, secs: Math.round(timeoutMs / 1000) })
    const index = (seq += 1)
    appendEvent('turn/start', { role, label, seq: index })
    saveState({ step: `${role}:${label}` })
    const result = await bridge.prompt(sessionId, prompt, { timeoutMs, signal: signal ?? undefined })
    const usage = result.usage ?? {}
    const rawTokens =
      Number(usage.totalTokens) ||
      Number(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? 0) +
        Number(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? 0)
    // 缓存读按 cacheWeight 折算：totalTokens 里缓存读占大头，全额计入会让预算形同虚设。
    const cacheRead = Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0)
    const cacheWeight = Number(budgetConfig.cacheWeight ?? 0.1)
    const measured = rawTokens > 0 ? Math.max(1, Math.round(rawTokens - cacheRead + cacheRead * cacheWeight)) : 0
    const toolChars = Number(result.toolChars) || 0
    if (measured > 0) ledger.add({ role, label, tokens: measured, raw: rawTokens })
    else
      ledger.addEstimate({
        role,
        label,
        prompt,
        reply: result.text,
        toolChars,
        multiplier: Number(budgetConfig.estimateMultiplier) || 1.5,
      })
    appendEvent('turn/end', {
      role,
      label,
      seq: index,
      error: result.error ?? null,
      measuredTokens: measured || null,
      rawTokens: rawTokens || null,
      toolChars,
      usage: result.usage ?? null,
    })
    // 事后对账：单轮远超准入上限说明并发/提示词把预算打穿了，记一笔供复盘。
    if (measured > adm.cap * 1.5) {
      appendEvent('turn/over-cap', { role, label, measured, cap: adm.cap, ratio: Number((measured / Math.max(1, adm.cap)).toFixed(2)) })
    }
    // 单轮就可能烧穿预算；落账后立刻校验，超了就让整条流水线停在 partial。
    ledger.check(role)
    const file = path.join(turnsDir, `${String(index).padStart(2, '0')}-${role}-${label}.md`)
    fs.writeFileSync(
      file,
      `# ${role} / ${label}\n\n- at: ${nowIso()}\n- session: ${sessionId}\n- tokens: ${measured || 'estimated'}\n\n## prompt\n\n${prompt}\n\n## reply\n\n${result.text}\n${result.error ? `\n## error\n\n${result.error}\n` : ''}`,
    )
    state.turns = index
    if (result.error) {
      if (FATAL_RE.test(String(result.error))) throw new FatalStop(`${role}/${label}: ${result.error}`)
      throw new Error(`${role}/${label}: ${result.error}`)
    }
    return result
  }

  const finish = (status, extra = {}) => {
    const verdictFile = path.join(runDir, 'verdict.json')
    const verdict = extra.verdict ?? { verdict: 'reject', candidate: '', reasons: [extra.reason ?? 'not verified'] }
    writeJson(verdictFile, verdict)
    const submission = {
      runId,
      challenge: challengeName,
      candidate: verdict.candidate || '',
      candidateFile: String(verdict.candidate || '').startsWith('file:') ? String(verdict.candidate).slice(5) : '',
      verdict: verdict.verdict,
      mode: submitPolicy.mode ?? 'manual',
      confirmed: false,
      note: 'P0 默认人工确认；提交前核对格式、来源、唯一性。',
      at: nowIso(),
    }
    if (submission.candidate) writeJson(path.join(runDir, 'submissions', 'pending.json'), submission)
    saveState({ status, finishedAt: nowIso() })

    const summary = {
      runId,
      runDir,
      challenge: challengeName,
      status,
      verdict,
      spent: ledger.total,
      spentTotal: ledger.effectiveTotal,
      priorSpent: ledger.prior,
      estimated: ledger.estimatedTotal,
      budget: ledger.budget,
      turns: state.turns,
      staged: Boolean(runFlags.staged),
      probes: runFlags.probes,
      dryRun,
    }
    writeJson(path.join(runDir, 'result.json'), summary)
    writeReport(runDir, { state, surface: extra.surface, findings: extra.findings ?? [], verdict, ledger, submission, dryRun })
    return { ...summary, exitCode: status === 'verified' ? 0 : status === 'config-error' ? 3 : 2 }
  }

  const meta = {
    runId,
    challenge: challengeName,
    challengeDir,
    task: taskText,
    model,
    provider,
    dryRun,
    budget: budgetConfig,
    submitPolicy,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    startedAt: state.startedAt,
  }
  writeJson(path.join(runDir, 'meta.json'), meta)
  saveState({ status: 'running' })
  appendEvent('run/start', { runId, challenge: challengeName, dryRun })

  if (runBudget <= 0) {
    const reason = `单题预算已用尽：历史 ${priorSpent} tok / 上限 ${budgetConfig.perChallengeTokens} tok（remaining=${remaining ?? 0}）`
    appendEvent('run/budget-exhausted', { priorSpent, perChallengeTokens: budgetConfig.perChallengeTokens })
    return finish('config-error', {
      reason,
      verdict: { candidate: '', verdict: 'reject', reasons: [reason], replay: { cmd: '', exit: 0 }, checkedAt: nowIso() },
    })
  }

  try {
    // ---------- recon ----------
    const files = listFiles(challengeDir).filter((f) => !/^(super|runs|turns|verify)([\\/]|$)/.test(f.path))
    // 预置探针：题目目录里已调好的解析脚本，worker 直接调用而不是每轮重写。
    const probeRows = findProbes(challengeDir)
    const probesText = renderProbes(probeRows)
    runFlags.probes = probeRows.length
    if (probeRows.length) appendEvent('probes/found', { count: probeRows.length, files: probeRows.map((p) => p.path) })
    const supervisor = newBridge()
    const reconPrompt = composeRecon({
      challengeName,
      challengeDir,
      files: renderFileList(files),
      budget: budgetConfig.perRunTokens,
      // 题目模式下 --notes 当「本轮任务指令」用，否则 recon 会把它当背景而忽略。
      task: taskText || (hintText ? hintText : ''),
      hint: hintText,
      staged,
    })

    let surface
    try {
      const reply = await turn(supervisor, `supervisor-${runId}`, reconPrompt, {
        role: 'supervisor',
        label: 'recon',
        timeoutMs: (deadlineMs > 0 ? Math.min(budgetConfig.turnWallClockSec, Math.max(90, Math.floor((deadlineMs - Date.now()) / 1000) - 60)) : budgetConfig.turnWallClockSec) * 1000,
        stagesLeft: 2,
      })
      const raw = extractJson(reply.text)
      if (!raw) throw new Error('recon 回复里没有 JSON')
      surface = normalizeSurface(raw, files)
      appendEvent('recon/ok', { category: surface.category, difficulty: surface.difficulty, tasks: surface.hypotheses.length })
    } catch (error) {
      if (error instanceof BudgetStop || error instanceof FatalStop) throw error
      surface = fallbackSurface(files)
      appendEvent('recon/fallback', { reason: String(error?.message ?? error) })
    }
    if (!surface.hypotheses.length) surface = fallbackSurface(files)

    const difficultyCap = DIFFICULTY_WORKERS[surface.difficulty] ?? 1
    const workerCap = budgetConfig.workerOverride ? (budgetConfig.workerMax ?? 2) : Math.min(budgetConfig.workerMax ?? 2, difficultyCap)
    const workerCount = Math.max(1, Math.min(workerCap, surface.hypotheses.length))
    const plan = {
      surface,
      route: surface.difficulty,
      staged,
      probes: probeRows.map((p) => p.path),
      workerCount,
      tasks: surface.hypotheses.map((task, index) => ({
        ...task,
        id: task.id || `t${index + 1}`,
        worker: `w${(index % workerCount) + 1}`,
        round: 1,
      })),
    }
    // 串行模式：任务必须成链；否则退回并行，不让错误计划把整轮卡死。
    if (staged && !orderStages(plan.tasks)) {
      plan.staged = false
      appendEvent('plan/staged-invalid', { reason: 'dependsOn 非法（成环或引用不存在），退回并行' })
    }
    runFlags.staged = Boolean(plan.staged)
    writeJson(path.join(runDir, 'plan.json'), plan)
    saveState({ status: 'solving', tasks: plan.tasks, staged: Boolean(plan.staged), probes: probeRows.length })
    appendEvent('plan/ready', { route: plan.route, tasks: plan.tasks.length, workerCount })

    // ---------- scaffold（可选）：先建可复用脚手架，避免每个 worker 从零重写解析器 ----------
    let scaffoldText = ''
    if (budgetConfig.scaffold) {
      const scaffoldDir = path.join(runDir, 'scaffold')
      // 脚手架只是铺路，不允许吃掉整轮预算：最多 10 分钟。
      fs.mkdirSync(scaffoldDir, { recursive: true })
      try {
        const reply = await turn(supervisor, `supervisor-${runId}`, composeScaffold({
          challengeName,
          challengeDir,
          files: renderFileList(files),
          notes: surface.notes,
          entry: surface.entry,
          scaffoldDir,
          budget: budgetConfig.perRunTokens,
        }), { role: 'supervisor', label: 'scaffold', timeoutMs: Math.min(budgetConfig.turnWallClockSec, 600) * 1000, stagesLeft: 2 })
        fs.writeFileSync(path.join(scaffoldDir, 'README.md'), `${reply.text}\n`)
        const built = listFiles(scaffoldDir)
        scaffoldText = `${renderFileList(built)}\n\n${reply.text.slice(0, 1200)}`
        appendEvent('scaffold/ready', { files: built.length })
      } catch (error) {
        if (error instanceof BudgetStop || error instanceof FatalStop) throw error
        appendEvent('scaffold/failed', { reason: String(error?.message ?? error).slice(0, 300) })
        scaffoldText = ''
      }
    }

    // ---------- solve ----------
    const findings = []
    let tasks = plan.tasks
    const workerBridges = []
    // 每个阶段落盘的产物（taskId → {path, head}），后续阶段直接引用，不必重新推导。
    const artifacts = new Map()

    const solveTask = async (task, { round = 1, slot = 0, stagesLeft = 1 } = {}) => {
      // 一个 slot 一个进程，跨 task/round 复用；并发池保证同一 slot 不会被两个 task 同时占用。
      workerBridges[slot] ??= newBridge()
      const bridge = workerBridges[slot]
      const sessionId = `worker-${slot}-${runId}-${task.id}-r${round}`
      const taskDir = ensureTaskDir(path.join(runDir, 'super'), task.id)
      const depArtifacts = (task.dependsOn ?? []).map((id) => artifacts.get(id)).filter(Boolean)
      const prompt = composeWorker({
        task,
        surface,
        challengeName,
        challengeDir,
        taskDir: taskDir.abs,
        workspace,
        budget: budgetConfig.workerTokens,
        scaffold: scaffoldText,
        hint: hintText,
        probes: probesText,
        depArtifacts,
        staged: Boolean(plan.staged),
      })
      const hard = plan.route === 'hard' || surface.difficulty === 'hard'
      // 串行阶段：单段墙钟 = min(配置上限, 该段声明的 maxSeconds, 1200)。
      const stageSec = plan.staged ? stageSeconds(task, stagedTurnSec) : 0
      let timeoutSec = plan.staged ? stageSec : hard ? budgetConfig.turnWallClockSec * 2 : budgetConfig.turnWallClockSec
      // 整题墙钟：每段按剩余时间收缩，保证整轮在 --max-seconds 内收尾，而不是被 bench 直接砍掉。
      if (deadlineMs > 0) {
        const left = Math.floor((deadlineMs - Date.now()) / 1000) - 25
        if (left < 60) throw new BudgetStop(`整题墙钟用尽（剩余 ${left}s），停止本段`)
        // 按剩余段数分时间：当前段多给 30% 余量（探针/重组最费时），后面段靠剩余时间滚动。
        const share = Math.max(240, Math.floor((left / Math.max(1, stagesLeft)) * 1.3))
        timeoutSec = Math.min(timeoutSec, left, share)
      }
      const reply = await turn(bridge, sessionId, prompt, {
        role: 'worker',
        label: task.id,
        timeoutMs: timeoutSec * 1000,
        stagesLeft,
      })
      const raw = extractJson(reply.text)
      if (!raw) throw new Error(`worker ${task.id} 回复里没有 JSON`)
      const finding = normalizeFinding(raw, task.id)
      // 空结论/占位（"pending"/"run"）不算产出：worker 常见于把 next 当命令回。
      if (!finding.candidate && !finding.candidateFile && (!finding.finding || /^(pending|run|tbd|todo|unknown)$/i.test(finding.finding.trim()))) {
        throw new Error(`worker ${task.id} 没有给出实际结论（finding=${JSON.stringify(finding.finding)}）`)
      }
      const candidateFile = resolveCandidateFile([workspace, challengeDir, path.join(runDir, 'super')], finding.candidateFile)
      if (candidateFile) {
        finding.candidateFile = candidateFile
        if (!finding.candidate) finding.candidate = `file:${candidateFile}`
      } else {
        finding.candidateFile = ''
      }
      // 串行阶段：这一阶段必须落盘，否则后续阶段没有输入（也不该继续烧钱猜）。
      if (plan.staged && task.artifact) {
        // 产物名不匹配时认领本段新写的 JSON/TXT：worker 常把 artifact 叫成 t2_boundary.json、candidates.txt 之类。
        let art = adoptArtifact(taskDir.abs, task.artifact)
        if (art) {
          artifacts.set(task.id, art)
          appendEvent('stage/artifact', { taskId: task.id, artifact: task.artifact, bytes: art.bytes ?? art.head.length, source: art.adoptedFrom ?? '' })
        } else {
          finding.artifactMissing = task.artifact
          appendEvent('stage/missing', { taskId: task.id, artifact: task.artifact })
        }
      }
      writeJson(path.join(taskDir.abs, 'finding.json'), finding)
      appendEvent('task/finding', {
        taskId: task.id,
        confidence: finding.confidence,
        candidate: Boolean(finding.candidate),
        artifact: Boolean(finding.artifactMissing ? false : artifacts.get(task.id)),
        evidence: finding.evidence.length,
      })
      return finding
    }

    const runRound = async (round) => {
      const results = await pool(tasks, round === 1 ? workerCount : 1, async (task, index) => {
        if (ledger.shouldConverge() && index > 0) return { skipped: 'converged', taskId: task.id }
        const slot = index % Math.max(1, workerCount)
        return solveTask(task, { round, slot, stagesLeft: Math.max(1, tasks.length - index) + 1 })
      })

      for (const entry of results) {
        if (!entry) continue
        if (entry.ok) {
          if (entry.value && !entry.value.skipped) findings.push(entry.value)
        } else if (entry.error instanceof BudgetStop || entry.error instanceof FatalStop) {
          // 预算闸必须终止整条流水线，不能被并发池当成单个任务失败吞掉。
          throw entry.error
        } else {
          appendEvent('task/error', { message: String(entry.error?.message ?? entry.error) })
        }
      }
    }

    // 串行阶段：按 dependsOn 一段一段跑，每段 10 分钟硬超时、必须落盘；前置没产出就跳过后续。
    const runStaged = async (order) => {
      const blocked = new Set()
      for (let i = 0; i < order.length; i += 1) {
        const task = order[i]
        if ((task.dependsOn ?? []).some((d) => blocked.has(d))) {
          blocked.add(task.id)
          appendEvent('stage/skipped', { taskId: task.id, reason: '前置阶段没有产出，后续不启动' })
          continue
        }
        try {
          const finding = await solveTask(task, { slot: 0, stagesLeft: order.length - i + 1 })
          if (finding.artifactMissing) {
            blocked.add(task.id)
            appendEvent('stage/blocked', { taskId: task.id, artifact: finding.artifactMissing })
          } else {
            findings.push(finding)
          }
        } catch (error) {
          if (error instanceof BudgetStop || error instanceof FatalStop) throw error
          appendEvent('task/error', { taskId: task.id, message: String(error?.message ?? error) })
          // 超时/格式错但产物已经落盘 → 当作部分成功，让链继续（否则整轮白烧）。
          let recovered = false
          if (plan.staged && task.artifact) {
            const td = ensureTaskDir(path.join(runDir, 'super'), task.id)
            const art = adoptArtifact(td.abs, task.artifact)
            if (art) {
              artifacts.set(task.id, art)
              findings.push({
                taskId: task.id,
                confidence: 0.2,
                finding: `本段超时/出错，但产物 ${task.artifact} 已落盘，按已有产物继续`,
                artifact: true,
                evidence: [],
              })
              appendEvent('stage/adopt-partial', { taskId: task.id, artifact: task.artifact, source: art.adoptedFrom ?? '' })
              recovered = true
            }
          }
          if (!recovered) blocked.add(task.id)
        }
        saveState({ status: 'solving', findings })
      }
    }

    if (plan.staged) {
      // 串行执行时强制成链：前一段失败/缺产物，后面全部跳过（避免并列段在邻居超时后继续烧钱）。
      const order = orderStages(plan.tasks)
      if (order) {
        for (let i = 1; i < order.length; i += 1) order[i].dependsOn = [order[i - 1].id]
        appendEvent('plan/chained', { order: order.map((t) => t.id) })
      }
      await runStaged(order)
    }
    else await runRound(1)
    saveState({ status: 'solving', findings })

    // 一轮全弱且预算还够 → 挑最弱的一条回炉一次
    const strongest = findings.reduce((max, f) => Math.max(max, f.confidence), 0)
    const rounds = Math.max(1, Math.min(2, Number(budgetConfig.maxRounds) || 2))
    if (!plan.staged && rounds > 1 && strongest < 0.5 && findings.length && !ledger.shouldConverge()) {
      const weakest = findings.reduce((min, f) => (f.confidence < min.confidence ? f : min), findings[0])
      const source = plan.tasks.find((t) => t.id === weakest.taskId) ?? plan.tasks[0]
      tasks = [
        {
          ...source,
          round: 2,
          goal: `${source.goal}（回炉：上一轮置信度 ${weakest.confidence}）`,
        },
      ]
      appendEvent('plan/retry', { taskId: source.id, reason: 'low-confidence' })
      await runRound(2)
    }

    // ---------- verify ----------
    saveState({ status: 'verifying', findings })
    // worker 把答案当「中间产物」是常态：没给候选就按 flag 形态兜底扫一遍本轮产物。
    if (!findings.some((f) => f.candidateFile)) {
      const since = (Date.parse(state.startedAt) || 0) - 5000
      const hits = [
        ...scanCandidateFiles(path.join(runDir, 'super'), since),
        ...scanCandidateFiles(path.join(challengeDir, 'super'), since),
      ].filter((h) => !/(^|[\\/])(finding\.json|_candidate\.txt)$/.test(h.file))
      fs.mkdirSync(path.join(runDir, 'super'), { recursive: true })
      // runDir 在部分场景（测试/自定义 out）会落在工作区外；此时退回题目目录。
      let target = path.join(runDir, 'super', '_candidate.txt')
      let rel = path.relative(workspace, target).split(path.sep).join('/')
      if (rel.startsWith('..')) {
        target = path.join(challengeDir, 'super', '_candidate.txt')
        rel = path.relative(workspace, target).split(path.sep).join('/')
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
        if (hits.length && !rel.startsWith('..')) {
        fs.writeFileSync(target, `${hits[0].text}\n`)
        findings.push({
          taskId: 'scan',
          hypothesis: '兜底扫描题目目录下本轮新写的文本文件',
          finding: `命中 ${path.relative(challengeDir, hits[0].file)}`,
          candidate: `file:${rel}`,
          candidateFile: rel,
          evidence: [{ path: path.relative(challengeDir, hits[0].file), line: 0, cmd: '' }],
          confidence: 0.6,
          next: '',
        })
        appendEvent('candidate/scan', { file: path.relative(challengeDir, hits[0].file), hits: hits.length })
      }
    }
    const ordered = [...findings].sort((a, b) => b.confidence - a.confidence)
    const candidateFinding = ordered.find((f) => f.candidate)
    let verdict
    if (!candidateFinding) {
      verdict = { candidate: '', verdict: 'reject', reasons: ['没有 worker 产出候选结论'], replay: { cmd: '', exit: 0 }, checkedAt: nowIso() }
      appendEvent('verify/skip', { reason: 'no candidate' })
    } else {
      const prompt = composeVerifier({
        challengeName,
        challengeDir,
        findings: ordered,
        candidate: candidateFinding.candidate,
        candidateFiles: ordered.filter((f) => f.candidateFile).map((f) => f.candidateFile),
      })
      try {
        const reply = await turn(supervisor, `verifier-${runId}`, prompt, {
          role: 'verifier',
          label: 'verify',
          timeoutMs: budgetConfig.turnWallClockSec * 1000,
          stagesLeft: 1,
        })
        const raw = extractJson(reply.text)
        verdict = raw ? normalizeVerdict(raw) : { candidate: '', verdict: 'reject', reasons: ['verifier 未返回 JSON'], replay: { cmd: '', exit: 0 }, checkedAt: nowIso() }
        // 候选以文件为准：verifier 复述的文本不回填到 verdict，避免 flag 落进对话产物。
        if (candidateFinding.candidateFile) verdict.candidate = `file:${candidateFinding.candidateFile}`
        else if (!verdict.candidate) verdict.candidate = candidateFinding.candidate
      } catch (error) {
        if (error instanceof BudgetStop || error instanceof FatalStop) throw error
        verdict = {
          candidate: candidateFinding.candidate,
          verdict: 'needs_revision',
          reasons: [`verifier 失败：${String(error?.message ?? error)}`],
          replay: { cmd: '', exit: 0 },
          checkedAt: nowIso(),
        }
      }
    }
    appendEvent('verify/result', { verdict: verdict.verdict, reasons: verdict.reasons.length })

    const status = verdict.verdict === 'pass' ? 'verified' : candidateFinding ? 'partial' : 'failed'
    return finish(status, { surface, findings: ordered, verdict })
  } catch (error) {
    if (error instanceof BudgetStop) {
      ledger.stop(error.reason)
      appendEvent('run/budget-stop', { reason: error.reason, spent: ledger.total })
      return finish('partial', {
        reason: `预算闸触发：${error.reason}`,
        verdict: {
          candidate: '',
          verdict: 'reject',
          reasons: [`预算闸触发：${error.reason}`, `已用 ${ledger.total}/${ledger.budget} tok`],
          replay: { cmd: '', exit: 0 },
          checkedAt: nowIso(),
        },
      })
    }
    if (error instanceof FatalStop) {
      appendEvent('run/fatal', { message: String(error.message) })
      return finish('config-error', {
        reason: String(error.message),
        verdict: {
          candidate: '',
          verdict: 'reject',
          reasons: [String(error.message), '账号/适配器不可用，已中止'],
          replay: { cmd: '', exit: 0 },
          checkedAt: nowIso(),
        },
      })
    }
    appendEvent('run/error', { message: String(error?.message ?? error) })
    return finish('failed', {
      reason: String(error?.message ?? error),
      verdict: { candidate: '', verdict: 'reject', reasons: [String(error?.message ?? error)], replay: { cmd: '', exit: 0 }, checkedAt: nowIso() },
    })
  } finally {
    for (const bridge of bridges) {
      try {
        await bridge.stop()
      } catch {}
    }
  }
}

function writeReport(runDir, { state, surface, findings, verdict, ledger, submission, dryRun }) {
  const lines = []
  lines.push(`# Run ${state.runId}`)
  lines.push('')
  lines.push(`- 题目：${state.challenge}`)
  if (state.task) lines.push(`- 工单：${state.task.split('\n')[0].slice(0, 160)}`)
  lines.push(`- 状态：${state.status}`)
  lines.push(`- 模式：${dryRun ? 'dry-run（mock，不烧 token）' : 'live'}`)
  lines.push(`- 用量：${ledger.effectiveTotal} tok（其中估算 ${ledger.estimatedTotal}），预算 ${ledger.budget}${ledger.prior ? `，本题历史 ${ledger.prior}` : ''}`)
  lines.push(`- 轮次：${state.turns}`)
  lines.push(`- 机制：${state.staged ? '串行阶段（依赖 + 落盘校验 + 10 min/段）' : '并行扇出'}；预置探针 ${state.probes ?? 0} 个`)
  lines.push('')
  if (surface) {
    lines.push('## 侦察')
    lines.push('')
    lines.push(`- 类别：${surface.category} / 难度：${surface.difficulty}`)
    lines.push(`- 入口：${surface.entry}`)
    if (surface.notes) lines.push(`- 备注：${surface.notes}`)
    lines.push('')
  }
  lines.push('## 任务与结论')
  lines.push('')
  if (!findings.length) lines.push('（无）')
  for (const f of findings) {
    lines.push(`### ${f.taskId} · 置信度 ${f.confidence}`)
    lines.push('')
    lines.push(`- 假设：${f.hypothesis || '—'}`)
    lines.push(`- 结论：${f.finding || '—'}`)
    if (f.candidate) lines.push(`- 候选：${f.candidate}`)
    if (f.evidence.length) {
      lines.push('- 证据：')
      for (const e of f.evidence) lines.push(`  - \`${e.path}${e.line ? `:${e.line}` : ''}\` :: ${e.cmd || '（无命令）'}`)
    }
    lines.push('')
  }
  lines.push('## 复核')
  lines.push('')
  lines.push(`- 判定：**${verdict.verdict}**`)
  for (const reason of verdict.reasons ?? []) lines.push(`- ${reason}`)
  if (verdict.replay?.cmd) lines.push(`- 重跑：\`${verdict.replay.cmd}\`（exit ${verdict.replay.exit}）`)
  lines.push('')
  lines.push('## 提交')
  lines.push('')
  if (verdict.candidate) {
    lines.push(`- 候选 flag 已写入 \`submissions/pending.json\`，模式：${submission.mode}（人工确认）`)
    lines.push('- 确认后运行：`node bin/eva-submit.mjs --run ' + state.runId + ' --challenge <challenge_id> --ground <practice_ground_id> --confirm`')
  } else {
    lines.push('- 无候选，未进入提交门禁。')
  }
  lines.push('')
  lines.push('## 账本')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(ledger.snapshot().entries.slice(-12), null, 2))
  lines.push('```')
  lines.push('')
  fs.writeFileSync(path.join(runDir, 'report.md'), `${lines.join('\n')}\n`)
}
