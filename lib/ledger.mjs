// 预算台账：硬闸不靠提示词自觉。
// 有 usage 就记实测值；没有就按字符数估算并打 estimated 标记（绝不假装是实测）。
import fs from 'node:fs'
import path from 'node:path'

const CHARS_PER_TOKEN = 3.5

export class BudgetStop extends Error {
  constructor(reason, ledger) {
    super(`budget stop: ${reason}`)
    this.name = 'BudgetStop'
    this.reason = reason
    this.ledger = ledger
  }
}

export function estimateTokens(...texts) {
  let chars = 0
  for (const text of texts) chars += String(text ?? '').length
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export class Ledger {
  constructor({ budget, convergeAt = 0.6, file = null, log = () => {}, priorSpent = 0 }) {
    this.budget = Number(budget) || 0
    this.convergeAt = Number(convergeAt) || 0.6
    this.file = file
    this.log = log
    this.prior = Math.max(0, Math.round(Number(priorSpent) || 0))
    this.total = 0
    this.estimatedTotal = 0
    this.entries = []
    this.stopped = null
    this.flush()
  }

  /** 已花总量（含本题历史），仅用于汇报；预算闸与收敛只看本 run。 */
  get effectiveTotal() {
    return this.prior + this.total
  }

  /** 记一笔用量；返回累计 total。raw 只在估算+放大时记录原始估算值。 */
  add({ role = 'unknown', tokens = 0, estimated = false, label = '', raw = null }) {
    const value = Math.max(0, Math.round(Number(tokens) || 0))
    this.total += value
    if (estimated) this.estimatedTotal += value
    const entry = { at: new Date().toISOString(), role, label, tokens: value, estimated }
    if (raw !== null && raw !== value) entry.raw = raw
    this.entries.push(entry)
    this.flush()
    this.log(
      `[ledger] +${value}${estimated ? '~' : ''} (${role}${label ? ':' + label : ''}) total=${this.total}/${this.budget}${this.prior ? ` (prior=${this.prior})` : ''}`,
    )
    return this.total
  }

  /** 由一次 prompt 的文本与回复估算（usage 缺失时的兜底）。
   *  toolChars 计入工具输出的字符数；multiplier 用于对估算值做保守放大（默认 1，即不放大）。 */
  addEstimate({ role, label, prompt, reply, toolChars = 0, multiplier = 1 }) {
    const chars = String(prompt ?? '').length + String(reply ?? '').length + Math.max(0, Number(toolChars) || 0)
    const raw = Math.ceil(chars / CHARS_PER_TOKEN)
    const factor = Number(multiplier) > 0 ? Number(multiplier) : 1
    return this.add({ role, label, tokens: Math.ceil(raw * factor), estimated: true, raw })
  }

  remaining() {
    return Math.max(0, this.budget - this.effectiveTotal)
  }

  /** 本次 run 自己的剩余（budget 已扣过 prior，不要再减一次）；准入控制用它。 */
  remainingRun() {
    return Math.max(0, this.budget - this.total)
  }

  ratio() {
    return this.budget > 0 ? this.total / this.budget : 0
  }

  shouldConverge() {
    return this.ratio() >= this.convergeAt
  }

  /** 超预算或外部触发时置位；之后所有 check() 都抛。 */
  stop(reason) {
    this.stopped = this.stopped ?? reason
    this.flush()
  }

  check(role = '') {
    if (this.stopped) throw new BudgetStop(this.stopped, this)
    if (this.budget > 0 && this.total >= this.budget) {
      this.stop('budget-exhausted')
      throw new BudgetStop('budget-exhausted', this)
    }
  }

  snapshot() {
    return {
      budget: this.budget,
      prior: this.prior,
      total: this.total,
      effectiveTotal: this.effectiveTotal,
      estimated: this.estimatedTotal,
      remaining: this.remaining(),
      ratio: Number(this.ratio().toFixed(4)),
      convergeAt: this.convergeAt,
      stopped: this.stopped,
      entries: this.entries,
    }
  }

  flush() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`)
    } catch {
      /* 台账写失败不影响主流程 */
    }
  }
}