#!/usr/bin/env node
// D2：心跳健康检查 CLI。`--once` 只查一次；否则每 60 s 查一次，连续 3 次失败告警。
// D3：`--watchdog <raceDir>` 打开看门狗模式，事件 15 min 不更新即报空转。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, startMonitor, startWatchdog } from '../lib/health.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const once = args.includes('--once')
const flag = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const consolePort = Number(flag('--console-port', 8787))
const runtimePid = flag('--pid') ? Number(flag('--pid')) : null
const raceDir = flag('--race')
const explicitEvents = flag('--events')

function latestRaceDir() {
  try {
    const dirs = fs.readdirSync(path.join(ROOT, 'runs'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => path.join(ROOT, 'runs', d.name))
    const withEvents = dirs.filter((d) => fs.existsSync(path.join(d, 'events.jsonl')))
    withEvents.sort((a, b) => fs.statSync(path.join(b, 'events.jsonl')).mtimeMs - fs.statSync(path.join(a, 'events.jsonl')).mtimeMs)
    return withEvents[0] ?? null
  } catch {
    return null
  }
}

const eventsDir = explicitEvents ? path.resolve(explicitEvents) : (raceDir ? path.resolve(raceDir) : (latestRaceDir() ?? path.join(ROOT, 'runs')))

if (args.includes('--watchdog')) {
  const dir = raceDir ? path.resolve(raceDir) : eventsDir
  const file = path.join(dir, 'events.jsonl')
  const idleMs = Number(flag('--idle-minutes', 15)) * 60 * 1000
  const wd = startWatchdog({
    idleMs,
    lastEventAt: () => {
      try {
        return fs.statSync(file).mtimeMs
      } catch {
        return null
      }
    },
    onStall: (info) => console.log(JSON.stringify({ type: 'stalled', dir, idleMs: info.idleMs, at: info.at })),
  })
  const r = wd.tick()
  wd.stop()
  console.log(JSON.stringify({ dir, file, stalled: r.stalled, idleMs: r.idleMs ?? 0 }))
  process.exit(r.stalled ? 3 : 0)
} else if (once) {
  const r = await check({ runtimePid, consolePort, eventsDir })
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 3)
} else {
  console.log(`eva-health: watching every 60s (console :${consolePort}${runtimePid ? `, pid ${runtimePid}` : ''}, events ${eventsDir})`)
  startMonitor({
    runtimePid,
    consolePort,
    eventsDir,
    onAlert: (a) => console.log(`ALERT ${a.at} ${a.name}: ${a.detail} (consecutive ${a.consecutive})`),
  })
}