#!/usr/bin/env node
// 离线自检：不拉起运行时、不烧 token。
// 覆盖 JSON 抽取、预算闸、提示词拼装、以及 mock 全链路（含产物断言）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractJson } from '../lib/jsonx.mjs'
import { Ledger, BudgetStop } from '../lib/ledger.mjs'
import { composeRecon, composeWorker } from '../lib/prompts.mjs'
import { orchestrate, orderStages, stageSeconds } from '../lib/run.mjs'
import { MockBridge } from '../lib/sdk.mjs'
import { listFiles, renderFileList, resolveChallenge, findProbes, renderProbes } from '../lib/context.mjs'
import { effectiveRunBudget, spentFromRuns, admitTurn } from '../lib/budget.mjs'
import { makeChallenge, fillRate, missingFields, inferFromText } from '../lib/challenge.mjs'
import { acquire, heartbeat, release, reclaimExpired, peek } from '../lib/env-lease.mjs'
import { normalizePool, orderQueue, decideMode, transition, pickStartable, recordCheckpoint, reconcileCheckpoints, nextActionFor,
  raceBudget, pressureSample, parallelFromSamples, shouldBreak,
  strategyFingerprint, recentFingerprint, recordFingerprint,
  pickSkills, priorDifficulty, combineDifficulty, difficultyAgreement,
  alertLevel, shouldEmitAlert } from '../lib/schedule.mjs'
import { check, startWatchdog } from '../lib/health.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}

await test('extractJson：整段 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

await test('extractJson：围栏 + 前后解释', () => {
  const text = '先说明一下。\n```json\n{"verdict":"pass","reasons":["ok"]}\n```\n以上。'
  assert.equal(extractJson(text).verdict, 'pass')
})

await test('extractJson：全角标点自动纠正', () => {
  const text = '{"category":"crypto"、"difficulty":"easy"，"notes":"x：y"}'
  const value = extractJson(text)
  assert.equal(value.category, 'crypto')
  assert.equal(value.difficulty, 'easy')
})

await test('extractJson：裸花括号、含转义引号', () => {
  const text = '结果：{"flag":"a\\"b","nested":{"x":[1,2]}} 完'
  const value = extractJson(text)
  assert.equal(value.flag, 'a"b')
  assert.deepEqual(value.nested.x, [1, 2])
})

await test('extractJson：无 JSON 返回 null', () => {
  assert.equal(extractJson('没有结构化输出'), null)
})

await test('Ledger：累计、估算标记、超预算置位', () => {
  const ledger = new Ledger({ budget: 100, convergeAt: 0.5 })
  ledger.add({ role: 'supervisor', tokens: 30 })
  ledger.addEstimate({ role: 'worker', prompt: 'x'.repeat(70), reply: '' })
  assert.equal(ledger.total, 50)
  assert.equal(ledger.estimatedTotal, 20)
  assert.equal(ledger.shouldConverge(), true)
  ledger.add({ role: 'worker', tokens: 60 })
  assert.throws(() => ledger.check('worker'), BudgetStop)
  assert.equal(ledger.stopped, 'budget-exhausted')
})

await test('budget：effectiveRunBudget 取小并扣历史', () => {
  assert.deepEqual(effectiveRunBudget({ perRunTokens: 1000, perChallengeTokens: 0, priorSpent: 500 }), {
    budget: 1000,
    priorSpent: 500,
    remaining: null,
  })
  assert.equal(effectiveRunBudget({ perRunTokens: 1000, perChallengeTokens: 3000, priorSpent: 2500 }).budget, 500)
  assert.equal(effectiveRunBudget({ perRunTokens: 1000, perChallengeTokens: 3000, priorSpent: 4000 }).budget, 0)
})

await test('budget：从 runs 台账聚合单题历史', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-budget-'))
  for (const [name, challenge, spent] of [
    ['20261110000000-aaaaaa', 'easycap', 1200],
    ['20261110000001-bbbbbb', 'easycap', 800],
    ['20261110000002-cccccc', 'other', 9999],
  ]) {
    const dir = path.join(out, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ challenge }))
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ spent }))
  }
  assert.equal(spentFromRuns(out, 'easycap').total, 2000)
  assert.equal(spentFromRuns(out, 'easycap', { excludeRunId: '20261110000000-aaaaaa' }).total, 800)
  fs.rmSync(out, { recursive: true, force: true })
})

