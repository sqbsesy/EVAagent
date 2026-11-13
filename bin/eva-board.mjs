#!/usr/bin/env node
// D1：只读赛程看板。只读 runs/race-*/，不参与调度、不写任何文件。
// 六块：题池 / 在跑 / 待确认 / 预算 / 环境 / 告警。页面 5 s 自动刷新（≤10 s）。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--runs') out.runs = argv[++i]
    else if (a === '--race') out.race = argv[++i]
    else if (a === '--snapshot') out.snapshot = true
    else if (a === '--help') out.help = true
  }
  return out
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readTail(file, maxLines = 30) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
    return lines.slice(-maxLines).map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { raw: l.slice(0, 200) }
      }
    })
  } catch {
    return []
  }
}

function findRaces(runsDir) {
  try {
    return fs.readdirSync(runsDir)
      .filter((d) => d.startsWith('race-') && fs.statSync(path.join(runsDir, d)).isDirectory())
      .map((d) => path.join(runsDir, d))
      .sort()
  } catch {
    return []
  }
}

function buildSnapshot({ runsDir, race = null }) {
  const dirs = race ? [path.join(runsDir, race)] : findRaces(runsDir)
  const races = dirs.map((dir) => {
    const pool = readJson(path.join(dir, 'pool.json'))
    const state = readJson(path.join(dir, 'state.json'))
    const events = readTail(path.join(dir, 'events.jsonl'), 40)
    const leaseFile = path.join(dir, 'env.lease')
    const lease = readJson(leaseFile)
    const items = pool?.challenges ?? []
    const running = items.filter((c) => c.status === 'running')
    const waiting = items.filter((c) => c.status === 'waiting_confirm')
    const queued = items.filter((c) => c.status === 'queued')
    const spent = items.reduce((s, c) => s + (Number(c.spent) || 0), 0)
    const alerts = events.filter((e) => /failure\/classified|race\/requeue|budget-stop|fatal/.test(String(e.type)))
    return {
      raceId: path.basename(dir),
      updatedAt: pool?.updatedAt ?? null,
      pool: items.map((c) => ({ id: c.id, title: c.title, status: c.status, score: c.score, difficulty: c.difficulty, spent: c.spent })),
      running: running.map((c) => ({ id: c.id, runId: c.runId, note: c.note })),
      waiting: waiting.map((c) => ({ id: c.id, runId: c.runId, spent: c.spent })),
      budget: { spent, starting: items.length * 2500000, left: Math.max(0, items.length * 2500000 - spent) },
      lease: lease ? { holder: lease.holder, challenge: lease.challenge, expiresAt: new Date(lease.expiresAt).toISOString(), expired: lease.expiresAt <= Date.now() } : null,
      alerts: alerts.map((e) => ({ ts: e.ts, type: e.type, id: e.id ?? '', detail: e.class ?? e.why ?? e.reason ?? '' })),
      queued: queued.map((c) => ({ id: c.id, density: null })),
      checkpointed: state?.challenges ? Object.keys(state.challenges).length : 0,
    }
  })
  return { at: new Date().toISOString(), runsDir, races }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function renderHtml(snapshot) {
  const race = snapshot.races[snapshot.races.length - 1]
  if (!race) {
    return '<!doctype html><meta charset="utf-8"><title>EVA race board</title><p>没有找到 runs/race-*/，先跑一次 <code>eva-race</code>。</p>'
  }
  const row = (c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.title)}</td><td>${esc(c.status)}</td><td>${esc(c.difficulty)}</td><td>${esc(c.spent)}</td></tr>`
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>EVA race board — ${esc(race.raceId)}</title>
<style>
 body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:24px;color:#111;background:#fafafa}
 h1{font-size:18px;margin:0 0 4px} .muted{color:#666;font-size:12px}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}
 .card{background:#fff;border:1px solid #e3e3e3;border-radius:8px;padding:12px}
 .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#666;margin:0 0 8px}
 table{border-collapse:collapse;width:100%;font-size:13px} td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left}
 .tag{display:inline-block;padding:1px 6px;border-radius:10px;background:#eef;font-size:12px}
 .warn{color:#b45309} .ok{color:#047857}
</style>
<h1>EVA 赛程看板 <span class="muted">只读 · 5 s 刷新</span></h1>
<div class="muted">赛程 ${esc(race.raceId)} · 更新 ${esc(race.updatedAt ?? '—')} · 对账 ${race.checkpointed} 题</div>
<div class="grid">
  <div class="card"><h2>题池</h2><table><tr><th>题</th><th>标题</th><th>状态</th><th>难度</th><th>已花</th></tr>${race.pool.map(row).join('')}</table></div>
  <div class="card"><h2>在跑</h2>${race.running.length ? `<ul>${race.running.map((r) => `<li>${esc(r.id)} <span class="tag">${esc(r.runId ?? 'run')}</span></li>`).join('')}</ul>` : '<p class="muted">无</p>'}</div>
  <div class="card"><h2>待确认</h2>${race.waiting.length ? `<ul>${race.waiting.map((r) => `<li>${esc(r.id)} · ${esc(r.spent)} tok</li>`).join('')}</ul>` : '<p class="muted">无</p>'}</div>
  <div class="card"><h2>预算</h2><p>已花 <b>${esc(race.budget.spent)}</b> tok<br>起算 ${esc(race.budget.starting)}<br>剩余 ${esc(race.budget.left)}</p></div>
  <div class="card"><h2>环境租约</h2>${race.lease ? `<p>${esc(race.lease.holder)} 持有 ${esc(race.lease.challenge)}<br>到期 ${esc(race.lease.expiresAt)} ${race.lease.expired ? '<span class="warn">已过期</span>' : '<span class="ok">有效</span>'}</p>` : '<p class="muted">无租约</p>'}</div>
  <div class="card"><h2>告警</h2>${race.alerts.length ? `<ul>${race.alerts.slice(-8).map((a) => `<li>${esc(a.ts)} ${esc(a.type)} ${esc(a.id)} ${esc(a.detail)}</li>`).join('')}</ul>` : '<p class="muted">无</p>'}</div>
</div>`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('eva-board --port 8899 --runs <runs 目录> [--race <raceId>] [--snapshot]')
    return 0
  }
  const runsDir = path.resolve(args.runs || path.join(ROOT, 'runs'))
  if (args.snapshot) {
    console.log(JSON.stringify(buildSnapshot({ runsDir, race: args.race }), null, 2))
    return 0
  }
  const port = args.port || 8899
  const server = http.createServer((req, res) => {
    const snapshot = buildSnapshot({ runsDir, race: args.race })
    if (req.url?.startsWith('/api/race')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(snapshot))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(renderHtml(snapshot))
  })
  server.listen(port, '127.0.0.1', () => console.log(`eva-board: http://127.0.0.1:${port} (read-only, runs=${runsDir})`))
  return 0
}

main().then((code) => {
  if (code) process.exit(code)
}).catch((error) => {
  console.error(`eva-board: ${error?.stack ?? error}`)
  process.exit(2)
})