// A3：环境租约。同一时刻只允许一个 run 持有某个「环境」（容器题/靶机）。
// 语义：抢不到就排队；到期可被抢占；结束必须 release；悬挂 30s 由 reclaimExpired 回收。
// 文件：runs/env.lease（JSON）。原子写：tmp + rename；串行化：<file>.lock（O_EXCL）。

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000
export const DEFAULT_STALE_MS = 30 * 1000

function nowMs() {
  return Date.now()
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function withLock(lockFile, fn, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const deadline = nowMs() + timeoutMs
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (nowMs() > deadline) return { ok: false, reason: 'lock-timeout' }
      // 悬挂锁：持有者进程已不在（仅同机可靠），或锁文件超过 30s
      try {
        const st = fs.statSync(lockFile)
        if (nowMs() - st.mtimeMs > DEFAULT_STALE_MS) fs.unlinkSync(lockFile)
      } catch {
        /* 锁刚被释放 */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs)
    }
  }
  try {
    return { ok: true, value: fn() }
  } finally {
    try {
      fs.unlinkSync(lockFile)
    } catch {
      /* 已被清理 */
    }
  }
}

/**
 * 尝试取租约。返回 { ok, lease, reason, holder }。
 * 不阻塞：抢不到由调用方决定排队（等待/下一轮）。
 */
export function acquire({ file, holder, challenge, ttlMs = DEFAULT_LEASE_TTL_MS, pid = process.pid }) {
  const lockFile = `${file}.lock`
  const result = withLock(lockFile, () => {
    const cur = readJsonSafe(file)
    const now = nowMs()
    if (cur && cur.expiresAt > now) {
      if (cur.holder === holder) {
        cur.expiresAt = now + ttlMs
        writeJsonAtomic(file, cur)
        return { ok: true, lease: cur, renewed: true }
      }
      return { ok: false, reason: 'held', holder: cur.holder, challenge: cur.challenge, expiresAt: cur.expiresAt }
    }
    const lease = { holder, challenge, pid, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs }
    writeJsonAtomic(file, lease)
    return { ok: true, lease }
  })
  if (result.ok === false) return result
  return result.value
}

/** 心跳续租；只有持有者能续。 */
export function heartbeat({ file, holder, ttlMs = DEFAULT_LEASE_TTL_MS }) {
  const result = withLock(`${file}.lock`, () => {
    const cur = readJsonSafe(file)
    if (!cur) return { ok: false, reason: 'no-lease' }
    if (cur.holder !== holder) return { ok: false, reason: 'not-owner', holder: cur.holder }
    const now = nowMs()
    cur.heartbeatAt = now
    cur.expiresAt = now + ttlMs
    writeJsonAtomic(file, cur)
    return { ok: true, lease: cur }
  })
  return result.ok === false ? result : result.value
}

/** 释放；destroy 回调用于销毁环境（DoD：销毁率 100%）。 */
export function release({ file, holder, destroy = null }) {
  const result = withLock(`${file}.lock`, () => {
    const cur = readJsonSafe(file)
    if (!cur) return { ok: true, released: false, reason: 'no-lease' }
    if (cur.holder !== holder) return { ok: false, reason: 'not-owner', holder: cur.holder }
    let destroyed = false
    if (typeof destroy === 'function') {
      try {
        destroy(cur)
        destroyed = true
      } catch (error) {
        return { ok: false, reason: 'destroy-failed', message: String(error?.message ?? error) }
      }
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* 已不存在 */
    }
    return { ok: true, released: true, destroyed }
  })
  return result.ok === false ? result : result.value
}

/** 回收悬挂租约：expiresAt 已过 → 返回被回收的旧租约（调用方可据此销毁残留环境）。 */
export function reclaimExpired({ file, now = nowMs(), destroy = null }) {
  const result = withLock(`${file}.lock`, () => {
    const cur = readJsonSafe(file)
    if (!cur || cur.expiresAt > now) return { ok: true, reclaimed: null }
    if (typeof destroy === 'function') {
      try {
        destroy(cur)
      } catch {
        /* 记录由调用方做 */
      }
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* 已不存在 */
    }
    return { ok: true, reclaimed: cur }
  })
  return result.ok === false ? result : result.value
}

export function peek({ file }) {
  const cur = readJsonSafe(file)
  if (!cur) return null
  return { ...cur, expired: cur.expiresAt <= nowMs() }
}