await test('Ledger：估算放大与 raw 记录', () => {
  const ledger = new Ledger({ budget: 1000 })
  ledger.addEstimate({ role: 'worker', prompt: 'x'.repeat(70), reply: '', toolChars: 35, multiplier: 1.5 })
  // 70+35=105 字符 → 30 raw，放大 1.5 → 45
  assert.equal(ledger.total, 45)
  assert.equal(ledger.estimatedTotal, 45)
  assert.equal(ledger.entries[0].raw, 30)
})

await test('Ledger：prior 只进汇报，不重复计入硬闸', () => {
  const ledger = new Ledger({ budget: 100, convergeAt: 0.5, priorSpent: 60 })
  ledger.add({ role: 'worker', tokens: 10 })
  assert.equal(ledger.total, 10)
  assert.equal(ledger.effectiveTotal, 70)
  assert.equal(ledger.shouldConverge(), false)
  ledger.add({ role: 'worker', tokens: 95 })
  assert.throws(() => ledger.check('worker'), BudgetStop)
})

await test('composeWorker：含任务字段与输出契约', () => {
  const prompt = composeWorker({
    task: { id: 't1', goal: 'G', deliverable: 'D', acceptance: 'A' },
    surface: { category: 'misc', entry: 'E', notes: 'N' },
    challengeName: 'demo',
    challengeDir: 'C:/demo',
    taskDir: 'C:/demo/super/t1',
    workspace: 'C:/ws',
    budget: 400000,
  })
  for (const needle of ['t1', 'G', 'D', 'A', '"confidence"', 'toolgate.mjs']) {
    assert.ok(prompt.includes(needle), `缺少 ${needle}`)
  }
})

await test('listFiles：跳过 .git/node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-list-'))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.writeFileSync(path.join(dir, 'a.bin'), 'x')
  const rows = listFiles(dir)
  assert.deepEqual(rows.map((r) => r.path), ['a.bin'])
  assert.match(renderFileList(rows), /a\.bin \(1 B\)/)
})

await test('resolveChallenge：裸名 / work 前缀 / 绝对路径', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-ws-'))
  const dir = path.join(ws, 'work', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(resolveChallenge(ws, 'demo'), dir)
  assert.equal(resolveChallenge(ws, path.join('work', 'demo')), dir)
  assert.equal(resolveChallenge(ws, dir), dir)
  assert.equal(resolveChallenge(ws, 'nope'), null)
})

await test('orchestrate：工单模式把 task 写进提示词与报告', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-task-'))
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs-'))
  const result = await orchestrate({
    workspace: dir,
    challengeDir: dir,
    outRoot,
    taskText: '把附件归类并给出证据',
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 1, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 1 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge(),
    dryRun: true,
    logger: () => {},
  })
  const report = fs.readFileSync(path.join(result.runDir, 'report.md'), 'utf8')
  assert.match(report, /工单：把附件归类并给出证据/)
  const reconTurn = fs.readFileSync(path.join(result.runDir, 'turns', '01-supervisor-recon.md'), 'utf8')
  assert.match(reconTurn, /任务描述（来自工单/)
})

await test('orchestrate：dry-run 全链路产出与判定', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal-'))
  fs.writeFileSync(path.join(challenge, 'sample.bin'), 'MOCK')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 2, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 2 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge(),
    dryRun: true,
    logger: () => {},
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'verified')
  assert.equal(result.verdict.verdict, 'pass')
  for (const name of ['meta.json', 'plan.json', 'state.json', 'events.jsonl', 'ledger.json', 'verdict.json', 'result.json', 'report.md']) {
    assert.ok(fs.existsSync(path.join(result.runDir, name)), `缺少 ${name}`)
  }
  assert.ok(fs.existsSync(path.join(result.runDir, 'submissions', 'pending.json')))
  assert.ok(fs.existsSync(path.join(result.runDir, 'super', 't1', 'finding.json')))
  assert.ok(result.spent > 0)
})

await test('orchestrate：预算不足时触发硬闸并写 partial', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal2-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'x')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs2-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 500, convergeAt: 0.6, workerMax: 2, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 2 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge(),
    dryRun: true,
    logger: () => {},
  })
  assert.equal(result.status, 'partial')
  assert.equal(result.verdict.verdict, 'reject')
  assert.ok(result.verdict.reasons.join(' ').includes('预算闸'))
})

