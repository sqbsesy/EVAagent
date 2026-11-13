#!/usr/bin/env node
// 离线自检：不拉起运行时、不烧 token。
// 覆盖 JSON 抽取、预算闸、提示词拼装、以及 mock 全链路（含产物断言）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { extractJson } from '../lib/jsonx.mjs'
import { Ledger, BudgetStop } from '../lib/ledger.mjs'
import { composeRecon, composeWorker } from '../lib/prompts.mjs'
import { orchestrate, orderStages, stageSeconds } from '../lib/run.mjs'
import { MockBridge } from '../lib/sdk.mjs'
import { listFiles, renderFileList, resolveChallenge, findProbes, renderProbes } from '../lib/context.mjs'
import { effectiveRunBudget, spentFromRuns, admitTurn } from '../lib/budget.mjs'

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

console.log('')
if (failures.length) {
  console.error(`${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.error(`- ${f.name}: ${f.error?.stack ?? f.error}`)
  process.exit(1)
}
console.log(`${passed}/${passed} passed`)
