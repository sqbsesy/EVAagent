// B1：赛题结构化。字段缺失写 null 并标「未知」，不猜；每个字段带来源与置信度。
// 设计目标：调度器只依赖本模块，不直接解析题面文本。

const FIELDS = [
  'id', 'title', 'category', 'difficulty', 'isContainer', 'subFlags',
  'attachments', 'timeWindow', 'scoreMultiplier', 'submissionsLeft', 'flagContract',
]

const CATEGORIES = new Set(['web', 'pwn', 'reverse', 'crypto', 'misc', 'forensics', 'osint', 'blockchain', 'ai'])

/** 从半结构化输入构造一条赛题记录；缺失字段一律 null + 来源 "unknown"。 */
export function makeChallenge(input = {}, opts = {}) {
  const source = opts.source || 'manual'
  const confidence = Number.isFinite(opts.confidence) ? opts.confidence : (source === 'api' ? 1 : 0.8)
  const field = (name, value) => ({ value, source: value === null || value === undefined ? 'unknown' : source, confidence: value === null || value === undefined ? 0 : confidence })

  const id = input.id ?? input.challenge_id ?? input.challengeId ?? null
  const title = input.title ?? input.name ?? null
  const category = CATEGORIES.has(String(input.category || '').toLowerCase()) ? String(input.category).toLowerCase() : null
  const difficulty = ['easy', 'medium', 'hard'].includes(String(input.difficulty || '').toLowerCase())
    ? String(input.difficulty).toLowerCase()
    : null
  const attachments = Array.isArray(input.attachments) ? input.attachments.map(String) : null
  const subFlags = Array.isArray(input.subFlags) ? input.subFlags.map(String) : null

  return {
    id: field('id', id === null ? null : String(id)),
    title: field('title', title === null ? null : String(title)),
    category: field('category', category),
    difficulty: field('difficulty', difficulty),
    isContainer: field('isContainer', typeof input.isContainer === 'boolean' ? input.isContainer : null),
    subFlags: field('subFlags', subFlags),
    attachments: field('attachments', attachments),
    timeWindow: field('timeWindow', input.timeWindow ?? null),
    scoreMultiplier: field('scoreMultiplier', Number.isFinite(Number(input.scoreMultiplier)) ? Number(input.scoreMultiplier) : null),
    submissionsLeft: field('submissionsLeft', Number.isFinite(Number(input.submissionsLeft)) ? Number(input.submissionsLeft) : null),
    flagContract: field('flagContract', normalizeFlagContract(input.flagContract)),
    // 展示用平面视图，便于排序/写盘
    flat: {
      id: id === null ? null : String(id),
      title: title === null ? null : String(title),
      category,
      difficulty,
      scoreMultiplier: Number.isFinite(Number(input.scoreMultiplier)) ? Number(input.scoreMultiplier) : null,
    },
  }
}

function normalizeFlagContract(c) {
  if (c === null || c === undefined) return null
  if (typeof c === 'string') return { pattern: c, note: null }
  if (typeof c === 'object') {
    return {
      pattern: typeof c.pattern === 'string' ? c.pattern : null,
      note: typeof c.note === 'string' ? c.note : null,
    }
  }
  return null
}

/** 自动填充率：非 null 字段 / 总字段数（DoD 要求 ≥95%，靠接口/题面/历史售价推断逐步逼近）。 */
export function fillRate(record) {
  let filled = 0
  for (const name of FIELDS) {
    const entry = record?.[name]
    if (entry && entry.value !== null && entry.value !== undefined) filled += 1
  }
  return { filled, total: FIELDS.length, rate: filled / FIELDS.length }
}

/** 缺哪些字段，供题池体检用。 */
export function missingFields(record) {
  return FIELDS.filter((name) => {
    const entry = record?.[name]
    return !entry || entry.value === null || entry.value === undefined
  })
}

/** 从题面文本做保守推断（只在明确线索时给值，并标 inferred 0.5）。 */
export function inferFromText(text = '', record) {
  const out = { ...record }
  const t = String(text)
  const lower = t.toLowerCase()
  const set = (name, value, conf = 0.5) => {
    const cur = out[name]
    if (cur && cur.value !== null && cur.value !== undefined) return
    out[name] = { value, source: 'inferred', confidence: conf }
  }
  if (!out.isContainer?.value && /\bdocker\b|docker-compose|容器|镜像/.test(lower)) set('isContainer', true, 0.6)
  if (!out.category?.value) {
    if (/pcap|pcapng|内存镜像|磁盘镜像|取证|forensic/.test(lower)) set('category', 'forensics', 0.6)
    else if (/sql注入|xss|ssrf|jwt|web/.test(lower)) set('category', 'web', 0.6)
    else if (/rsa|aes|ecc|密钥|密文|crypto/.test(lower)) set('category', 'crypto', 0.6)
    else if (/reverse|反编译|apk|elf|逆向/.test(lower)) set('category', 'reverse', 0.6)
  }
  const flagMatch = t.match(/flag\{[^}]{0,64}\}/i)
  if (!out.flagContract?.value && flagMatch) set('flagContract', { pattern: 'flag{...}', note: '题面样例' }, 0.7)
  return out
}