#!/usr/bin/env node
// A1 赛程调度器（CLI）：读题池 → 排序 → 双模分派 → 跟踪状态 → 断点续跑。
// 用法：
//   node bin/eva-race.mjs --pool ../race-pool.json --workspace <EVA 根> --dry-run
//   node bin/eva-race.mjs --pool ... --race-id race-20261113 --max-parallel 2 --once
// 事件写入 runs/<raceId>/events.jsonl；状态写 pool.json 与 state.json。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  loadPool, savePool, loadSchedule, orderQueue, pickStartable, transition, decideMode,
  estimateMinutes, valueDensity, loadRaceState, saveRaceState, recordCheckpoint,
  reconcileCheckpoints, nextActionFor,
} from '../lib/schedule.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--pool') out.pool = argv[++i]
    else if (a === '--workspace') out.workspace = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--race-id') out.raceId = argv[++i]
    else if (a === '--max-parallel') out.maxParallel = Number(argv[++i])
    else if (a === '--budget') out.budget = Number(argv[++i])
    else if (a === '--interval') out.interval = Number(argv[++i])
    else if (a === '--max-cycles') out.maxCycles = Number(argv[++i])
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--once') out.once = true
    else out._.push(a)
  }
  return out
}

function usage() {
  console.log(`eva-race — 赛程调度器

  --pool <file>        题池 JSON（必填）
  --workspace <dir>    工作区根（默认自动发现）
  --race-id <id>       赛程 id（默认 pool.raceId 或时间戳）
  --max-parallel <n>   同时跑的题数（默认 policies/schedule.json）
  --budget <tok>       单题预算（默认 2500000）
  --interval <sec>     轮询间隔（默认 5）
  --max-cycles <n>     最多调度轮数；0 = 不设限
  --once               只调一轮
  --dry-run            只打印计划，不拉起 Supervisor

  退出码：0 正常；2 参数/题池错误；3 有题最终 abandoned
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

function appendEvent(file, type, data = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`)
}

function classifyFailure(result) {
  const reasons = (result?.reasons ?? []).join(' | ').toLowerCase()
  if (result?.status === 'config-error') return 'env-unavailable'
  if (/timed out|墙钟/.test(reasons)) return 'timeout'
  if (/没有 worker 产出候选|no candidate|无候选/.test(reasons)) return 'no-candidate'
  if (/budget|预算/.test(reasons)) return 'budget-exhausted'
  if (/invalid|格式|schema/.test(reasons)) return 'format-invalid'
  return 'no-candidate'
}

