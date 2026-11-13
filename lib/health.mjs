// D2：心跳健康检查。四项：运行时进程、控制台端口、模型额度、最近事件。
// 规则：连续 3 次失败才告警；同异常 10 min 只告警一次；目标 5 min 内发现。

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'

const DEFAULT_INTERVAL_MS = 60 * 1000
const DEFAULT_FAIL_THRESHOLD = 3
const DEFAULT_DEDUPE_MS = 10 * 60 * 1000

function probePort({ host = '127.0.0.1', port, timeoutMs = 1500 }) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok, detail) => {
      if (done) return
      done = true
      socket.destroy()
      resolve({ ok, detail })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, `tcp ${host}:${port} open`))
    socket.once('timeout', () => finish(false, `tcp ${host}:${port} timeout`))
    socket.once('error', (error) => finish(false, `tcp ${host}:${port} ${error.code ?? error.message}`))
    socket.connect(port, host)
  })
}

function latestEventAgeMs(eventsDir) {
  try {
    const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'))
    let newest = 0
    for (const f of files) {
      const st = fs.statSync(path.join(eventsDir, f))
      newest = Math.max(newest, st.mtimeMs)
    }
    if (!newest) return null
    return Date.now() - newest
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!pid) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 单次检查。返回 { ok, items:[{name, ok, detail}], at }。
 * quotaProbe 可选：返回 { ok, detail } 的异步函数（例如查一次余额接口）。
 */
export async function check({ runtimePid = null, consolePort = 8787, eventsDir = null, quotaProbe = null, staleEventMs = 30 * 60 * 1000 } = {}) {
  const items = []
  if (runtimePid) items.push({ name: 'runtime', ok: pidAlive(runtimePid) === true, detail: `pid ${runtimePid}` })
  if (consolePort) {
    const r = await probePort({ port: consolePort })
    items.push({ name: 'console', ...r })
  }
  if (eventsDir) {
    const age = latestEventAgeMs(eventsDir)
    items.push({
      name: 'events',
      ok: age === null ? false : age <= staleEventMs,
      detail: age === null ? 'no events yet' : `last event ${Math.round(age / 1000)}s ago`,
    })
  }
  if (typeof quotaProbe === 'function') {
    try {
      const r = await quotaProbe()
      items.push({ name: 'model-quota', ok: Boolean(r?.ok), detail: String(r?.detail ?? '') })
    } catch (error) {
      items.push({ name: 'model-quota', ok: false, detail: String(error?.message ?? error) })
    }
  }
  return { ok: items.every((i) => i.ok), items, at: new Date().toISOString() }
}

/**
 * 周期监控：连续 failThreshold 次失败才触发 onAlert；同一类异常 dedupeMs 内只报一次。
 * 返回 stop()。
 */
export function startMonitor({ intervalMs = DEFAULT_INTERVAL_MS, failThreshold = DEFAULT_FAIL_THRESHOLD, dedupeMs = DEFAULT_DEDUPE_MS, onAlert = null, ...opts } = {}) {
  const fails = new Map()
  const lastAlert = new Map()
  let timer = null
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const result = await check(opts)
    for (const item of result.items) {
      if (item.ok) {
        fails.delete(item.name)
        continue
      }
      const n = (fails.get(item.name) ?? 0) + 1
      fails.set(item.name, n)
      if (n < failThreshold) continue
      const prev = lastAlert.get(item.name) ?? 0
      if (Date.now() - prev < dedupeMs) continue
      lastAlert.set(item.name, Date.now())
      try {
        onAlert?.({ name: item.name, detail: item.detail, consecutive: n, at: result.at })
      } catch {
        /* 告警回调失败不打断监控 */
      }
    }
  }

  timer = setInterval(tick, intervalMs)
  if (timer.unref) timer.unref()
  tick()
  return {
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
    tick,
    state: () => Object.fromEntries(fails),
  }
}

/** gh/网络类外部命令的轻量包装：超时即失败，不抛。 */
export function runQuiet(cmd, args = [], { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout).slice(0, 400), stderr: String(stderr).slice(0, 400) })
    })
  })
}