await test('orchestrate：账号级错误整条中止为 config-error', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal3-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'x')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs3-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 2, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 2 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge({ failWith: 'Insufficient Balance (request_id: test)' }),
    dryRun: false,
    logger: () => {},
  })
  assert.equal(result.status, 'config-error')
  assert.equal(result.exitCode, 3)
  assert.match(result.verdict.reasons.join(' '), /Insufficient Balance/)
  // 不能降级成单线任务继续跑
  assert.ok(!fs.existsSync(path.join(challenge, 'super', 't1')))
})

await test('orchestrate：候选文件落盘后成为待提交候选', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal4-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'x')
  fs.mkdirSync(path.join(challenge, 'super', 't1'), { recursive: true })
  fs.writeFileSync(path.join(challenge, 'super', 't1', 'candidate.txt'), 'FLAG:test-only\n')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs4-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 1, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 1 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () =>
      new MockBridge({ finding: { candidate: '', candidateFile: 'super/t1/candidate.txt', confidence: 0.95 } }),
    dryRun: true,
    logger: () => {},
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.verdict.candidate, 'file:super/t1/candidate.txt')
  const pending = JSON.parse(fs.readFileSync(path.join(result.runDir, 'submissions', 'pending.json'), 'utf8'))
  assert.equal(pending.candidateFile, 'super/t1/candidate.txt')
})

await test('orchestrate：候选文件越界或二进制被拒', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal5-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'x')
  fs.writeFileSync(path.join(challenge, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs5-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 1, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 1 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge({ finding: { candidate: '', candidateFile: '../../outside.txt', confidence: 0.9 } }),
    dryRun: true,
    logger: () => {},
  })
  assert.equal(result.verdict.candidate, '')
  assert.equal(result.status, 'failed')
})

await test('orchestrate：worker 不认答案时兜底扫描成候选', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal6-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'x')
  fs.mkdirSync(path.join(challenge, 'super', 't1'), { recursive: true })
  fs.writeFileSync(path.join(challenge, 'super', 't1', 'raw.bin'), 'FLAG:scan-only-123\n')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs6-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 1, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 1 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge({ finding: { candidate: '', candidateFile: '', confidence: 0.9 } }),
    dryRun: true,
    logger: () => {},
  })
  assert.match(result.verdict.candidate, /^file:.*super\/_candidate\.txt$/)
  const relCandidate = result.verdict.candidate.replace(/^file:/, '')
  assert.match(fs.readFileSync(path.join(challenge, relCandidate), 'utf8'), /FLAG:scan-only-123/)
})

await test('orchestrate：JSON 产物里的人读明文也能被兜底扫描认领', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal7-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'x')
  fs.mkdirSync(path.join(challenge, 'super', 't2'), { recursive: true })
  fs.writeFileSync(
    path.join(challenge, 'super', 't2', 'candidates.json'),
    JSON.stringify({ best: { inner_text: 'f1nd_th3_hidden_key_0123456789' } }),
  )
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs7-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 1, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 1 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge({ finding: { candidate: '', candidateFile: '', confidence: 0.9 } }),
    dryRun: true,
    logger: () => {},
  })
  const relCandidate = result.verdict.candidate.replace(/^file:/, '')
  assert.match(fs.readFileSync(path.join(challenge, relCandidate), 'utf8'), /f1nd_th3_hidden_key_0123456789/)
})

await test('orchestrate：--scaffold 先产出脚手架再派活', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-chal8-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'MOCK')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs8-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 50000, convergeAt: 0.6, workerMax: 1, workerTokens: 4000, turnWallClockSec: 30, maxRounds: 1, scaffold: true },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge(),
    dryRun: true,
    logger: () => {},
  })
  assert.ok(fs.existsSync(path.join(result.runDir, 'scaffold', 'README.md')))
  assert.ok(fs.existsSync(path.join(result.runDir, 'turns', '02-supervisor-scaffold.md')))
  const events = fs.readFileSync(path.join(result.runDir, 'events.jsonl'), 'utf8')
  assert.match(events, /"type":"scaffold\/ready"/)
})

