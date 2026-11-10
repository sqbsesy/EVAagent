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
  constructor({ budget, convergeAt = 0.6, file = null, log = () => {} }) {
    this.budget = Number(budget) || 0
    this.convergeAt = Number(convergeAt) || 0.6
    this.file = file
    this.log = log
    this.total = 0
    this.estimatedTotal = 0
    this.entries = []
    this.stopped = null
    this.flush()
  }

  /** 记一笔用量；返回累计 total。 */
  add({ role = 'unknown', tokens = 0, estimated = false, label = '' }) {
    const value = Math.max(0, Math.round(Number(tokens) || 0))
    this.total += value
    if (estimated) this.estimatedTotal += value
    this.entries.push({ at: new Date().toISOString(), role, label, tokens: value, estimated })
    this.flush()
    this.log(`[ledger] +${value}${estimated ? '~' : ''} (${role}${label ? ':' + label : ''}) total=${this.total}/${this.budget}`)
    return this.total
  }

  /** 由一次 prompt 的文本与回复估算（usage 缺失时的兜底）。 */
  addEstimate({ role, label, prompt, reply }) {
    return this.add({ role, label, tokens: estimateTokens(prompt, reply), estimated: true })
  }

  remaining() {
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
      total: this.total,
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