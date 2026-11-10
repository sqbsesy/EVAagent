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

/** 创建题目下的 super/<taskId>/ 工作目录，返回相对路径与绝对路径。 */
export function ensureTaskDir(challengeDir, taskId) {
  const rel = path.posix.join('super', taskId)
  const abs = path.join(challengeDir, 'super', taskId)
  fs.mkdirSync(abs, { recursive: true })
  return { rel, abs }
}