await test('budget：admitTurn 按阶段数预留', () => {
  // 剩余 1,000,000、3 段、预留 20% → 每段可用 266,666；roleCap 400k 不生效
  const a = admitTurn({ remaining: 1000000, stagesLeft: 3, roleCap: 400000, reserveShare: 0.2 })
  assert.equal(a.ok, true)
  assert.equal(a.cap, 266666)
  assert.ok(a.reserve > 500000)
  // roleCap 比 perStage 小时取 roleCap
  assert.equal(admitTurn({ remaining: 3000000, stagesLeft: 2, roleCap: 300000 }).cap, 300000)
  // 剩余不足 minReserve → 不准起跑
  assert.equal(admitTurn({ remaining: 15000, stagesLeft: 1 }).ok, false)
})

await test('orderStages：按 dependsOn 排序，环/悬空引用判非法', () => {
  const order = orderStages([
    { id: 't1' },
    { id: 't2', dependsOn: ['t1'] },
    { id: 't3', dependsOn: ['t2'] },
  ])
  assert.deepEqual(order.map((t) => t.id), ['t1', 't2', 't3'])
  assert.equal(orderStages([{ id: 't1', dependsOn: ['t2'] }, { id: 't2', dependsOn: ['t1'] }]), null)
  assert.equal(orderStages([{ id: 't1', dependsOn: ['nope'] }]), null)
})

await test('findProbes：probes/ 与根目录探针都能被识别并注入提示词', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-probes-'))
  fs.mkdirSync(path.join(dir, 'probes'))
  fs.writeFileSync(path.join(dir, 'probes', 'extract_names.py'), '#!/usr/bin/env python3\n"""提取 EIR 设备名"""\nprint(1)\n')
  fs.writeFileSync(path.join(dir, 'probe.sh'), 'set -e\necho hi\n')
  const rows = findProbes(dir)
  assert.deepEqual(rows.map((r) => r.path).sort(), ['probe.sh', 'probes/extract_names.py'])
  const text = renderProbes(rows)
  assert.match(text, /probes\/extract_names\.py/)
  const prompt = composeWorker({
    task: { id: 't1', goal: 'g', acceptance: 'a' },
    surface: { category: 'forensics', difficulty: 'medium', entry: 'e', notes: '' },
    challengeName: 'x', challengeDir: dir, taskDir: dir, workspace: dir, budget: 1000,
    probes: text,
  })
  assert.match(prompt, /预置脚本/)
  assert.match(prompt, /禁止重写/)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('orchestrate：串行阶段缺产物时跳过后续依赖任务', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-stage-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'MOCK')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs-stage-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 200000, convergeAt: 0.6, workerMax: 2, workerTokens: 40000, turnWallClockSec: 30, maxRounds: 1, staged: true, stagedTurnSec: 30 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () =>
      new MockBridge({
        finding: { candidate: '', candidateFile: '', finding: '阶段结论', confidence: 0.6 },
        surface: {
          category: 'forensics',
          difficulty: 'medium',
          entry: 'pcap',
          attachments: ['a.bin'],
          hypotheses: [
            { id: 't1', goal: '提取名字', deliverable: 'names.json', acceptance: '有文件', artifact: 'names.json' },
            { id: 't2', goal: '解压', deliverable: 'flag.txt', acceptance: '有 flag', artifact: 'flag.txt', dependsOn: ['t1'] },
          ],
          notes: '',
        },
      }),
    dryRun: true,
    logger: () => {},
  })
  const events = fs.readFileSync(path.join(result.runDir, 'events.jsonl'), 'utf8')
  assert.match(events, /"type":"stage\/missing"/)
  assert.match(events, /"type":"stage\/skipped"/)
  // t2 不应起跑：只有 recon、t1 两轮（verifier 无候选会被跳过）
  const turns = fs.readdirSync(path.join(result.runDir, 'turns'))
  assert.equal(turns.length, 2)
  fs.rmSync(challenge, { recursive: true, force: true })
  fs.rmSync(outRoot, { recursive: true, force: true })
})

