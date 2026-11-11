import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIR = new Set(['.git', 'node_modules', 'super', '__pycache__', '.venv', 'venv', 'dist'])

/** 从任意目录向上找 EVA 工作区（以 `_tools/eva/toolgate.mjs` 为标记）。 */
export function findWorkspace(from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(dir, '_tools', 'eva', 'toolgate.mjs'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(from)
}

/** `--challenge` 既可以是路径，也可以是 work/ 下的目录名。 */
export function resolveChallenge(workspace, arg) {
  if (!arg) return null
  const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
  const direct = path.resolve(arg)
  if (isDir(direct)) return direct
  // workspace 相对路径：`work/<题名>` 或仅 `<题名>`
  const fromWorkspace = path.resolve(workspace, arg)
  if (isDir(fromWorkspace)) return fromWorkspace
  const underWork = path.join(workspace, 'work', arg)
  if (isDir(underWork)) return underWork
  return null
}

/** 给模型看的文件清单：相对路径 + 字节数，目录只列一层。 */
export function listFiles(dir, { limit = 150, maxBytes = 8 * 1024 * 1024 } = {}) {
  const rows = []
  const walk = (current) => {
    if (rows.length >= limit) return
    let names
    try {
      names = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    names.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of names) {
      if (rows.length >= limit) return
      if (entry.name.startsWith('.') || SKIP_DIR.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        rows.push({ path: `${path.relative(dir, full)}/`, bytes: null, dir: true })
        walk(full)
      } else if (entry.isFile()) {
        let bytes = 0
        try {
          bytes = fs.statSync(full).size
        } catch {}
        if (bytes > maxBytes) {
          rows.push({ path: path.relative(dir, full), bytes, dir: false, note: 'oversized' })
        } else {
          rows.push({ path: path.relative(dir, full), bytes, dir: false })
        }
      }
    }
  }
  walk(dir)
  return rows
}

export function renderFileList(rows) {
  if (!rows.length) return '（空目录）'
  return rows
    .map((row) => {
      if (row.dir) return `- ${row.path}/`
      const size = row.bytes === null ? '' : ` (${row.bytes} B${row.note ? ', oversized' : ''})`
      return `- ${row.path}${size}`
    })
    .join('\n')
}

/** 创建 <baseDir>/<taskId>/ 工作目录，返回相对路径（相对 baseDir）与绝对路径。 */
export function ensureTaskDir(baseDir, taskId) {
  const abs = path.join(baseDir, taskId)
  fs.mkdirSync(abs, { recursive: true })
  return { rel: path.posix.join(path.basename(baseDir), taskId), abs }
}

const PROBE_EXT = /\.(py|sh|mjs|js)$/i
const PROBE_HEAD = 160

/**
 * 预置探针：题目目录里已经调好的解析脚本（probes/ 下的脚本，或顶层的 probe.py / extract*.py）。
 * worker 直接调用，不要每轮重新发明解析器。
 */
export function findProbes(challengeDir, { limit = 12 } = {}) {
  const rows = []
  const add = (full, rel) => {
    if (rows.length >= limit) return
    let bytes = 0
    let head = ''
    try {
      const st = fs.statSync(full)
      if (!st.isFile() || st.size > 256 * 1024) return
      bytes = st.size
      // 只取第一段有意义的文本：给模型一个「这脚本干什么」的钩子，不把源码塞进提示词。
      const text = fs.readFileSync(full, 'utf8')
      const line = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('//'))
      head = (line ?? '').slice(0, PROBE_HEAD)
    } catch {
      return
    }
    rows.push({ path: rel.split(path.sep).join('/'), bytes, head })
  }

  const probeDir = path.join(challengeDir, 'probes')
  if (fs.existsSync(probeDir)) {
    const walk = (dir, depth) => {
      if (depth > 2 || rows.length >= limit) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (rows.length >= limit) return
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (entry.isFile() && PROBE_EXT.test(entry.name)) add(full, path.relative(challengeDir, full))
      }
    }
    walk(probeDir, 0)
  }

  // 兼容旧约定：直接摊在题目根目录的探针。
  try {
    for (const entry of fs.readdirSync(challengeDir, { withFileTypes: true })) {
      if (entry.isFile() && /^(probe|extract)[\w.-]*\.(py|sh)$/i.test(entry.name)) {
        add(path.join(challengeDir, entry.name), entry.name)
      }
    }
  } catch {}

  return rows
}

export function renderProbes(rows) {
  if (!rows.length) return ''
  return rows.map((r) => `- ${r.path} (${r.bytes} B)${r.head ? ` — 首行：${r.head}` : ''}`).join('\n')
}