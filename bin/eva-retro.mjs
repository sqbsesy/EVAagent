#!/usr/bin/env node
// D6 复盘自动化：把一个 run（或一场 race）压成复盘卡，并把「短结论」写进 facts。
// 原则：卡是给人看的（可长一点也只是结构字段），写进 facts 的只有一两句，不搬长文。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--run') out.run = argv[++i]
    else if (a === '--race') out.race = argv[++i]
    else if (a === '--workspace') out.workspace = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-facts') out.noFacts = true
    else if (a === '--help' || a === '-h') out.help = true
    else out._.push(a)
  }
  return out
}

function usage() {
  console.log(`eva-retro — 复盘卡 + facts 写入

  --run <dir>        单个 run 目录（含 result.json / events.jsonl）
  --race <dir>       一场 race 目录（含 pool.json / events.jsonl）
  --workspace <dir>  工作区根（默认自动发现，facts 写这里）
  --out <file>       卡片输出路径（默认 <repo>/retro/<id>.md）
  --dry-run          只打印，不写 facts、不落盘
  --no-facts         只出卡，不写 facts
`)
}

function findWorkspace(start) {
  let dir = path.resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '_tools', 'eva', 'toolgate.mjs'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const readJson = (p, fb = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fb
  }
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function minutesBetween(events) {
  if (events.length < 2) return null
  const t0 = Date.parse(events[0].ts)
  const t1 = Date.parse(events[events.length - 1].ts)
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null
  return Math.round((t1 - t0) / 600) / 100
}

function classifyFamily(reasons = [], status = '') {
  const t = reasons.join(' | ').toLowerCase()
  if (status === 'config-error') return 'env-unavailable'
  if (/timed out|墙钟|timeout/.test(t)) return 'timeout'
  if (/没有 worker 产出候选|no candidate|无候选/.test(t)) return 'no-candidate'
  if (/budget|预算/.test(t)) return 'budget-exhausted'
  if (/invalid|格式|schema/.test(t)) return 'format-invalid'
  return status === 'verified' ? 'solved' : 'unknown'
}

/** 单个 run 的卡。 */
export function cardFromRun(runDir) {
  const meta = readJson(path.join(runDir, 'meta.json'), {}) ?? {}
  const result = readJson(path.join(runDir, 'result.json'), {}) ?? {}
  const events = readEvents(path.join(runDir, 'events.jsonl'))
  const turnEnds = events.filter((e) => e.type === 'turn/end')
  const spent = Number(result.spentTotal ?? result.spent ?? turnEnds.reduce((a, e) => a + (Number(e.measuredTokens) || 0), 0))
  const minutes = minutesBetween(events)
  const plan = readJson(path.join(runDir, 'plan.json'), {}) ?? {}
  const surface = plan.surface ?? meta.surface ?? {}
  const reasons = Array.isArray(result.reasons)
    ? result.reasons
    : (Array.isArray(result.verdict?.reasons) ? result.verdict.reasons : [])
  const family = classifyFamily(reasons, result.status)
  const failedTasks = events.filter((e) => e.type === 'task/error').map((e) => e.taskId ?? e.role).filter(Boolean)
  return {
    kind: 'run',
    id: result.runId ?? path.basename(runDir),
    dir: runDir,
    challenge: meta.challenge ?? path.basename(runDir),
    category: surface.category ?? null,
    difficulty: surface.difficulty ?? null,
    status: result.status ?? 'unknown',
    verdict: result.verdict?.verdict ?? null,
    outcome: result.status === 'verified' ? 'solved' : (result.status ?? 'unknown'),
    failureFamily: family,
    minutes,
    spentTokens: spent,
    estimated: result.estimated ?? null,
    staged: Boolean(meta.staged ?? result.staged),
    skills: Array.isArray(meta.skills) ? meta.skills : [],
    failedTasks,
    reasons: reasons.slice(0, 3),
    candidateFile: result.submission?.candidateFile ?? null,
    report: path.join(runDir, 'report.md'),
  }
}

/** 一场 race 的卡：汇总每题状态 + 失败分类 + 技能。 */
export function cardFromRace(raceDir) {
  const pool = readJson(path.join(raceDir, 'pool.json'), { challenges: [] }) ?? { challenges: [] }
  const events = readEvents(path.join(raceDir, 'events.jsonl'))
  const dispatch = events.filter((e) => e.type === 'race/dispatch')
  const failures = events.filter((e) => e.type === 'failure/classified')
  const abandoned = events.filter((e) => e.type === 'race/abandoned')
  const skills = [...new Set(dispatch.flatMap((d) => d.skills ?? []))]
  const minutes = minutesBetween(events)
  const spent = pool.challenges.reduce((a, c) => a + (Number(c.spent) || 0), 0)
  const solved = pool.challenges.filter((c) => c.status === 'done' || c.status === 'waiting_confirm')
  const byClass = {}
  for (const f of failures) byClass[f.class] = (byClass[f.class] ?? 0) + 1
  return {
    kind: 'race',
    id: path.basename(raceDir),
    dir: raceDir,
    challenges: pool.challenges.length,
    solved: solved.length,
    abandoned: abandoned.length,
    minutes,
    spentTokens: spent,
    skills,
    failureClasses: byClass,
    perChallenge: pool.challenges.map((c) => ({ id: c.id, status: c.status, spent: c.spent ?? 0, note: c.note ?? '' })),
    blocked: pool.challenges.filter((c) => c.status === 'abandoned').map((c) => c.id),
  }
}

function shortClaim(card) {
  const cat = card.category ? `${card.category}/` : ''
  const diff = card.difficulty ? `${card.difficulty} ` : ''
  const cost = `${Math.round(card.spentTokens / 1000)}k tok`
  const mins = card.minutes ? `${card.minutes} min` : '时长未知'
  if (card.kind === 'race') {
    const cls = Object.entries(card.failureClasses).map(([k, v]) => `${k}×${v}`).join('、') || '无分类失败'
    return `赛程 ${card.id}：${card.solved}/${card.challenges} 过（放弃 ${card.abandoned}），${mins}，${cost}；失败分布 ${cls}`.slice(0, 200)
  }
  if (card.outcome === 'solved') {
    return `「${card.challenge}」（${cat}${diff}）用 ${card.staged ? '串行阶段' : '单轮编排'} 跑通，${mins}，${cost}${card.skills.length ? `，技能 ${card.skills.join('/')}` : ''}`.slice(0, 200)
  }
  const why = card.reasons[0] ? `：${String(card.reasons[0]).slice(0, 60)}` : ''
  return `「${card.challenge}」（${cat}${diff}）未过，卡在 ${card.failureFamily}${why}；${mins}，${cost}`.slice(0, 200)
}

function cardToMarkdown(card) {
  const rows = Object.entries(card)
    .filter(([k]) => !['dir', 'report', 'reasons'].includes(k))
    .map(([k, v]) => `| ${k} | ${typeof v === 'object' ? JSON.stringify(v) : v} |`)
  const reasons = (card.reasons ?? []).map((r) => `- ${r}`).join('\n') || '- （无）'
  return `# 复盘卡：${card.id}\n\n| 字段 | 值 |\n| --- | --- |\n${rows.join('\n')}\n\n## 判定理由\n\n${reasons}\n\n## 下一步（人工确认后再执行）\n\n- 若同类失败连续 2 次：换策略，而不是调参重跑。\n- 预算超支：下次先按阶段预留（admitTurn）。\n`
}

function nextFactId(factsFile) {
  if (!fs.existsSync(factsFile)) return 1
  const text = fs.readFileSync(factsFile, 'utf8').replace(/^\uFEFF/, '')
  const ids = text.split(/\r?\n/).filter(Boolean).map((l) => {
    const m = l.match(/"id"\s*:\s*"F-(\d+)"/)
    if (m) return Number(m[1])
    try {
      return Number((String(JSON.parse(l).id ?? '').match(/^F-(\d+)$/) ?? [])[1] ?? 0)
    } catch {
      return 0
    }
  }).filter((n) => n > 0)
  return (ids.length ? Math.max(...ids) : 0) + 1
}

function writeFacts({ workspace, card, claim }) {
  const factsFile = path.join(workspace, '.dsh', 'memory', 'facts.jsonl')
  fs.mkdirSync(path.dirname(factsFile), { recursive: true })
  const n = nextFactId(factsFile)
  const relRaw = path.relative(workspace, card.dir).split(path.sep).join('\\')
  const rel = relRaw.startsWith('..') ? card.dir : relRaw
  const fact = {
    id: `F-${n}`,
    challenge: card.kind === 'race' ? card.id : card.challenge,
    claim,
    evidence: `[RUN:${card.id}] ${rel}\\events.jsonl${card.report && fs.existsSync(card.report) ? `；报告 ${path.basename(card.report)}` : ''}`,
    ts: new Date().toISOString().slice(0, 19) + '+08:00',
    confidence: card.outcome === 'solved' ? 'high' : card.outcome === 'partial' ? 'medium' : 'medium',
    tags: [card.category, card.kind === 'race' ? 'platform' : null].filter(Boolean),
  }
  fs.appendFileSync(factsFile, `${JSON.stringify(fact)}\n`)
  return { fact, factsFile }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (!args.run && !args.race)) {
    usage()
    return 2
  }
  const workspace = args.workspace ? path.resolve(args.workspace) : (findWorkspace(process.cwd()) ?? null)
  const card = args.run ? cardFromRun(path.resolve(args.run)) : cardFromRace(path.resolve(args.race))
  const claim = shortClaim(card)
  const outFile = args.out ? path.resolve(args.out) : path.join(ROOT, 'retro', `${card.kind}-${card.id}.md`)

  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, cardToMarkdown(card))
  }

  let fact = null
  if (!args.dryRun && !args.noFacts) {
    if (!workspace) {
      console.error('eva-retro: 找不到工作区（无 _tools/eva/toolgate.mjs），不写 facts')
    } else {
      const r = writeFacts({ workspace, card, claim })
      fact = r.fact
      const idx = spawnSync(process.execPath, [path.join(workspace, '_tools', 'eva', 'facts.mjs'), 'index'], { encoding: 'utf8', windowsHide: true })
      if (idx.status !== 0) console.error(`eva-retro: facts index 失败 ${String(idx.stderr).slice(-200)}`)
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: Boolean(args.dryRun),
    card: outFile,
    claim,
    fact: fact ? { id: fact.id, challenge: fact.challenge, confidence: fact.confidence } : null,
  }))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}