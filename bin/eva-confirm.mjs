#!/usr/bin/env node
// B5 批量确认：把 waiting_confirm 的题按批（≤5）人工确认落库。
// 约束：单批最多 confirmBatchMax 条；每条必须显式 "confirm": true；默认不提交 flag。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadSchedule, loadPool, savePool, transition } from '../lib/schedule.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--race') out.race = argv[++i]
    else if (a === '--file') out.file = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--submit') out.submit = true
    else if (a === '--help' || a === '-h') out.help = true
    else out._.push(a)
  }
  return out
}

function usage() {
  console.log(`eva-confirm — 批量确认（每批 ≤5，逐条 confirmation）

  --race <dir>      赛程目录（含 pool.json）
  --file <json>     批次文件：{"items":[{"id":"easycap","confirm":true}]}
  --dry-run         只校验与打印，不改状态
  --submit          确认后调用 eva-submit（需 item 里带 challengeId/groundId，仍要 --confirm）
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.race || !args.file) {
    usage()
    return 2
  }
  const schedule = loadSchedule(path.join(ROOT, 'policies', 'schedule.json'))
  const raceDir = path.resolve(args.race)
  const poolFile = path.join(raceDir, 'pool.json')
  const pool = loadPool(poolFile)
  const batch = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'))
  const items = Array.isArray(batch?.items) ? batch.items : []
  const max = Number(schedule.confirmBatchMax) || 5

  if (!items.length) {
    console.error('eva-confirm: 批次为空')
    return 2
  }
  if (items.length > max) {
    console.error(`eva-confirm: 单批最多 ${max} 条，收到 ${items.length} 条`)
    return 2
  }
  const bad = []
  for (const it of items) {
    const c = pool.challenges.find((x) => x.id === it?.id)
    if (!c) bad.push(`${it?.id}: 不在题池`)
    else if (c.status !== 'waiting_confirm') bad.push(`${it?.id}: 状态 ${c.status}，不是 waiting_confirm`)
    else if (it.confirm !== true) bad.push(`${it?.id}: 缺 "confirm": true`)
    else if (args.submit && (!it.challengeId || !it.groundId)) bad.push(`${it?.id}: --submit 需要 challengeId/groundId`)
  }
  if (bad.length) {
    console.error(`eva-confirm: 校验失败\n- ${bad.join('\n- ')}`)
    return 2
  }

  const confirmed = []
  for (const it of items) {
    const c = pool.challenges.find((x) => x.id === it.id)
    if (args.submit) {
      const runDir = path.join(ROOT, 'runs', c.runId || '')
      const r = spawnSync(process.execPath, [
        path.join(ROOT, 'bin', 'eva-submit.mjs'),
        '--run', runDir,
        '--challenge', String(it.challengeId),
        '--ground', String(it.groundId),
        '--confirm',
      ], { encoding: 'utf8', windowsHide: true })
      if (r.status !== 0) {
        console.error(`eva-confirm: ${it.id} 提交失败 exit=${r.status} ${String(r.stderr).slice(-300)}`)
        return 3
      }
    }
    if (!args.dryRun) {
      const t = transition(pool, it.id, 'done', {
        spent: c.spent,
        note: `confirmed:${new Date().toISOString()}`,
      })
      if (!t) {
        console.error(`eva-confirm: ${it.id} 状态迁移失败`)
        return 2
      }
    }
    confirmed.push(it.id)
  }

  if (!args.dryRun) {
    savePool(poolFile, pool)
    fs.appendFileSync(path.join(raceDir, 'events.jsonl'), `${JSON.stringify({
      ts: new Date().toISOString(),
      type: 'race/confirm-batch',
      count: confirmed.length,
      ids: confirmed,
      submitted: Boolean(args.submit),
    })}\n`)
  }
  console.log(JSON.stringify({ ok: true, dryRun: Boolean(args.dryRun), confirmed, submitted: Boolean(args.submit) }))
  return 0
}

process.exit(main())