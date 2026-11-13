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
  // P1
  budgetShare: 0.7,        // A5：题数 × 单题预算 × 0.7 作为计划额
  budgetReserveShare: 0.1, // A5：额外留 10% 机动
  parallelMin: 1,          // C1：动态并发下限
  parallelMax: 3,          // C1：动态并发上限
  sampleSeconds: 30,       // C1：采样间隔
  fingerprintHours: 24,    // C5：同指纹 24 h 内只跑一次
  breakerStreak: 2,        // C4：同策略连续 2 次无候选即熔断
  breakerAttempts: 3,      // C4：单题最多 3 次尝试
  confirmBatchMax: 5,      // B5：单批确认 ≤5
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

// ---------- A5：赛程预算池 ----------

/**
 * 计划额 = 题数 × 单题预算 × budgetShare；再留 budgetReserveShare 机动。
 * hardCap 是派发时单题可用的上限（避免某题吃掉全池）。
 */
export function raceBudget(pool, schedule = DEFAULT_SCHEDULE, perChallengeTokens = null) {
  const n = Math.max(0, (pool?.challenges ?? []).length)
  const each = Number(perChallengeTokens) || Number(schedule.defaultBudgetTokens) || 2500000
  const share = Number.isFinite(schedule.budgetShare) ? schedule.budgetShare : 0.7
  const reserveShare = Number.isFinite(schedule.budgetReserveShare) ? schedule.budgetReserveShare : 0.1
  const gross = n * each
  const planned = Math.floor(gross * share)
  const reserve = Math.floor(planned * reserveShare)
  const hardCap = Math.min(each, Math.max(1, planned - reserve))
  return { count: n, perChallenge: each, gross, planned, reserve, hardCap: Math.floor(hardCap) }
}

// ---------- C1：并发动态化 ----------

/** 内存压力 0..1（1 = 很紧张）。只看 freemem/totalmem，避免引入依赖。 */
export function pressureSample(mem) {
  const total = Number(mem?.totalmem ?? 0)
  const free = Number(mem?.freemem ?? 0)
  if (!total) return 0
  return Math.min(1, Math.max(0, 1 - free / total))
}

/**
 * 三次采样取最小容量：压力 > 0.75 → 1；> 0.55 → 2；否则 max。
 * samples 是最近的采样（压力值），缺省视为无压力。
 */
export function parallelFromSamples(samples = [], schedule = DEFAULT_SCHEDULE) {
  const min = Number.isFinite(schedule.parallelMin) ? schedule.parallelMin : 1
  const max = Number.isFinite(schedule.parallelMax) ? schedule.parallelMax : 3
  const last = samples.slice(-3).map((x) => (Number.isFinite(x) ? x : 0))
  if (!last.length) return max
  const worst = Math.max(...last)
  let cap = worst > 0.75 ? min : worst > 0.55 ? Math.max(min, Math.min(2, max)) : max
  cap = Math.max(min, Math.min(max, cap))
  return cap
}

// ---------- C4：单题熔断 ----------

/**
 * 熔断判定：同策略连续无候选到阈值、或尝试次数到顶、或单题花费吃满。
 * tripped 为 true 时调度器把题置 abandoned 并写事件。
 */
export function shouldBreak({ attempts = 0, streak = 0, spent = 0, perChallenge = 0 }, schedule = DEFAULT_SCHEDULE) {
  const maxAttempts = Number(schedule.breakerAttempts) || 3
  const streakLimit = Number(schedule.breakerStreak) || 2
  if (attempts >= maxAttempts) return { tripped: true, reason: 'max-attempts' }
  if (streak >= streakLimit) return { tripped: true, reason: 'same-strategy-no-candidate' }
  if (perChallenge > 0 && spent >= perChallenge) return { tripped: true, reason: 'budget' }
  return { tripped: false, reason: '' }
}

// ---------- C5：策略指纹 ----------

/** 题号 + 技能集 + 提示词版本 → 12 位指纹；同指纹重跑没有信息增益。 */
export function strategyFingerprint({ id = '', skills = [], promptVersion = 'v1' } = {}) {
  const key = [id, [...skills].sort().join(','), promptVersion].join('|')
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)
}

export function recentFingerprint(state, fp, { now = Date.now(), hours = 24 } = {}) {
  const at = Number(state?.fingerprints?.[fp] ?? 0)
  if (!at) return false
  return now - at < hours * 3600 * 1000
}

