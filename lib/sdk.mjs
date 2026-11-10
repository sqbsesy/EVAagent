// DSH SDK 运行时的 JSON-RPC 桥。
// 协议与 work/eva-console/server/dsh-bridge.mjs 相同：
//   initialize → session/prompt（返回即受理）→ session/wait（turn 结束）
// 事件走 session.event 通知；sessionId 由调用方自取，运行时首次 prompt 时建会话。
//
// 每个 worker 一个进程（内存换隔离）；Supervisor 与 Verifier 共用一个进程、不同 session。
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_EXE = 'C:\\APP\\dsh\\DeepSeek Harness.exe'
export const DEFAULT_BIN = 'C:/APP/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

export class DshBridge {
  constructor(options = {}) {
    this.exe = options.exe ?? process.env.EVA_DSH_EXE ?? DEFAULT_EXE
    this.bin = options.bin ?? process.env.EVA_DSH_BIN ?? DEFAULT_BIN
    this.cwd = options.cwd
    this.provider = options.provider ?? process.env.EVA_DSH_PROVIDER ?? 'deepseek-account'
    this.model = options.model ?? process.env.EVA_DSH_MODEL ?? 'deepseek-flash'
    this.extraArgs = options.extraArgs ?? (process.env.EVA_DSH_PATCH ? ['--patch', process.env.EVA_DSH_PATCH] : [])
    this.logFile = options.logFile ?? null
    this.child = null
    this.ready = null
    this.nextId = 1
    this.pending = new Map()
    this.turns = new Map()
    this.up = false
    this.lastError = ''
  }

  log(...parts) {
    this.logEvent({ level: 'info', msg: parts.map(String).join(' ') })
  }

