#!/usr/bin/env node
// D2：心跳健康检查 CLI。`--once` 只查一次；否则每 60 s 查一次，连续 3 次失败告警。
import { check, startMonitor } from '../lib/health.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const once = args.includes('--once')
const portIdx = args.indexOf('--console-port')
const consolePort = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787
const pidIdx = args.indexOf('--pid')
const runtimePid = pidIdx >= 0 ? Number(args[pidIdx + 1]) : null
const eventsDir = path.join(ROOT, 'runs')

if (once) {
  const r = await check({ runtimePid, consolePort, eventsDir })
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 3)
} else {
  console.log(`eva-health: watching every 60s (console :${consolePort}${runtimePid ? `, pid ${runtimePid}` : ''})`)
  startMonitor({
    runtimePid,
    consolePort,
    eventsDir,
    onAlert: (a) => console.log(`ALERT ${a.at} ${a.name}: ${a.detail} (consecutive ${a.consecutive})`),
  })
}