function readResult(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

function runSupervisor({ workspace, challenge, budget, provider, model, patch, staged }) {
  const args = [path.join(ROOT, 'bin', 'eva-super.mjs'), '--challenge', `work/${challenge.id}`, '--json', '--budget', String(budget)]
  if (staged) args.push('--staged')
  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
  if (patch) args.push('--patch', patch)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: workspace, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      let json = null
      try {
        json = JSON.parse(line)
      } catch {
        json = null
      }
      resolve({ code, json, stderr: err.slice(-800) })
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return 0
  }
  if (!args.pool) {
    usage()
    return 2
  }
  const workspace = args.workspace ? path.resolve(args.workspace) : (findWorkspace(process.cwd()) ?? path.resolve(process.cwd()))
  const schedule = loadSchedule(path.join(ROOT, 'policies', 'schedule.json'))
  const pool = loadPool(path.resolve(args.pool))
  const raceId = args.raceId || pool.raceId
  const outRoot = path.resolve(args.out || path.join(ROOT, 'runs', raceId))
  const eventFile = path.join(outRoot, 'events.jsonl')
  const poolFile = path.join(outRoot, 'pool.json')
  const stateFile = path.join(outRoot, 'state.json')
  const budget = args.budget || schedule.defaultBudgetTokens
  const maxParallel = args.maxParallel || schedule.maxParallel

  fs.mkdirSync(outRoot, { recursive: true })
  const state = loadRaceState(stateFile)
  savePool(poolFile, pool)
  appendEvent(eventFile, 'race/start', { raceId, workspace, challenges: pool.challenges.length, maxParallel, dryRun: Boolean(args.dryRun) })

  // C2：重启先对账
  const check = reconcileCheckpoints(state)
  const stale = check.filter((r) => !r.ok)
  if (check.length) appendEvent(eventFile, 'race/reconcile', { total: check.length, stale: stale.length })
  if (stale.length) {
    const staleIds = new Set(stale.map((r) => r.challengeId))
    for (const id of staleIds) {
      const c = pool.challenges.find((x) => x.id === id)
      if (c && c.status === 'running') {
        transition(pool, id, 'queued', { note: 'reconcile: 产物哈希不一致，重跑' })
        appendEvent(eventFile, 'race/requeue', { id, why: 'artifact-stale' })
      }
    }
  }

  const cycles = args.once ? 1 : Math.max(1, args.maxCycles || 60)
  let exitCode = 0
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    // 先处理已完成的（waiting_confirm）：不自动提交，等人工/批量确认（B5 再补）
    for (const c of pool.challenges) {
      if (c.status === 'waiting_confirm') appendEvent(eventFile, 'race/await-confirm', { id: c.id, runId: c.runId })
    }

    const startable = pickStartable(pool, { ...schedule, maxParallel }, pool.challenges.filter((c) => c.status === 'running').length)
    if (!startable.length) {
      const pending = pool.challenges.filter((c) => c.status === 'running').length
      appendEvent(eventFile, 'race/idle', { pending, queued: pool.challenges.filter((c) => c.status === 'queued').length })
      if (!pending || args.once) break
    } else {
      const jobs = []
      for (const c of startable) {
        const mode = decideMode({ ...c, isContainer: /pwn|web/i.test(String(c.category)) }, schedule)
        appendEvent(eventFile, 'race/dispatch', {
          id: c.id, mode, estMinutes: estimateMinutes(c), density: Number(valueDensity(c).toFixed(3)), staged: mode === 'supervisor',
        })
        transition(pool, c.id, 'running', { startedAt: new Date().toISOString() })
        if (args.dryRun) {
          jobs.push(Promise.resolve({ id: c.id, dry: true }))
          continue
        }
        jobs.push(runSupervisor({
          workspace, challenge: c, budget, staged: mode === 'supervisor',
          provider: process.env.EVA_RACE_PROVIDER, model: process.env.EVA_RACE_MODEL, patch: process.env.EVA_RACE_PATCH,
        }).then((r) => ({ id: c.id, ...r })))
      }
      savePool(poolFile, pool)
      const done = await Promise.all(jobs)
      for (const r of done) {
        const c = pool.challenges.find((x) => x.id === r.id)
        if (!c) continue
        if (r.dry) {
          appendEvent(eventFile, 'race/dry-run', { id: c.id, mode: decideMode(c, schedule) })
          transition(pool, c.id, 'queued', { note: 'dry-run' })
          continue
        }
        const result = r.json || readResult(path.join(ROOT, 'runs', c.runId || '')) || null
        const spent = Number(result?.spentTotal ?? result?.spent ?? 0)
        if (result?.status === 'verified') {
          transition(pool, c.id, 'waiting_confirm', { runId: result.runId ?? null, spent })
          appendEvent(eventFile, 'race/verified', { id: c.id, runId: result.runId, spent, candidateFile: result.submission?.candidateFile ?? null })
        } else {
          const cls = classifyFailure(result)
          const streak = (state.challenges[c.id]?.streak?.[cls] ?? 0) + 1
          state.challenges[c.id] = { ...(state.challenges[c.id] || {}), streak: { ...(state.challenges[c.id]?.streak || {}), [cls]: streak } }
          const action = nextActionFor(cls, streak)
          appendEvent(eventFile, 'failure/classified', { id: c.id, class: cls, streak, action })
          if (action === 'requeue-wait-lease') {
            transition(pool, c.id, 'queued', { spent, note: `requeue:${cls}` })
          } else if (cls === 'budget-exhausted' || streak >= 3) {
            transition(pool, c.id, 'abandoned', { spent, note: `abandoned:${cls}` })
            exitCode = 3
          } else {
            transition(pool, c.id, 'queued', { spent, note: `retry:${cls}` })
          }
        }
        recordCheckpoint(state, c.id, { stage: 1, spentDelta: spent })
      }
      saveRaceState(stateFile, state)
      savePool(poolFile, pool)
    }

    if (args.once) break
    const active = pool.challenges.some((c) => c.status === 'queued' || c.status === 'running')
    if (!active) break
    await new Promise((r) => setTimeout(r, Math.max(1, args.interval || 5) * 1000))
  }

  savePool(poolFile, pool)
  saveRaceState(stateFile, state)
  const summary = {
    raceId,
    outRoot,
    verified: pool.challenges.filter((c) => c.status === 'waiting_confirm').length,
    done: pool.challenges.filter((c) => c.status === 'done').length,
    abandoned: pool.challenges.filter((c) => c.status === 'abandoned').length,
    queued: pool.challenges.filter((c) => c.status === 'queued').length,
  }
  appendEvent(eventFile, 'race/end', summary)
  console.log(JSON.stringify(summary))
  return exitCode
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`eva-race: ${error?.stack ?? error}`)
  process.exit(2)
})