export function recordFingerprint(state, fp, { now = Date.now(), challengeId = null } = {}) {
  state.fingerprints = state.fingerprints || {}
  state.fingerprints[fp] = now
  if (challengeId) {
    state.challenges = state.challenges || {}
    const cur = state.challenges[challengeId] || {}
    state.challenges[challengeId] = { ...cur, lastFingerprint: fp, lastRunAt: new Date(now).toISOString() }
  }
  return state
}

// ---------- B2：题型路由 ----------

const DEFAULT_ROUTING = {
  forensics: { skills: ['ctf-forensics'], mode: null },
  reverse: { skills: ['ctf-reverse'], mode: null },
  crypto: { skills: ['ctf-crypto'], mode: null },
  web: { skills: ['ctf-web'], mode: null },
  pwn: { skills: ['ctf-pwn'], mode: null },
  misc: { skills: ['ctf-misc'], mode: null },
  'ai-ml': { skills: ['ctf-ai-ml'], mode: null },
}

export function loadRouting(file) {
  try {
    return { ...DEFAULT_ROUTING, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...DEFAULT_ROUTING }
  }
}

/** 按题型取技能（≤3），并把容器 + pwn/web 提升为 supervisor。 */
export function pickSkills(challenge, routing = DEFAULT_ROUTING) {
  const key = String(challenge?.category ?? 'misc').toLowerCase()
  const entry = routing[key] ?? routing.misc ?? { skills: [] }
  const skills = Array.isArray(entry.skills) ? entry.skills.filter(Boolean).slice(0, 3) : []
  return { skills, mode: entry.mode ?? null }
}

// ---------- B3：难度双通道 ----------

/** 先验难度：历史里同题型同难度题目的通过率，转成 easy/medium/hard。 */
export function priorDifficulty(history = [], challenge = {}) {
  const cat = String(challenge?.category ?? '').toLowerCase()
  const rows = history.filter((h) => String(h?.category ?? '').toLowerCase() === cat)
  if (rows.length < 3) return null
  const solved = rows.filter((h) => h.solved).length
  const rate = solved / rows.length
  if (rate >= 0.6) return 'easy'
  if (rate >= 0.3) return 'medium'
  return 'hard'
}

const RANK = { easy: 1, medium: 2, hard: 3 }

/** 两条通道取高（难者优先），避免低估算把难题当简单题跑。 */
export function combineDifficulty(modelGuess, priorGuess) {
  const a = RANK[modelGuess] ? modelGuess : null
  const b = RANK[priorGuess] ? priorGuess : null
  if (!a) return b
  if (!b) return a
  return RANK[b] > RANK[a] ? b : a
}

/** 两通道一致率（≥0.5 才认为先验可信，用于报告而非硬闸）。 */
export function difficultyAgreement(pairs = []) {
  const usable = pairs.filter((p) => p?.model && p?.prior)
  if (!usable.length) return { rate: null, n: 0 }
  const same = usable.filter((p) => p.model === p.prior).length
  return { rate: same / usable.length, n: usable.length }
}

// ---------- D4：告警分级 ----------

/** L1 需要决策、L2 只需知晓、L3 仅记录。 */
export function alertLevel(kind) {
  const table = {
    'budget-exhausted': 'L1',
    'env-unavailable': 'L1',
    'all-abandoned': 'L1',
    stalled: 'L1',
    'awaiting-confirm': 'L2',
    'parallel-degraded': 'L2',
    'fingerprint-dedup': 'L3',
    'stage-missing': 'L3',
  }
  return table[kind] ?? 'L3'
}

/** L1 在 8 h 窗口内最多 5 条；超出只记 L3，避免告警风暴。 */
export function shouldEmitAlert(state, kind, { now = Date.now(), capL1 = 5, windowMs = 8 * 3600 * 1000 } = {}) {
  const level = alertLevel(kind)
  if (level !== 'L1') return { emit: true, level }
  state.alerts = state.alerts || { L1: [] }
  state.alerts.L1 = state.alerts.L1.filter((t) => now - t < windowMs)
  if (state.alerts.L1.length >= capL1) return { emit: false, level: 'L3', reason: 'l1-cap' }
  state.alerts.L1.push(now)
  return { emit: true, level }
}