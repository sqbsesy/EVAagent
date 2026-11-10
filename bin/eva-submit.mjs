#!/usr/bin/env node
// 提交门禁（D3：默认人工确认）。
// Verifier 通过只代表「可以提交」，真正的提交必须显式 --confirm，并记录参数。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
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
    if (key === 'help' || key === 'confirm') {
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
  console.log(`EVA submit（人工确认）

用法：
  node bin/eva-submit.mjs --run <runId> --challenge <uuid> --ground <uuid> [--sub <uuid>] [--confirm]

  --flag <text>   不用 runs/<runId>/submissions/pending.json 里的候选，改用手填
  --dry-run       只打印将要调用的工具与参数（flag 脱敏），不实际提交
  --confirm       真正的提交动作，缺失即拒绝

前置：\<runs\>/<runId>/verdict.json 的 verdict 必须是 pass（或加 --force）。`)
  process.exit(args.help ? 0 : 3)
}

if (!args.confirm && !args['dry-run']) {
  console.error('[eva-submit] 拒绝提交：缺少 --confirm。先人工核对 flag 格式、来源与唯一性。')
  process.exit(3)
}

const runsRoot = path.resolve(typeof args.root === 'string' ? args.root : path.join(ROOT, 'runs'))
const runDir = path.join(runsRoot, args.run)
if (!fs.existsSync(runDir)) {
  console.error(`[eva-submit] 找不到 run：${runDir}`)
  process.exit(3)
}

let flag = typeof args.flag === 'string' ? args.flag : ''
const pendingFile = path.join(runDir, 'submissions', 'pending.json')
if (!flag && fs.existsSync(pendingFile)) {
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
  // 候选文件路径是「相对工作区」的；工作区从 cwd 往上找 _tools/eva/toolgate.mjs。
  if (pending.candidateFile) {
    const workspace = findWorkspace(process.cwd()) ?? path.resolve(ROOT, '..', '..')
    const file = path.resolve(workspace, pending.candidateFile)
    if (fs.existsSync(file)) flag = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim()
  }
  if (!flag) flag = pending.candidate ?? ''
}
if (flag.startsWith('file:')) {
  console.error(`[eva-submit] 候选文件读不到：${flag.slice(5)}（检查它是否还在工作区里）`)
  process.exit(3)
}
if (!flag) {
  console.error('[eva-submit] 没有候选 flag：请先跑 eva-super，或用 --flag 指定。')
  process.exit(3)
}

const verdictFile = path.join(runDir, 'verdict.json')
if (fs.existsSync(verdictFile) && !args.force) {
  const verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'))
  if (verdict.verdict !== 'pass') {
    console.error(`[eva-submit] 复核未通过（${verdict.verdict}）：${(verdict.reasons ?? []).join('；')}`)
    console.error('[eva-submit] 确认无误可加 --force，但需在复盘里写明理由。')
    process.exit(3)
  }
}

const dryRun = Boolean(args['dry-run'])
if ((!args.challenge || !args.ground) && !dryRun) {
  console.error('[eva-submit] 需要 --challenge <challenge_id> 与 --ground <practice_ground_id>')
  process.exit(3)
}

const payload = {
  challenge_id: String(args.challenge ?? '<challenge_id>'),
  practice_ground_id: String(args.ground ?? '<practice_ground_id>'),
  flag,
  confirmation: true,
}
if (args.sub) payload.sub_flag_id = String(args.sub)

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}
const mask = (value) => `<len=${String(value).length} sha256=${sha256(value).slice(0, 12)}>`

if (args['dry-run']) {
  console.log('[eva-submit] dry-run，不提交。工具 ctf2_submit_flag：')
  console.log(JSON.stringify({ ...payload, flag: mask(flag) }, null, 2))
  process.exit(0)
}

// 台账先落，再提交：即使提交失败也有记录。
const ledgerFile = path.join(runDir, 'submissions', 'submitted.jsonl')
const row = {
  ts: new Date().toISOString(),
  runId: args.run,
  challengeId: payload.challenge_id,
  practiceGroundId: payload.practice_ground_id,
  subFlagId: payload.sub_flag_id ?? null,
  flagSha256: sha256(flag),
  confirmed: true,
}
fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
fs.appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`)

const workspace = path.resolve(typeof args.workspace === 'string' ? args.workspace : findWorkspace(process.cwd()))
const lazy = path.join(workspace, '_tools', 'eva', 'mcp-lazy.mjs')
if (!fs.existsSync(lazy)) {
  console.error(`[eva-submit] 找不到 ${lazy}`)
  process.exit(3)
}

const call = spawnSync(process.execPath, [lazy, 'call', 'ctf2_submit_flag', '--args', JSON.stringify(payload)], {
  cwd: workspace,
  encoding: 'utf8',
})
process.stdout.write(call.stdout ?? '')
process.stderr.write(call.stderr ?? '')
if (call.status !== 0) {
  console.error(`[eva-submit] 工具调用失败（exit ${call.status}）；记录已写入 ${ledgerFile}`)
  process.exit(4)
}
console.log(`[eva-submit] 已提交并记账：${ledgerFile}`)