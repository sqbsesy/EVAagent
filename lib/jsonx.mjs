// 从模型回复里抠出一个 JSON 对象。模型常把 JSON 包在 ```json 里，也常带前后解释；
// 这里先试整段，再试围栏块（取最后一个可解析的），最后扫平衡花括号。
// 只做解析，不做 schema 校验。

function tryParse(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// 模型偶尔把 ASCII 标点写成全角（，、：；），这在 JSON 里直接是语法错。
function normalizePunct(text) {
  return text
    .replace(/[，、]/g, ',')
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/[“”]/g, '"')
}

function tryParseLoose(text) {
  const strict = tryParse(text)
  if (strict) return strict
  return tryParse(normalizePunct(text))
}

function balancedObjects(text) {
  const out = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          out.push(text.slice(start, i + 1))
          start = i
          break
        }
      }
    }
  }
  return out
}

export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null

  const whole = tryParseLoose(text.trim())
  if (whole) return whole

  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseLoose(fences[i][1].trim())
    if (parsed) return parsed
  }

  const candidates = balancedObjects(text)
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseLoose(candidates[i])
    if (parsed) return parsed
  }
  return null
}

/** 取字符串字段，缺失或类型不对时返回兜底值。 */
export function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** 取数组字段，元素保持原样。 */
export function arr(value) {
  return Array.isArray(value) ? value : []
}