  logEvent(entry) {
    if (!this.logFile) return
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
      fs.appendFileSync(this.logFile, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`)
    } catch {
      /* ignore */
    }
  }

  async start() {
    if (this.ready) return this.ready
    this.ready = this.boot().catch((error) => {
      this.lastError = String(error?.message ?? error)
      this.ready = null
      throw error
    })
    return this.ready
  }

  boot() {
    return new Promise((resolve, reject) => {
      this.log('spawn', this.exe, this.bin, 'cwd=' + this.cwd)
      const child = spawn(this.exe, [this.bin, '--profile', 'sdk', ...this.extraArgs], {
        cwd: this.cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        this.lastError = String(error?.message ?? error)
        this.log('boot failed:', this.lastError)
        try {
          child.kill()
        } catch {}
        reject(error)
      }

      readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
      child.stderr.on('data', (data) => {
        const text = String(data).trim()
        if (text) {
          this.lastError = text.slice(0, 400)
          this.log('stderr', text.slice(0, 400))
        }
      })
      child.on('error', fail)
      child.on('exit', (code) => {
        this.log('exit', String(code))
        this.child = null
        this.ready = null
        this.up = false
        for (const [, entry] of this.pending) entry.reject(new Error('dsh runtime exited'))
        this.pending.clear()
        for (const [, turn] of this.turns) turn.finish({ error: `dsh runtime exited (code ${code})` })
        this.turns.clear()
        fail(new Error(`dsh runtime exited (code ${code})`))
      })

      this.call('initialize', { cwd: this.cwd, provider: this.provider, model: this.model }, 90000)
        .then(() => {
          if (settled) return
          settled = true
          this.up = true
          this.log('initialize ok')
          resolve({ ok: true })
        })
        .catch(fail)
    })
  }

  call(method, params, timeoutMs = 120000) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('dsh runtime is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  onLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message ?? 'json-rpc error'))
      else entry.resolve(message)
      return
    }
    if (message.method === 'session.event') {
      const { sessionId, event } = message.params ?? {}
      const turn = this.turns.get(sessionId)
      if (turn) turn.push(event)
      return
    }
    if (message.method === 'session.status') {
      const { sessionId, status } = message.params ?? {}
      const turn = this.turns.get(sessionId)
      if (turn && status === 'idle') turn.markIdle()
    }
  }

  /**
   * 跑一轮。返回 {text, tools, usage, error?}；usage 可能为 null（provider 不上报）。
   */
  async prompt(sessionId, text, options = {}) {
    await this.start()
    if (this.turns.has(sessionId)) throw new Error('this session is already running a turn')
    const timeoutMs = options.timeoutMs ?? 300000
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}

    return new Promise((resolve) => {
      const turn = {
        text: '',
        tools: [],
        toolChars: 0,
        usage: null,
        finished: false,
        promptAccepted: false,
        finish: (extra = {}) => {
          if (turn.finished) return
          turn.finished = true
          this.turns.delete(sessionId)
          clearTimeout(timer)
          if (extra.error) onEvent({ type: 'turn/error', data: { message: extra.error } })
          else onEvent({ type: 'turn/end', data: { usage: turn.usage } })
          resolve({ text: turn.text.trim(), tools: turn.tools, toolChars: turn.toolChars, usage: turn.usage, ...extra })
        },
        markIdle: () => {
          if (turn.promptAccepted) turn.finish()
        },
        push: (event) => {
          if (!event || typeof event.type !== 'string') return
          const data = event.data ?? {}
          if (/message/.test(event.type)) {
            const message = data.message ?? data
            const role = message?.role ?? data.role
            if (role === 'assistant') {
              const chunk = blocksText(message?.content ?? data.content)
              if (chunk) turn.text += chunk
            }
          }
          if (event.type === 'tool/call' || event.type === 'tool/call/begin') {
            const name = data.name ?? data.tool
            if (typeof name === 'string') turn.tools.push(name)
          }
          // 工具输出通常是 token 大户：没有 usage 时用它把估算拉回现实。
          if (/tool/.test(event.type) && /(result|end|output)/i.test(event.type)) {
            const out = data.output ?? data.result ?? data.content ?? data.text
            if (typeof out === 'string') turn.toolChars += out.length
            else if (out && typeof out === 'object') {
              try {
                turn.toolChars += JSON.stringify(out).length
              } catch {
                /* 不可序列化就不计 */
              }
            }
          }
          if (event.type === 'step/end' || event.type === 'turn/end') {
            const u = data.usage ?? data.tokens ?? null
            if (u) {
              const prev = turn.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
              const input = Number(u.inputTokens ?? u.prompt_tokens ?? u.input ?? 0) || 0
              const output = Number(u.outputTokens ?? u.completion_tokens ?? u.output ?? 0) || 0
              const total = Number(u.totalTokens ?? u.total_tokens ?? 0) || input + output
              turn.usage = {
                inputTokens: prev.inputTokens + input,
                outputTokens: prev.outputTokens + output,
                totalTokens: prev.totalTokens + total,
              }
            }
          }
          if (event.type === 'turn/end') {
            const reason = data.reason
            if (reason?.kind && reason.kind !== 'completed') {
              turn.finish({ error: reason.error?.message ?? reason.kind })
            } else {
              turn.finish()
            }
            return
          }
          onEvent({ type: event.type, data })
        },
      }
      this.turns.set(sessionId, turn)
      const timer = setTimeout(() => turn.finish({ error: `turn timed out after ${timeoutMs}ms` }), timeoutMs)
      const onAbort = () => turn.finish({ error: 'cancelled' })
      options.signal?.addEventListener('abort', onAbort, { once: true })

      this.call('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] }, 60000)
        .then((message) => {
          if (message.error) {
            turn.finish({ error: message.error.message ?? 'prompt rejected' })
            return
          }
          turn.promptAccepted = true
          return this.call('session/wait', { sessionId }, timeoutMs)
        })
        .then((message) => {
          if (!message) return
          if (message.error) turn.finish({ error: message.error.message ?? 'wait failed' })
          else turn.finish()
        })
        .catch((error) => turn.finish({ error: String(error?.message ?? error) }))
    })
  }

  async stop() {
    const child = this.child
    if (!child) return
    try {
      await this.call('shutdown', {}, 3000).catch(() => {})
    } catch {}
    setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, 1000)
    this.child = null
    this.ready = null
  }
}

/**
 * 离线替身：不拉起运行时、不烧 token，用于 --dry-run 与自检。
 * 按提示词里的角色标记返回合法 JSON，覆盖 recon / worker / verifier 三条路径。
 */
export class MockBridge {
  constructor(options = {}) {
    this.provider = 'mock'
    this.model = 'mock-deterministic'
    this.cwd = options.cwd
    this.calls = 0
    this.failWith = options.failWith ?? null
  }

  async start() {
    return { ok: true }
  }

  async prompt(sessionId, text, options = {}) {
    this.calls += 1
    if (this.failWith) return { text: '', usage: null, toolChars: 0, error: this.failWith }
    const usage = { inputTokens: 800, outputTokens: 260, totalTokens: 1060 }
    let body
    if (text.includes('## 角色契约') && text.includes('侦察')) {
      body = {
        category: 'misc',
        difficulty: 'easy',
        entry: '附件',
        attachments: ['sample.bin'],
        hypotheses: [
          {
            id: 't1',
            goal: '确认附件容器类型并提取可见字符串',
            deliverable: 'super/t1/strings.txt',
            acceptance: '输出文件存在且包含至少 10 条 >= 6 字符的可见串',
          },
        ],
        notes: 'mock recon',
      }
    } else if (text.includes('## 你的任务')) {
      body = {
        taskId: 't1',
        hypothesis: '附件是普通容器',
        finding: 'mock finding',
        candidate: 'MOCK{not_a_real_flag}',
        evidence: [{ path: 'super/t1/strings.txt', line: 1, cmd: 'node test/selftest.mjs' }],
        confidence: 0.9,
        next: '',
      }
    } else {
      body = {
        candidate: 'MOCK{not_a_real_flag}',
        verdict: 'pass',
        reasons: ['mock verifier'],
        replay: { cmd: 'node test/selftest.mjs', exit: 0 },
        checkedAt: new Date().toISOString(),
      }
    }
    options.onEvent?.({ type: 'turn/start' })
    return { text: `\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``, tools: [], usage }
  }

  async stop() {}
}