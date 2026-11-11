// 单题预算：把「这一题历史上已经花掉的 token」算进来，而不是每次 run 从零开始。
// 数据来源两处（都可能不完整，取更保守的一边）：
//   1) <workspace>/.dsh/memory/costs.jsonl —— cost.mjs settle 写下的会话级台账；
//   2) <outRoot>/<runId>/result.json —— 本 CLI 自己每次 run 的 spent。
import fs from 'node:fs'
import path from 'node:path'

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 聚合 cost.mjs 台账里同一道题的历史用量。 */
export function spentFromCosts(workspace, challenge, costsFile = null) {
  const file = costsFile ?? path.join(workspace, '.dsh', 'memory', 'costs.jsonl')
  let total = 0
  let records = 0
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { total, records, file }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec || rec.challenge !== challenge) continue
    const tokens = Number(rec.tokensTotal ?? rec.totalTokens ?? 0) || 0
    if (tokens <= 0) continue
    total += tokens
    records += 1
  }
  return { total, records, file }
}

/** 聚合本 CLI 自己的 runs/ 台账（同一个 challenges 目录下的历史 run）。 */
export function spentFromRuns(outRoot, challenge, { excludeRunId = null } = {}) {
  let total = 0
  let runs = 0
  let names = []
  try {
    names = fs.readdirSync(outRoot)
  } catch {
    return { total, runs, dir: outRoot }
  }
  for (const name of names) {
    if (name === excludeRunId) continue
    const dir = path.join(outRoot, name)
    const meta = readJson(path.join(dir, 'meta.json'))
    if (!meta || meta.challenge !== challenge) continue
    // dry-run 用的是 mock，不烧真实 token，不计入单题历史用量。
    if (meta.dryRun === true) continue
    const result = readJson(path.join(dir, 'result.json'))
    if (!result) continue
    total += Number(result.spent) || 0
    runs += 1
  }
  return { total, runs, dir: outRoot }
}

/**
 * 某题已经花掉多少：cost.mjs 台账与 runs 台账取较大者（两者口径不同，宁可高估）。
 * 返回 { total, source, costs, runs }。
 */
export function challengeSpent({ workspace, challenge, outRoot, excludeRunId = null, costsFile = null }) {
  const costs = spentFromCosts(workspace, challenge, costsFile)
  const runs = spentFromRuns(outRoot, challenge, { excludeRunId })
  const source = costs.total >= runs.total ? 'costs.jsonl' : 'runs'
  return { total: Math.max(costs.total, runs.total), source, costs, runs }
}

/**
 * 本次 run 的可用预算：min(perRunTokens, perChallengeTokens - 已花)。
 * 已花超过单题上限时返回 0，由调用方给出明确错误。
 */
export function effectiveRunBudget({ perRunTokens, perChallengeTokens = 0, priorSpent = 0 }) {
  const perRun = Math.max(0, Number(perRunTokens) || 0)
  const perChallenge = Math.max(0, Number(perChallengeTokens) || 0)
  if (!perChallenge) return { budget: perRun, priorSpent, remaining: null }
  const remaining = Math.max(0, perChallenge - priorSpent)
  return { budget: Math.min(perRun, remaining), priorSpent, remaining }
}

/**
 * 单轮准入：起跑前按「剩余预算 / 剩余阶段数」预留，避免最后一个阶段把预算吃光。
 * 返回 { ok, cap, reserve }：
 *   cap     —— 这一轮最多应花多少（估算上限，用于事后对账）
 *   reserve —— 给后续阶段留的部分
 *   ok=false 时调用方必须 BudgetStop（剩余已不够开一轮）
 */
export function admitTurn({ remaining, stagesLeft = 1, roleCap = 0, reserveShare = 0.2, minReserve = 20000 }) {
  const left = Math.max(0, Number(remaining) || 0)
  const stages = Math.max(1, Number(stagesLeft) || 1)
  const capRole = Number(roleCap) || 0
  const share = Math.min(0.8, Math.max(0, Number(reserveShare) || 0))
  const usable = left * (1 - share)
  const perStage = Math.floor(usable / stages)
  const cap = Math.max(0, capRole > 0 ? Math.min(capRole, perStage) : perStage)
  const reserve = Math.max(0, Math.floor(left - cap))
  return { ok: left > minReserve && cap > 0, cap, reserve, remaining: left, stagesLeft: stages }
}