await test('orchestrate：串行阶段单任务可跑通全链路', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-stage2-'))
  fs.writeFileSync(path.join(challenge, 'a.bin'), 'MOCK')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runs-stage2-'))
  const result = await orchestrate({
    workspace: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 200000, convergeAt: 0.6, workerMax: 1, workerTokens: 40000, turnWallClockSec: 30, maxRounds: 1, staged: true, stagedTurnSec: 30 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge(),
    dryRun: true,
    logger: () => {},
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.staged, true)
  fs.rmSync(challenge, { recursive: true, force: true })
  fs.rmSync(outRoot, { recursive: true, force: true })
})

await test('提示词：--notes 前情同时注入 recon 与 worker', async () => {
  const recon = composeRecon({
    challengeName: 'x', challengeDir: 'd', files: 'f', budget: 1000, hint: 'PRIOR_KNOWLEDGE_42',
  })
  assert.ok(recon.includes('PRIOR_KNOWLEDGE_42'), 'recon prompt should carry hint')
  assert.ok(recon.includes('前情'), 'recon prompt should label hint section')
  const worker = composeWorker({
    task: { id: 't1', goal: 'g', acceptance: 'a' },
    surface: { category: 'misc', difficulty: 'easy', entry: 'e', notes: '' },
    challengeName: 'x', challengeDir: 'd', taskDir: 'td', workspace: 'w', budget: 1000,
    hint: 'PRIOR_KNOWLEDGE_42',
  })
  assert.ok(worker.includes('PRIOR_KNOWLEDGE_42'), 'worker prompt should carry hint')
})

await test('stageSeconds：按段声明取墙钟，缺省用全局值并被 1200 封顶', () => {
  assert.equal(stageSeconds({ maxSeconds: 900 }, 600), 900)
  assert.equal(stageSeconds({ maxSeconds: 0 }, 600), 600)
  assert.equal(stageSeconds({}, 600), 600)
  assert.equal(stageSeconds({ maxSeconds: 5000 }, 600), 1200)
  assert.equal(stageSeconds({ maxSeconds: 10 }, 600), 60)
})

await test('B1 challenge: 缺失字段为 null 且带来源，推断不猜', () => {
  const c = makeChallenge({ id: 'A-1', title: 'demo', category: 'web', score: 300 }, { source: 'api' })
  assert.equal(c.id.value, 'A-1')
  assert.equal(c.id.source, 'api')
  assert.equal(c.difficulty.value, null)
  assert.equal(c.difficulty.source, 'unknown')
  assert.ok(missingFields(c).includes('difficulty'))
  const inferred = inferFromText('附件是一个 pcapng 抓包，flag{...}', c)
  assert.equal(inferred.category.value, 'web') // existing value wins
  const rate = fillRate(c)
  assert.ok(rate.rate > 0 && rate.rate < 1)
})

