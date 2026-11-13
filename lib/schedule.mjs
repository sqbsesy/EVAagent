// A1/A2/A4/C2：赛程调度核心（纯函数 + 小的文件读写）。
// 不直接拉起模型：出队、排序、状态机、断点对账都放这里，便于单测。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const STATES = ['queued', 'running', 'waiting_confirm', 'done', 'abandoned']
const TRANSITIONS = {
  queued: ['running', 'abandoned'],
  running: ['waiting_confirm', 'done', 'abandoned', 'queued'],
  waiting_confirm: ['done', 'abandoned', 'running'],
  done: [],
  abandoned: [],
}

export const DEFAULT_SCHEDULE = {
  soloMaxMinutes: 15,      // A2：预计 ≤15 min 走单会话直解
  maxParallel: 2,          // A4：跨题并行上限（内存约束）
  workerMax: 2,
  defaultBudgetTokens: 2500000,
  flagWaitMinutes: 30,
}

export function loadSchedule(file) {
  try {
    return { ...DEFAULT_SCHEDULE, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...DEFAULT_SCHEDULE }
  }
}

export function loadPool(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return normalizePool(raw)
}

export function normalizePool(raw) {
  const challenges = (Array.isArray(raw?.challenges) ? raw.challenges : []).map((c, i) => ({
    id: String(c.id ?? c.challenge_id ?? `c${i + 1}`),
    title: String(c.title ?? c.id ?? `challenge-${i + 1}`),
    category: c.category ?? null,
    difficulty: ['easy', 'medium', 'hard'].includes(c.difficulty) ? c.difficulty : (c.difficulty ?? null),
    score: Number.isFinite(Number(c.score)) ? Number(c.score) : 100,
    estMinutes: Number.isFinite(Number(c.estMinutes)) ? Number(c.estMinutes) : null,
    status: STATES.includes(c.status) ? c.status : 'queued',
    runId: c.runId ?? null,
    spent: Number.isFinite(Number(c.spent)) ? Number(c.spent) : 0,
    note: c.note ?? '',
  }))
  return {
    raceId: raw?.raceId ?? `race-${Date.now()}`,
    mode: raw?.mode === 'solve' ? 'solve' : 'race',
    createdAt: raw?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    challenges,
  }
}

export function savePool(file, pool) {
  pool.updatedAt = new Date().toISOString()
  writeJsonAtomic(file, pool)
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/** 预计耗时：显式 estMinutes 优先；否则按难度/题型给经验值（分钟）。 */
export function estimateMinutes(c) {
  if (Number.isFinite(c?.estMinutes) && c.estMinutes > 0) return c.estMinutes
  const base = c?.difficulty === 'hard' ? 40 : c?.difficulty === 'medium' ? 22 : 8
  const byCat = { forensics: 1.4, pwn: 1.3, reverse: 1.2, crypto: 1.0, web: 0.9, misc: 0.8 }[c?.category] ?? 1
  return Math.round(base * byCat)
}

/** 价值密度：分值 ÷ 预计耗时。分高、耗时短的先做。 */
export function valueDensity(c) {
  return (Number(c?.score) || 0) / Math.max(1, estimateMinutes(c))
}

export function orderQueue(pool) {
  return [...pool.challenges]
    .filter((c) => c.status === 'queued')
    .sort((a, b) => valueDensity(b) - valueDensity(a))
}

/** A2：双模判定。返回 'solo'（单会话直解）或 'supervisor'。 */
export function decideMode(challenge, schedule = DEFAULT_SCHEDULE) {
  const est = estimateMinutes(challenge)
  if (challenge?.isContainer && /pwn|web/i.test(String(challenge?.category ?? ''))) return 'supervisor'
  return est <= schedule.soloMaxMinutes ? 'solo' : 'supervisor'
}

/** 状态迁移；非法迁移返回 null 而不是抛错（调度器会记事件并跳过）。 */
export function transition(pool, id, to, patch = {}) {
  const c = pool.challenges.find((x) => x.id === id)
  if (!c) return null
  if (!STATES.includes(to)) return null
  if (!(TRANSITIONS[c.status] || []).includes(to)) return null
  const from = c.status
  c.status = to
  Object.assign(c, patch)
  pool.updatedAt = new Date().toISOString()
  return { id, from, to, at: pool.updatedAt }
}

/** A4：本次允许同时启动哪些题（按价值密度取前 N；running 数计入上限）。 */
export function pickStartable(pool, schedule = DEFAULT_SCHEDULE, runningNow = null) {
  const running = runningNow ?? pool.challenges.filter((c) => c.status === 'running').length
  const slots = Math.max(0, (schedule.maxParallel ?? 2) - running)
  if (!slots) return []
  return orderQueue(pool).slice(0, slots)
}

// ---------- C2：赛程断点 ----------

export function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

export function loadRaceState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { challenges: {}, updatedAt: null }
  }
}

export function saveRaceState(file, state) {
  state.updatedAt = new Date().toISOString()
  writeJsonAtomic(file, state)
}

/** 记录某题某阶段的产物哈希，供重启对账。 */
export function recordCheckpoint(state, challengeId, { stage, artifacts = [], spentDelta = 0 }) {
  const cur = state.challenges[challengeId] || { stage: 0, artifacts: {}, spent: 0 }
  cur.stage = Math.max(cur.stage, Number(stage) || 0)
  for (const abs of artifacts) {
    const h = hashFile(abs)
    if (h) cur.artifacts[abs] = { sha256: h, bytes: fs.statSync(abs).size }
  }
  cur.spent += Number(spentDelta) || 0
  state.challenges[challengeId] = cur
  return cur
}

/**
 * 对账：返回哪些产物仍然有效（哈希一致）。不一致的条目标记 stale，调用方重跑该阶段。
 * 强杀重启时用来避免重复计算（DoD：重复计算 ≤1 阶段）。
 */
export function reconcileCheckpoints(state) {
  const report = []
  for (const [id, entry] of Object.entries(state?.challenges ?? {})) {
    for (const [abs, meta] of Object.entries(entry.artifacts ?? {})) {
      const h = hashFile(abs)
      report.push({ challengeId: id, path: abs, ok: h !== null && h === meta.sha256, expected: meta.sha256, actual: h })
    }
  }
  return report
}

/** 连续同类失败 → 第 2 次必须换策略（C3）。返回建议动作。 */
export function nextActionFor(failureClass, streak = 1) {
  const table = {
    timeout: streak >= 2 ? 'split-stages' : 'tighten-scope',
    'no-candidate': streak >= 2 ? 'change-strategy' : 'retry-strategy',
    'budget-exhausted': 'collect-partial',
    'env-unavailable': 'requeue-wait-lease',
    'format-invalid': streak >= 2 ? 'abandon' : 'one-more-round',
  }
  return table[failureClass] ?? 'record'
}