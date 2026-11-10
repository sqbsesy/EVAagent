#!/usr/bin/env node
// EVA Supervisor CLI（P0）
// 用法：node bin/eva-super.mjs --challenge work/<题名> [--dry-run] [--budget N] [--workers N]
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { orchestrate } from '../lib/run.mjs'
import { DshBridge, MockBridge, DEFAULT_EXE } from '../lib/sdk.mjs'
import { findWorkspace, resolveChallenge, listFiles } from '../lib/context.mjs'
import { challengeSpent } from '../lib/budget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'help' || key === 'dry-run' || key === 'json') {
      out[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

function usage() {
  console.log(`EVA Supervisor（P0）

用法：
  node bin/eva-super.mjs --challenge <路径|work 下的目录名> [选项]
  node bin/eva-super.mjs --task "<工单描述>" [--task-dir <目录>] [选项]

选项：
  --budget <tok>      覆盖 policies/budget.json 的 perRunTokens（默认 1,200,000）
  --workers <n>       覆盖并发上限（默认 2，受内存约束）
  --model <id>        覆盖模型（默认沿用 sdk profile）
  --provider <id>     覆盖 provider
  --workspace <dir>   指定 EVA 工作区（默认向上查找 _tools/eva/toolgate.mjs）
  --task-dir <dir>    工单模式的工作目录（默认当前目录）
  --out <dir>         运行产物目录（默认 <repo>/runs）
  --ignore-prior      忽略本题历史用量（默认会从 costs.jsonl 与历史 runs 扣减单题预算）
  --dry-run           用 MockBridge 跑通全链路，不拉起运行时、不烧 token
  --json              只输出一行结果 JSON
  --help              显示本帮助

退出码：0 复核通过 / 2 部分或失败 / 3 配置错误 / 4 预算闸`)
}

function fail(message, code = 3) {
  console.error(`[eva-super] ${message}`)
  process.exit(code)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exit(0)
}
if (typeof args.challenge !== 'string' && typeof args.task !== 'string') {
  usage()
  fail('缺少 --challenge 或 --task')
}
if (typeof args.challenge === 'string' && typeof args.task === 'string') {
  fail('--challenge 与 --task 只能二选一')
}

const dryRun = Boolean(args['dry-run'])
const workspace = path.resolve(typeof args.workspace === 'string' ? args.workspace : findWorkspace(process.cwd()))
const taskText = typeof args.task === 'string' ? args.task : ''
let challengeDir
if (taskText) {
  // 工单模式：目录只是产物与工作区，题目语义由 task 文本给出。
  challengeDir = path.resolve(typeof args['task-dir'] === 'string' ? args['task-dir'] : process.cwd())
  if (!fs.existsSync(challengeDir)) fail(`找不到工单目录：${challengeDir}`)
} else {
  challengeDir = resolveChallenge(workspace, args.challenge)
  if (!challengeDir) fail(`找不到题目目录：${args.challenge}（既不是路径，也不在 ${path.join(workspace, 'work')} 下）`)
}

const configFile = path.join(ROOT, 'policies', 'budget.json')
const submitFile = path.join(ROOT, 'policies', 'submit.json')
const budgetConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const submitPolicy = JSON.parse(fs.readFileSync(submitFile, 'utf8'))
if (args.budget) budgetConfig.perRunTokens = Number(args.budget)
if (args.workers) budgetConfig.workerMax = Number(args.workers)
if (!Number.isFinite(budgetConfig.perRunTokens) || budgetConfig.perRunTokens <= 0) fail('预算必须是正数')
if (!Number.isFinite(budgetConfig.workerMax) || budgetConfig.workerMax < 1) fail('并发必须是 >= 1 的整数')

if (Number(process.versions.node.split('.')[0]) < 22) fail(`需要 Node >= 22，当前 ${process.version}`)

if (!dryRun) {
  const exe = process.env.EVA_DSH_EXE ?? DEFAULT_EXE
  // app.asar 内的路径用普通 fs 看不到，但 Electron 运行时能读；这里只校验 exe。
  if (!fs.existsSync(exe)) fail(`找不到 DSH 运行时：${exe}\n可用 EVA_DSH_EXE 覆盖；或先用 --dry-run 验证链路`)
}

const outRoot = path.resolve(typeof args.out === 'string' ? args.out : path.join(ROOT, 'runs'))
fs.mkdirSync(outRoot, { recursive: true })

// 单题历史用量：costs.jsonl 与历史 runs 取较大者；--ignore-prior 可跳过（重跑对照用）。
let prior = { total: 0, source: 'none' }
if (!taskText && !args['ignore-prior']) {
  prior = challengeSpent({ workspace, challenge: path.basename(challengeDir), outRoot })
}

const model = typeof args.model === 'string' ? args.model : process.env.EVA_DSH_MODEL ?? ''
const provider = typeof args.provider === 'string' ? args.provider : process.env.EVA_DSH_PROVIDER ?? ''
const files = listFiles(challengeDir)

if (!args.json) {
  console.log(`[eva-super] ${taskText ? `ticket=${challengeDir}` : `challenge=${challengeDir}`}`)
  if (taskText) console.log(`[eva-super] task=${taskText.split('\n')[0].slice(0, 120)}`)
  console.log(`[eva-super] workspace=${workspace}`)
  console.log(`[eva-super] files=${files.length} budget=${budgetConfig.perRunTokens} workers=${budgetConfig.workerMax} mode=${dryRun ? 'dry-run' : 'live'}`)
  if (prior.total > 0) {
    const remaining = Math.max(0, Number(budgetConfig.perChallengeTokens || 0) - prior.total)
    console.log(`[eva-super] 本题历史用量=${prior.total} tok（来源 ${prior.source}），单题余额≈${remaining}`)
  }
}

const controller = new AbortController()
const onSigint = () => {
  console.error('\n[eva-super] 收到中断，等待当前回合收尾（写 partial 产物）…')
  controller.abort()
}
process.on('SIGINT', onSigint)

const bridgeFactory = () =>
  dryRun
    ? new MockBridge({ cwd: workspace })
    : new DshBridge({ cwd: workspace, provider: provider || undefined, model: model || undefined })

const started = Date.now()
const result = await orchestrate({
  workspace,
  challengeDir,
  outRoot,
  budgetConfig,
  submitPolicy,
  bridgeFactory,
  model,
  provider,
  dryRun,
  signal: controller.signal,
  taskText,
  priorSpent: prior.total,
  logger: args.json ? () => {} : (line) => console.log(line),
})
const elapsed = Math.round((Date.now() - started) / 1000)

if (args.json) {
  console.log(
    JSON.stringify({
      runId: result.runId,
      status: result.status,
      verdict: result.verdict.verdict,
      candidate: Boolean(result.verdict.candidate),
      spent: result.spent,
      spentTotal: result.spentTotal,
      priorSpent: result.priorSpent,
      budget: result.budget,
      estimated: result.estimated,
      reasons: result.verdict.reasons ?? [],
      elapsedSec: elapsed,
      runDir: result.runDir,
    }),
  )
} else {
  const spend = `${result.spent}${result.estimated ? `（含估算 ${result.estimated}）` : ''}`
  console.log('')
  console.log(`[eva-super] 状态：${result.status}`)
  console.log(`[eva-super] 复核：${result.verdict.verdict}${result.verdict.reasons.length ? ` — ${result.verdict.reasons.join('；')}` : ''}`)
  console.log(`[eva-super] 用量：${spend} / ${result.budget} tok，${elapsed}s，${result.turns} 轮`)
  console.log(`[eva-super] 产物：${result.runDir}`)
  if (result.verdict.candidate) {
    console.log('[eva-super] 候选已入队，人工确认后提交：node bin/eva-submit.mjs --run ' + result.runId + ' --challenge <uuid> --ground <uuid> --confirm')
  }
}

process.exit(result.exitCode)