await test('A3 env-lease: 抢占/续租/释放/过期回收', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-lease-'))
  const file = path.join(dir, 'env.lease')
  assert.equal(acquire({ file, holder: 'run-a', challenge: 'c1', ttlMs: 50 }).ok, true)
  const b = acquire({ file, holder: 'run-b', challenge: 'c1', ttlMs: 50 })
  assert.equal(b.ok, false)
  assert.equal(b.holder, 'run-a')
  assert.equal(heartbeat({ file, holder: 'run-b', ttlMs: 50 }).ok, false)
  assert.equal(heartbeat({ file, holder: 'run-a', ttlMs: 50 }).ok, true)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80)
  let destroyed = null
  const reclaimed = reclaimExpired({ file, destroy: (l) => { destroyed = l.holder } })
  assert.equal(reclaimed.reclaimed.holder, 'run-a')
  assert.equal(destroyed, 'run-a')
  assert.equal(acquire({ file, holder: 'run-b', challenge: 'c1', ttlMs: 1000 }).ok, true)
  assert.equal(release({ file, holder: 'run-b', destroy: () => {} }).released, true)
  assert.equal(peek({ file }), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('A1/A2/A4 schedule: 排序、双模、并行槽位、状态机', () => {
  const pool = normalizePool({
    raceId: 'r1',
    challenges: [
      { id: 'slow', score: 500, difficulty: 'hard', category: 'forensics' },
      { id: 'fast', score: 100, difficulty: 'easy', category: 'misc' },
      { id: 'web', score: 200, difficulty: 'easy', category: 'web' },
    ],
  })
  const order = orderQueue(pool)
  assert.equal(order[0].id, 'web')
  assert.equal(decideMode(pool.challenges[2]), 'solo')
  assert.equal(decideMode({ ...pool.challenges[2], category: 'pwn', isContainer: true }), 'supervisor')
  assert.equal(pickStartable(pool, { maxParallel: 2 }).length, 2)
  assert.equal(transition(pool, 'fast', 'done'), null)
  assert.equal(transition(pool, 'fast', 'running').to, 'running')
  assert.equal(transition(pool, 'fast', 'queued').to, 'queued')
  assert.equal(nextActionFor('no-candidate', 2), 'change-strategy')
})

await test('C2 schedule: 产物哈希对账发现篡改', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-ckpt-'))
  const art = path.join(dir, 'a.json')
  fs.writeFileSync(art, '{"x":1}')
  const state = { challenges: {} }
  recordCheckpoint(state, 'c1', { stage: 1, artifacts: [art], spentDelta: 100 })
  assert.equal(reconcileCheckpoints(state)[0].ok, true)
  fs.writeFileSync(art, '{"x":2}')
  assert.equal(reconcileCheckpoints(state)[0].ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('D2 health: 端口不通即失败', async () => {
  const r = await check({ consolePort: 1, staleEventMs: 1000 })
  assert.equal(r.ok, false)
  assert.ok(r.items.some((i) => i.name === 'console' && i.ok === false))
})

await test('B4 计划硬校验：缺 artifact/acceptance 拒整份并降级单线', async () => {
  const challenge = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-b4-c-'))
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-b4-o-'))
  fs.writeFileSync(path.join(challenge, 'readme.txt'), 'hello')
  const result = await orchestrate({
    challengeName: challenge,
    challengeDir: challenge,
    outRoot,
    budgetConfig: { perRunTokens: 100000, workerMax: 1, turnWallClockSec: 60, convergeAt: 0.6, stagedTurnSec: 60 },
    submitPolicy: { mode: 'manual' },
    bridgeFactory: () => new MockBridge({ surface: { category: 'misc', difficulty: 'easy', entry: 'readme.txt', hypotheses: [{ id: 't1', goal: 'g', deliverable: 'd' }] } }),
    dryRun: true,
    staged: true,
    logger: () => {},
  })
  const events = fs.readFileSync(path.join(result.runDir, 'events.jsonl'), 'utf8')
  assert.ok(events.includes('plan/rejected'), 'should emit plan/rejected')
  assert.ok(events.includes('plan/degraded'), 'should degrade after second rejection')
  fs.rmSync(challenge, { recursive: true, force: true })
  fs.rmSync(outRoot, { recursive: true, force: true })
})

await test('A5 预算池：题数×单题×0.7，留 10% 机动，单题上限不超计划额', async () => {
  const pool = normalizePool({ challenges: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] })
  const b = raceBudget(pool, { defaultBudgetTokens: 2500000, budgetShare: 0.7, budgetReserveShare: 0.1 })
  assert.equal(b.count, 4)
  assert.equal(b.gross, 10000000)
  assert.equal(b.planned, 7000000)
  assert.equal(b.reserve, 700000)
  assert.ok(b.hardCap <= 2500000)
  assert.ok(b.hardCap >= 1)
})

await test('C1 并发：三次采样取最小档，压力高则降到 1', async () => {
  assert.equal(parallelFromSamples([], { parallelMin: 1, parallelMax: 3 }), 3)
  assert.equal(parallelFromSamples([0.2, 0.3, 0.1], { parallelMin: 1, parallelMax: 3 }), 3)
  assert.equal(parallelFromSamples([0.2, 0.6, 0.3], { parallelMin: 1, parallelMax: 3 }), 2)
  assert.equal(parallelFromSamples([0.9, 0.2, 0.3], { parallelMin: 1, parallelMax: 3 }), 1)
  assert.equal(pressureSample({ totalmem: 100, freemem: 25 }), 0.75)
  assert.equal(pressureSample(null), 0)
})

await test('C4 熔断：连败/超次/超预算各自触发', async () => {
  const s = { breakerStreak: 2, breakerAttempts: 3 }
  assert.equal(shouldBreak({ attempts: 1, streak: 1, spent: 10, perChallenge: 1000 }, s).tripped, false)
  assert.equal(shouldBreak({ attempts: 4, streak: 0, spent: 10, perChallenge: 1000 }, s).reason, 'max-attempts')
  assert.equal(shouldBreak({ attempts: 2, streak: 2, spent: 10, perChallenge: 1000 }, s).reason, 'same-strategy-no-candidate')
  assert.equal(shouldBreak({ attempts: 2, streak: 0, spent: 1000, perChallenge: 1000 }, s).reason, 'budget')
})

await test('C5 策略指纹：同输入稳定，24h 窗口内判重', async () => {
  const a = strategyFingerprint({ id: 'easycap', skills: ['ctf-forensics', 'ctf-misc'], promptVersion: 'p1' })
  const b = strategyFingerprint({ id: 'easycap', skills: ['ctf-misc', 'ctf-forensics'], promptVersion: 'p1' })
  const c = strategyFingerprint({ id: 'easycap', skills: ['ctf-forensics'], promptVersion: 'p1' })
  assert.equal(a, b, '技能顺序不影响指纹')
  assert.notEqual(a, c, '技能集变化应改变指纹')
  const state = {}
  recordFingerprint(state, a, { now: 1000, challengeId: 'easycap' })
  assert.equal(recentFingerprint(state, a, { now: 1000 + 3600 * 1000, hours: 24 }), true)
  assert.equal(recentFingerprint(state, a, { now: 1000 + 25 * 3600 * 1000, hours: 24 }), false)
})

await test('B2 题型路由：每题技能 ≤3，可覆盖模式', async () => {
  const routing = { forensics: { skills: ['a', 'b', 'c', 'd'], mode: 'supervisor' }, misc: { skills: [] } }
  const r = pickSkills({ category: 'forensics' }, routing)
  assert.equal(r.skills.length, 3)
  assert.equal(r.mode, 'supervisor')
  assert.deepEqual(pickSkills({ category: 'unknown' }, routing).skills, [])
})

await test('B3 难度双通道：取高，先验需 ≥3 条样本，一致率可计算', async () => {
  assert.equal(combineDifficulty('easy', 'hard'), 'hard')
  assert.equal(combineDifficulty('hard', 'medium'), 'hard')
  assert.equal(combineDifficulty(null, 'medium'), 'medium')
  assert.equal(combineDifficulty('easy', null), 'easy')
  const history = [
    { category: 'forensics', solved: false }, { category: 'forensics', solved: false },
    { category: 'forensics', solved: false },
  ]
  assert.equal(priorDifficulty(history, { category: 'forensics' }), 'hard')
  assert.equal(priorDifficulty(history.slice(0, 2), { category: 'forensics' }), null)
  assert.equal(difficultyAgreement([{ model: 'easy', prior: 'easy' }, { model: 'hard', prior: 'easy' }]).rate, 0.5)
})

await test('D4 告警分级：L1 有 8h 上限，超出降为 L3', async () => {
  assert.equal(alertLevel('budget-exhausted'), 'L1')
  assert.equal(alertLevel('awaiting-confirm'), 'L2')
  assert.equal(alertLevel('whatever'), 'L3')
  const state = {}
  const now = 1000
  for (let i = 0; i < 5; i += 1) assert.equal(shouldEmitAlert(state, 'stalled', { now: now + i, capL1: 5 }).emit, true)
  const capped = shouldEmitAlert(state, 'stalled', { now: now + 10, capL1: 5 })
  assert.equal(capped.emit, false)
  assert.equal(capped.level, 'L3')
  assert.equal(shouldEmitAlert(state, 'stalled', { now: now + 9 * 3600 * 1000, capL1: 5 }).emit, true, '窗口外应重新放行')
})

await test('D3 看门狗：事件过期即判空转并回调', async () => {
  const stalls = []
  const wd = startWatchdog({ intervalMs: 10, idleMs: 50, lastEventAt: () => Date.now() - 1000, onStall: (i) => stalls.push(i) })
  const r = wd.tick()
  wd.stop()
  assert.equal(r.stalled, true)
  assert.equal(stalls.length, 1)
  const fresh = startWatchdog({ intervalMs: 10, idleMs: 50, lastEventAt: () => Date.now() })
  assert.equal(fresh.tick().stalled, false)
  fresh.stop()
})

await test('B5 批量确认：单批 >5 拒绝，逐条 confirm 后置 done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-b5-'))
  const pool = normalizePool({ challenges: Array.from({ length: 7 }, (_, i) => ({ id: `c${i + 1}`, score: 100 })) })
  for (const c of pool.challenges) c.status = 'waiting_confirm'
  fs.writeFileSync(path.join(dir, 'pool.json'), JSON.stringify(pool, null, 2))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '')

  const tooMany = path.join(dir, 'big.json')
  fs.writeFileSync(tooMany, JSON.stringify({ items: pool.challenges.slice(0, 6).map((c) => ({ id: c.id, confirm: true })) }))
  const r1 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'eva-confirm.mjs'), '--race', dir, '--file', tooMany], { encoding: 'utf8' })
  assert.equal(r1.status, 2, r1.stderr)

  const noConfirm = path.join(dir, 'noconfirm.json')
  fs.writeFileSync(noConfirm, JSON.stringify({ items: [{ id: 'c1', confirm: false }] }))
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'bin', 'eva-confirm.mjs'), '--race', dir, '--file', noConfirm], { encoding: 'utf8' }).status, 2)

  const ok = path.join(dir, 'ok.json')
  fs.writeFileSync(ok, JSON.stringify({ items: [{ id: 'c1', confirm: true }, { id: 'c2', confirm: true }] }))
  const r3 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'eva-confirm.mjs'), '--race', dir, '--file', ok], { encoding: 'utf8' })
  assert.equal(r3.status, 0, r3.stderr)
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'pool.json'), 'utf8'))
  assert.equal(after.challenges[0].status, 'done')
  assert.equal(after.challenges[1].status, 'done')
  assert.ok(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('race/confirm-batch'))
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('D6 复盘：卡片字段齐全，facts 只写短结论且 id 递增', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-d6-ws-'))
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-d6-run-'))
  fs.mkdirSync(path.join(ws, '_tools', 'eva'), { recursive: true })
  fs.mkdirSync(path.join(ws, '.dsh', 'memory'), { recursive: true })
  fs.writeFileSync(path.join(ws, '_tools', 'eva', 'toolgate.mjs'), '')
  fs.writeFileSync(path.join(ws, '.dsh', 'memory', 'facts.jsonl'), `${JSON.stringify({ id: 'F-7', challenge: 'x', claim: 'old', evidence: 'e', ts: 't', confidence: 'low' })}\n`)

  fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ runId: 'r1', challenge: 'demo', staged: true }))
  fs.writeFileSync(path.join(run, 'plan.json'), JSON.stringify({ surface: { category: 'misc', difficulty: 'easy' } }))
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
    runId: 'r1', status: 'verified', spentTotal: 123456, verdict: { verdict: 'pass', reasons: ['复算通过'] },
  }))
  fs.writeFileSync(path.join(run, 'events.jsonl'), [
    { ts: '2026-11-13T00:00:00Z', type: 'race/start' },
    { ts: '2026-11-13T00:05:00Z', type: 'turn/end', measuredTokens: 1000 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const cardFile = path.join(run, 'retro.md')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'eva-retro.mjs'), '--run', run, '--workspace', ws, '--out', cardFile], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.fact.id, 'F-8')
  assert.ok(out.claim.length <= 200, 'facts 只写短结论')
  const card = fs.readFileSync(cardFile, 'utf8')
  assert.ok(card.includes('failureFamily'))
  assert.ok(card.includes('misc') && card.includes('easy'))
  const facts = fs.readFileSync(path.join(ws, '.dsh', 'memory', 'facts.jsonl'), 'utf8').trim().split(/\r?\n/)
  assert.equal(facts.length, 2)

  const before = fs.readFileSync(path.join(ws, '.dsh', 'memory', 'facts.jsonl'), 'utf8')
  const rd = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'eva-retro.mjs'), '--run', run, '--workspace', ws, '--out', cardFile, '--dry-run'], { encoding: 'utf8' })
  assert.equal(rd.status, 0, rd.stderr)
  assert.equal(fs.readFileSync(path.join(ws, '.dsh', 'memory', 'facts.jsonl'), 'utf8'), before, 'dry-run 不写 facts')

  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(run, { recursive: true, force: true })
})

console.log('')
if (failures.length) {
  console.error(`${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.error(`- ${f.name}: ${f.error?.stack ?? f.error}`)
  process.exit(1)
}
console.log(`${passed}/${passed} passed`)
