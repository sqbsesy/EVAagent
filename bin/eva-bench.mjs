#!/usr/bin/env node
// 批量回放：按顺序跑若干道题，汇总 pass / token / 墙钟，产出可对比的 bench 报告。
// 用法：
//   node bin/eva-bench.mjs --challenges easycap,bluetrace,lfsr
//   node bin/eva-bench.mjs --challenges easycap --dry-run
// 退出码：0 全部完成且至少一题 verified / 2 有失败或未通过 / 3 配置或余额问题提前中止
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findWorkspace } from '../lib/context.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CHALLENGES = 'easycap,bluetrace,lfsr'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'help' || key === 'dry-run' || key === 'ignore-prior') {
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
  console.log(`EVA Bench（3 题回放）

用法：
  node bin/eva-bench.mjs [--challenges a,b,c] [--dry-run] [--out <runs 目录>]

选项：
  --challenges <列表>  逗号分隔的题目目录名（默认 ${DEFAULT_CHALLENGES}）
  --out <dir>          传给 eva-super 的 runs 目录（默认 <repo>/runs）
  --budget <tok>       每题 perRunTokens 覆盖
  --workers <n>        并发覆盖
  --dry-run            用 mock 跑
  --ignore-prior       不扣本题历史用量（重新计时）
  --max-seconds <n>    单题墙钟上限（默认 1800）
  --help               显示本帮助

遇到余额/适配器/配置类失败会立即中止后续题目，避免空转烧配额。`)
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US')
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exit(0)
}

const challenges = String(args.challenges ?? DEFAULT_CHALLENGES)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (!challenges.length) {
  console.error('[eva-bench] --challenges 为空')
  process.exit(3)
}

const outRoot = path.resolve(typeof args.out === 'string' ? args.out : path.join(ROOT, 'runs'))
const maxSeconds = Number(args['max-seconds'] ?? 1800) || 1800
const workspace = path.resolve(typeof args.workspace === 'string' ? args.workspace : findWorkspace(process.cwd()))
const benchDir = path.join(outRoot, `bench-${nowStamp()}`)
fs.mkdirSync(benchDir, { recursive: true })

const rows = []
let aborted = null

for (const challenge of challenges) {
  const started = Date.now()
  const argv = [path.join(ROOT, 'bin', 'eva-super.mjs'), '--challenge', challenge, '--json', '--out', outRoot]
  if (args['dry-run']) argv.push('--dry-run')
  if (args['ignore-prior']) argv.push('--ignore-prior')
  if (args.budget) argv.push('--budget', String(args.budget))
  if (args.workers) argv.push('--workers', String(args.workers))
  // live provider 透传：bench 与单题用同一套 patch/provider/model。
  for (const key of ['patch', 'provider', 'model']) {
    if (args[key]) argv.push(`--${key}`, String(args[key]))
  }

  console.log(`[eva-bench] ▶ ${challenge}`)
  const proc = spawnSync(process.execPath, argv, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: maxSeconds * 1000,
  })
  const elapsedSec = Math.round((Date.now() - started) / 1000)
  const stdout = String(proc.stdout ?? '')
  const stderr = String(proc.stderr ?? '')
  const line = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{') && s.endsWith('}'))
    .pop()
  let parsed = null
  if (line) {
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = null
    }
  }
  const row = {
    challenge,
    exitCode: proc.status,
    timedOut: proc.error?.code === 'ETIMEDOUT' || proc.signal !== null,
    elapsedSec,
    runId: parsed?.runId ?? null,
    status: parsed?.status ?? (proc.status === 0 ? 'unknown' : 'error'),
    verdict: parsed?.verdict ?? null,
    candidate: Boolean(parsed?.candidate),
    spent: Number(parsed?.spent) || 0,
    spentTotal: Number(parsed?.spentTotal ?? parsed?.spent ?? 0) || 0,
    estimated: Number(parsed?.estimated) || 0,
    budget: Number(parsed?.budget) || 0,
    reasons: parsed?.reasons ?? [],
    stderrTail: stderr.trim().split('\n').slice(-3).join('\n'),
  }
  rows.push(row)
  console.log(
    `[eva-bench]   ${row.status}/${row.verdict ?? '-'} spent=${fmt(row.spent)} total=${fmt(row.spentTotal)} ${elapsedSec}s`,
  )

  const joined = `${row.reasons.join(' ')} ${row.stderrTail}`
  if (/Insufficient Balance|no adapter registered|invalid exact model metadata|missing API key/i.test(joined)) {
    aborted = `模型通道不可用：${row.reasons[0] ?? row.stderrTail.split('\n')[0]}`
    console.log(`[eva-bench] ✖ 中止后续题目 — ${aborted}`)
    break
  }
  if (row.status === 'config-error') {
    aborted = `配置错误：${row.reasons[0] ?? 'unknown'}`
    console.log(`[eva-bench] ✖ 中止后续题目 — ${aborted}`)
    break
  }
}

const passed = rows.filter((r) => r.verdict === 'pass').length
const totalSpent = rows.reduce((sum, r) => sum + r.spent, 0)
const totalWall = rows.reduce((sum, r) => sum + r.elapsedSec, 0)
const bench = {
  generatedAt: new Date().toISOString(),
  dryRun: Boolean(args['dry-run']),
  challenges,
  rows,
  passed,
  total: rows.length,
  totalSpent,
  totalWallSec: totalWall,
  aborted,
}
fs.writeFileSync(path.join(benchDir, 'bench.json'), `${JSON.stringify(bench, null, 2)}\n`)

const lines = []
lines.push(`# Bench ${path.basename(benchDir)}`)
lines.push('')
lines.push(`- 模式：${bench.dryRun ? 'dry-run（mock）' : 'live'}`)
lines.push(`- 题目：${challenges.join(', ')}`)
lines.push(`- 结果：${passed}/${rows.length} verified，合计 ${fmt(totalSpent)} tok，${totalWall}s`)
if (aborted) lines.push(`- 中止：${aborted}`)
lines.push('')
lines.push('| 题目 | 状态 | 判定 | spent | 含历史 | 墙钟 | 备注 |')
lines.push('| --- | --- | --- | ---: | ---: | ---: | --- |')
for (const r of rows) {
  const note = r.timedOut ? '超时' : r.reasons[0] ? r.reasons[0].slice(0, 60) : ''
  lines.push(
    `| ${r.challenge} | ${r.status} | ${r.verdict ?? '-'} | ${fmt(r.spent)} | ${fmt(r.spentTotal)} | ${r.elapsedSec}s | ${note} |`,
  )
}
lines.push('')
lines.push('## 下一步')
lines.push('')
lines.push('- 对照 `runs/<runId>/report.md` 看每题的阶段耗时与工具调用分布；')
lines.push('- 失败的题先看 `events.jsonl` 里 `turn/end.error` 与 `verdict.reasons`，再决定改提示词还是改策略；')
lines.push('- 同一题重复跑前先 `cost.mjs settle`，让 `costs.jsonl` 的历史用量进入单题预算。')
fs.writeFileSync(path.join(benchDir, 'bench.md'), `${lines.join('\n')}\n`)

console.log('')
console.log(`[eva-bench] ${passed}/${rows.length} verified，${fmt(totalSpent)} tok，${totalWall}s`)
console.log(`[eva-bench] 报告：${path.join(benchDir, 'bench.md')}`)
if (aborted) {
  console.error(`[eva-bench] ${aborted}`)
  process.exit(3)
}
process.exit(passed === rows.length && rows.length === challenges.length ? 0 : 2)