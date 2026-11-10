// 角色契约加载与提示词拼装。
// 契约本体在 agents/*.md，代码只负责把「角色 + 任务 + 输出 schema」拼成一轮 prompt。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

export function roleText(name) {
  if (cache.has(name)) return cache.get(name)
  const file = path.join(ROOT, 'agents', `${name}.md`)
  const text = fs.readFileSync(file, 'utf8')
  cache.set(name, text)
  return text
}

const JSON_RULE = '只输出一个 JSON 对象（不要解释、不要多余文本），字段按下面的约定。'

export function composeRecon({ challengeName, challengeDir, files, budget, task = '' }) {
  const taskBlock = task
    ? `\n## 任务描述（来自工单，优先于文件名猜测）\n${task}\n`
    : ''
  return `# 任务：侦察

## 角色契约
${roleText('supervisor')}
${taskBlock}
## 工作对象
- 名称：${challengeName}
- 目录：${challengeDir}
- 文件清单：
${files}

## 预算
- 本次 run 预算 ${budget} tok；你这一轮应控制在 150k 以内。

## 输出
${JSON_RULE}
{
  "category": "web|pwn|reverse|crypto|misc|forensics|blockchain|ai|other",
  "difficulty": "easy|medium|hard",
  "entry": "入口/攻击面的一句话描述",
  "attachments": ["相对路径"],
  "hypotheses": [
    {"id": "t1", "goal": "单假设目标", "deliverable": "相对路径", "acceptance": "可执行的验收方式"}
  ],
  "notes": "给 worker 的必要背景，<= 300 字"
}
要求：hypotheses 只写「一个假设 + 一个产出物 + 一条验收」，最多 4 条；不要写解题步骤细节。`
}

export function composeWorker({ task, surface, challengeName, challengeDir, taskDir, workspace, budget }) {
  return `# 任务：验证单个假设

## 角色契约
${roleText('worker')}

## 题目背景
- 名称：${challengeName}
- 目录：${challengeDir}
- 类别：${surface.category}
- 入口：${surface.entry}
- 备注：${surface.notes}

## 你的任务（只做这一件事）
- id：${task.id}
- goal：${task.goal}
- deliverable：${task.deliverable}
- acceptance：${task.acceptance}

## 工作目录
${taskDir}（产物写这里；challenge 目录下的相对路径即以此为准）

## 工具
- 命令一律走：node ${path.join(workspace, '_tools', 'eva', 'toolgate.mjs')} run -- <你的命令>
- 读文件用 read，搜文件用 grep/glob，不要 cat 整个大文件
- 需要 MCP 时用 node ${path.join(workspace, '_tools', 'eva', 'mcp-lazy.mjs')} call <工具名> --args '{...}'

## 规则
- 不读其他 worker 的结论；不猜；结论必须可复现。
- 回复正文只写摘要（<= 200 字），细节进文件。
- 无把握就把 confidence 写低，并在 next 里写下一步。

## 输出
${JSON_RULE}
{
  "taskId": "${task.id}",
  "hypothesis": "…",
  "finding": "…",
  "candidate": "若得到 flag 填原文，否则空串",
  "evidence": [{"path": "相对 challenge 的路径", "line": 0, "cmd": "复现命令"}],
  "confidence": 0.0,
  "next": "…"
}
本轮预算上限 ${budget} tok。`
}

export function composeVerifier({ challengeName, challengeDir, findings, candidate }) {
  const evidence = findings
    .flatMap((f) => (f.evidence ?? []).map((e) => `- ${f.taskId}: ${e.path}${e.line ? `:${e.line}` : ''} :: ${e.cmd ?? ''}`))
    .join('\n')
  return `# 任务：独立复核

## 角色契约
${roleText('verifier')}

## 题目
- 名称：${challengeName}
- 目录：${challengeDir}

## 候选结论
${candidate}

## 待复核证据
${evidence || '（无）'}

## 要求
1. 重新运行证据里的命令或重新读取原始数据，**不得只读上面的结论**。
2. 校验格式、唯一性、来源（是否本次算出）。
3. 三者同时满足才是 pass；任一缺失 needs_revision；猜测/抄题面/外部搜索 reject。

## 输出
${JSON_RULE}
{
  "candidate": "…",
  "verdict": "pass|needs_revision|reject",
  "reasons": ["…"],
  "replay": {"cmd": "你实际重跑的命令", "exit": 0},
  "checkedAt": "ISO8601"
}`
}