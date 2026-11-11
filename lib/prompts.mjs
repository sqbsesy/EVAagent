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
要求：hypotheses 只写「一个假设 + 一个产出物 + 一条验收」，最多 4 条；不要写解题步骤细节。
目录里若出现 solve*.py、answer_gate.md、*.log、runs/ 之类**历史产物**，说明这题此前被探索过：把它们当线索，不要当作题目附件本身；先确认真正的输入（压缩包 / 抓包 / 二进制）。`
}

export function composeScaffold({ challengeName, challengeDir, files, notes, entry, scaffoldDir, budget }) {
  return `# 任务：先搭脚手架，再解题

## 角色契约
${roleText('supervisor')}

## 题目
- 名称：${challengeName}
- 目录：${challengeDir}
- 入口：${entry || '（未给出）'}
- 清单：
${files}
- 侦察备注：${notes || '（无）'}

## 你要做的事（只做这一件）
在 ${scaffoldDir} 下建一套**后续 worker 可以直接复用**的最小脚手架：
1. \`capabilities.md\`：工具可用性（tshark/tshark -z、python 库、系统命令），以及一两条已验证可用的命令与输出摘要；工具缺失就写清缺什么。
2. 一个可复用的脚本（\`probe.py\` / \`probe.sh\`，按题目类型选）：只做**第一层**结构化抽取（如协议分层统计、帧计数、容器魔数扫描），带 \`--limit\` 之类的安全参数，不要试图一次把题做完。
3. \`README.md\`：怎么调用脚本、已知结论、下一步建议（≤ 200 字）。

## 规则
- 先花 1–2 分钟确认工具与环境，再动手；不要从零重写标准库已有的解析（能调 tshark/ffprobe/unzip 就先调）。
- 大文件一律用脚本处理，不要把二进制/抓包读进上下文。
- 脚本必须能重复运行且幂等（不覆盖原始附件）。
- 本轮预算 ${budget} tok，墙钟有限，写完脚本、跑通一次就停。

## 输出
只输出一个 JSON（不要解释）：
{"capabilities":"…","script":"probe.py","usage":"命令行怎么调","findings":["…"],"next":["…"]}`
}

export function composeWorker({ task, surface, challengeName, challengeDir, taskDir, workspace, budget, scaffold = '' }) {
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
${scaffold ? `\n## 可直接复用的脚手架（上一阶段已建好）\n${scaffold.slice(0, 2000)}\n先读它的 README/脚本再动手；能用就直接调用，不要重写同一个解析器。\n` : ''}

## 工具
- 命令一律走：node ${path.join(workspace, '_tools', 'eva', 'toolgate.mjs')} run -- <你的命令>
- 读文件用 read，搜文件用 grep/glob，不要 cat 整个大文件
- 需要 MCP 时用 node ${path.join(workspace, '_tools', 'eva', 'mcp-lazy.mjs')} call <工具名> --args '{...}'

## 规则
- 不读其他 worker 的结论；不猜；结论必须可复现。
- 回复正文只写摘要（<= 200 字），细节进文件。
- 无把握就把 confidence 写低，并在 next 里写下一步。
- 本轮有硬墙钟：到点会被强杀，回复与 JSON 都会丢，因此**每得到候选就先写 candidate.txt 再继续**，不要留到最后。
- 题目目录里可能有上一轮的脚本/中间产物（s*.py、*.bin、*.jpg 等）：先读一眼再决定，能复用就复用，不要从零重写同一件事。
- 不要花时间审计历史脚本本身（读它、评它、写报告都不算推进）；直接解出结果，拿到候选立刻落盘。

## 输出
${JSON_RULE}
{
  "taskId": "${task.id}",
  "hypothesis": "…",
  "finding": "…",
  "candidateFile": "若得到 flag：写到 ${taskDir} 下的文件（如 candidate.txt），此处填该文件的相对路径；否则空串",
  "candidate": "只有无法落盘时才填原文，否则空串",
  "evidence": [{"path": "相对 challenge 的路径", "line": 0, "cmd": "复现命令"}],
  "confidence": 0.0,
  "next": "…"
}
候选文件里只放最终答案本身（一行），不要放解释。本轮预算上限 ${budget} tok。`
}

export function composeVerifier({ challengeName, challengeDir, findings, candidate, candidateFiles = [] }) {
  const evidence = findings
    .flatMap((f) => (f.evidence ?? []).map((e) => `- ${f.taskId}: ${e.path}${e.line ? `:${e.line}` : ''} :: ${e.cmd ?? ''}`))
    .join('\n')
  const files = candidateFiles.length
    ? candidateFiles.map((f) => `- ${f}`).join('\n')
    : ''
  return `# 任务：独立复核

## 角色契约
${roleText('verifier')}

## 题目
- 名称：${challengeName}
- 目录：${challengeDir}

## 候选结论
${candidate}
${files ? `\n## 候选文件（实现把候选写进文件，避免原本回传到对话里）\n${files}\n\n用 read 工具读取这些文件核对内容与格式；**不要在回复里复述内容**。\n` : ''}
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