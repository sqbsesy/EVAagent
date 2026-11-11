# EVAagent（P0）

> 状态：**P0 已实现**（CLI 可跑，离线链路自测 20/20；含工单模式）。**2026-11-10 首条 live 通过**：
> `easycap` 跑出 `verified / pass`，1.40 M tok（缓存折算后）、24.8 min，候选由 t1 落盘并经独立复核
> （`runs/20261110110922-f5f9ee`）。P1 已落地：usage 缺失时按
> 提示词+工具输出估算并放大（`estimateMultiplier`）、单题预算跨 run 累计（`perChallengeTokens` 扣历史）、
> 3 题基准脚本 `eva-bench`；账号级错误（欠费/无适配器）整条中止为 `config-error`。
> 计量以运行时 `turn/end` 的 usage 为准，缓存读按 `cacheWeight=0.1` 折算（`totalTokens` 含缓存读，
> 全额计入会让预算失效）；每轮落账后立即校验，超预算停在 `partial`。
> 候选结果默认**落盘**：worker 只回 `candidateFile`，`verdict.json`/`pending.json` 记 `file:<相对路径>`，
> flag 原文不进对话、不进报告；`eva-submit` 从该文件读第一行。
> sdk 档的 live provider 用 `--patch integrations/sdk-pi-ai.patch.yml`（pi-ai + 千问 token-plan），
> 见下文「live provider」；默认的 `deepseek-account` 当时欠费。决策见
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

# 3b) 真跑且给 sdk 档补 provider（pi-ai + 千问 token-plan）
node bin/eva-super.mjs --challenge work/<题目目录> \
  --patch integrations/sdk-pi-ai.patch.yml \
  --provider qwen-token-plan-cn --model deepseek-v4.1-flash

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

## live provider

sdk 档自带适配器只有 `deepseek-account`。要用别的 provider，用 `--patch` 把适配器插件插进 sdk 运行时：

| 路线 | 做法 | 状态 |
| --- | --- | --- |
| `deepseek-account` | 默认 | 本机当时欠费（`Insufficient Balance`） |
| pi-ai + 千问 token-plan | `--patch integrations/sdk-pi-ai.patch.yml --provider qwen-token-plan-cn --model deepseek-v4.1-flash` | 已接进 sdk，用 `apiKeyEnv: QWEN_TOKEN_PLAN_CN_API_KEY` 读环境变量 |
| `our-free-model`（desktop 插件） | `--patch` 挂 `dsh-our-free-model` | sdk 里适配器能注册，但出站不可用：`UPSTREAM_BASE` 默认 `https://opencode.ai`（本机被重置），本地 relay 只随 web 半身启动 |

等价的环境变量：`EVA_DSH_PATCH`（patch 文件）、`EVA_DSH_PROVIDER`、`EVA_DSH_MODEL`。
patch 文件是 DSH 覆盖层：**顶层 YAML 数组**，新增插件用 `- insert: [ ... ]`；密钥只写环境变量名，不入库。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | Verifier 通过 |
| 2 | 部分任务失败或复核未通过 |
| 3 | 配置/预检错误（找不到工作区、题目目录、运行时） |
| 4 | 预算闸触发（`BudgetStop`） |