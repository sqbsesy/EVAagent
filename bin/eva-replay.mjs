#!/usr/bin/env node
// 回放：用同一题目、同一预算、同一模型重跑一次，比对状态与用量。
// 用途是回归（改提示词/闸门后是否退化），不是重放历史 token。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { orchestrate } from '../lib/run.mjs'
import { DshBridge, MockBridge } from '../lib/sdk.mjs'
import { findWorkspace } from '../lib/context.mjs'

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
    if (['help', 'json', 'dry-run', 'live'].includes(key)) {
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

const args = parseArgs(process.argv.slice(2))
if (args.help || typeof args.run !== 'string') {
  console.log(`EVA replay

用法：
  node bin/eva-replay.mjs --run <runId> [--live] [--out <dir>] [--json]

默认沿用原 run 的 dry-run/live 模式；--live 可强制拉起真实运行时。
产物：<out>/<newRunId>/，并写 comparison.json。`)
  process.exit(args.help ? 0 : 3)
}

const outRoot = path.resolve(typeof args.out === 'string' ? args.out : path.join(ROOT, 'runs'))
const originalDir = path.join(outRoot, args.run)
const metaFile = path.join(originalDir, 'meta.json')
if (!fs.existsSync(metaFile)) {
  console.error(`[eva-replay] 找不到 ${metaFile}`)
  process.exit(3)
}
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const budgetConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'policies', 'budget.json'), 'utf8'))
Object.assign(budgetConfig, meta.budget ?? {})
const submitPolicy = JSON.parse(fs.readFileSync(path.join(ROOT, 'policies', 'submit.json'), 'utf8'))
const dryRun = args.live ? false : Boolean(meta.dryRun ?? true)

const originalResult = fs.existsSync(path.join(originalDir, 'result.json'))
  ? JSON.parse(fs.readFileSync(path.join(originalDir, 'result.json'), 'utf8'))
  : null

const workspace = findWorkspace(process.cwd())
const result = await orchestrate({
  workspace,
  challengeDir: meta.challengeDir,
  outRoot,
  budgetConfig,
  submitPolicy,
  bridgeFactory: () =>
    dryRun
      ? new MockBridge({ cwd: workspace })
      : new DshBridge({ cwd: workspace, model: meta.model || undefined, provider: meta.provider || undefined }),
  model: meta.model,
  provider: meta.provider,
  dryRun,
  logger: args.json ? () => {} : (line) => console.log(line),
})

const comparison = {
  original: originalResult
    ? { runId: originalResult.runId, status: originalResult.status, verdict: originalResult.verdict?.verdict, spent: originalResult.spent }
    : null,
  replay: { runId: result.runId, status: result.status, verdict: result.verdict.verdict, spent: result.spent },
  sameStatus: originalResult ? originalResult.status === result.status : null,
  at: new Date().toISOString(),
}
fs.writeFileSync(path.join(result.runDir, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`)

if (args.json) {
  console.log(JSON.stringify(comparison))
} else {
  console.log('')
  console.log(`[eva-replay] 原 run：${comparison.original ? `${comparison.original.status} / ${comparison.original.verdict} / ${comparison.original.spent} tok` : '（缺 result.json）'}`)
  console.log(`[eva-replay] 回放：${comparison.replay.status} / ${comparison.replay.verdict} / ${comparison.replay.spent} tok`)
  console.log(`[eva-replay] 状态一致：${comparison.sameStatus === null ? '无法比较' : comparison.sameStatus ? '是' : '否'}`)
  console.log(`[eva-replay] 产物：${result.runDir}`)
}
process.exit(result.exitCode)