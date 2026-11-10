# EVAagent（P0）

> 状态：**P0 已实现**（CLI 可跑，离线链路自测 15/15；含工单模式）。P1 已落地：usage 缺失时按
> 提示词+工具输出估算并放大（`estimateMultiplier`）、单题预算跨 run 累计（`perChallengeTokens` 扣历史）、
> 3 题基准脚本 `eva-bench`。live 运行需可用的模型 provider（当前 `deepseek-account` 欠费）。决策见
> `docs/DECISIONS.md`；可行性分析见 `work/eva-superagent/FEASIBILITY-2026-11-10.md`；与
> `dsh-superagent-prototype` 的对接见 `docs/INTEGRATION.md`（已挂进 desktop profile，面板后端联调通过；
> GitHub Source 在 Windows 不可用，已回退为 disabled，理由见该文档）。

## 这是什么

EVA 的 **Supervisor 层**：一个负责侦察、分流、拆解、分派、仲裁的编排会话，配合 Worker / Verifier / Scribe 三个从角色，把「单会话硬解」升级为「有预算闸、有证据链、可复盘」的解题流水线。

两种入口：

- **题目模式**：`--challenge <题目目录>`，按附件侦察后分流；
- **工单模式**：`--task "<工单文本>" --task-dir <目录>`，供 GitHub 工单类 Session 调用
  （与 `dsh-superagent-prototype` 对齐，见 `docs/INTEGRATION.md`）。

它**不是**：

- 不是新的 Agent 平台，不引入 Docker / Postgres / Redis；
- 不是自动提交机器：默认提交需人工 `--confirm`；
- 不替代 `work/eva-console`，后者仍是人类驾驶舱。

## 依赖

- DSH 44.7+，`sdk` profile（内置 `subagent` / `subagent_fork` / `workflow`）；
- EVA 工作区的 `_tools/eva/*`（预算、trace、facts、ending）；
- 可选：控制台 8787 仅用于展示 `runs/`。

## 目录

| 路径 | 用途 |
| --- | --- |
| `agents/` | 四个角色的提示词与输入输出契约 |
| `workflows/` | DSH workflow 脚本（扇出与复核） |
| `policies/` | 预算、提交、工具白名单硬闸 |
| `lib/` | SDK JSON-RPC 客户端、台账、上下文、提示词、编排 |
| `bin/` | `eva-super`（入口）、`eva-submit`（提交）、`eva-replay`（回放）、`eva-bench`（3 题基准） |
| `test/` | 离线自测（`node test/selftest.mjs`） |
| `integrations/` | 与外部编排器对接的示例配置（`dsh-superagent` profile patch） |
| `runs/` | 运行产物（gitignored） |

## 边界

- 仓库内**不出现**任何 token、cookie、flag、题目附件原文；
- 所有结论必须能追到 `file:line` 或可复现命令；
- 单题 token 预算 3.5 M，单 run 1.2 M，worker 上限 2；
- 触发 `ending.mjs` 的 STOP 即收工，不得硬撑。

## 快速开始

```bash
# 1) 离线自测：不拉起运行时、不烧 token
node test/selftest.mjs

# 2) 干跑全链路（MockBridge）
node bin/eva-super.mjs --challenge work/<题目目录> --dry-run

# 2b) 工单模式（GitHub Ticket Session 调用）
node bin/eva-super.mjs --task "<工单标题+要点>" --task-dir <当前目录> --json

# 3) 真跑（需要可用 provider；默认沿用 sdk profile）
node bin/eva-super.mjs --challenge work/<题目目录> --budget 1200000

# 4) 复核通过后人工提交（先看脱敏预览）
node bin/eva-submit.mjs --run runs/<runId> --dry-run
node bin/eva-submit.mjs --run runs/<runId> --confirm

# 5) 回放评测
node bin/eva-replay.mjs --run runs/<runId>

# 6) 3 题基准（顺序跑，遇余额/适配器错误立即中止）
node bin/eva-bench.mjs --challenges easycap,bluetrace,lfsr --max-seconds 1500

# 7) 忽略单题历史用量（同题重跑、想拿满单 run 预算时）
node bin/eva-super.mjs --challenge work/<题目目录> --ignore-prior
```

产出：`runs/<runId>/{meta,plan,state,events.jsonl,ledger,verdict,result,report}.json|md`
与 `turns/`、`submissions/`。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | Verifier 通过 |
| 2 | 部分任务失败或复核未通过 |
| 3 | 配置/预检错误（找不到工作区、题目目录、运行时） |
| 4 | 预算闸触发（`BudgetStop`） |