# 决策记录

## 已定（2026-11-10，用户 D1–D3）

| # | 决策 | 结论 | 备注 |
| --- | --- | --- | --- |
| D1 | superagent 的定义 | **A：编排层**（Supervisor + Worker/Verifier/Scribe） | 不做 SuperAGI 平台迁移；superagent.sh 仅作提交前护栏参考 |
| D2 | P0 承载方式 | **独立 CLI**，后期再挂到控制台作为「super 会话」 | `bin/eva-super.mjs`，不依赖控制台在线 |
| D3 | 提交权限 | **Verifier 通过后仍需人工确认**；比赛期再开放自动提交 | `bin/eva-submit.mjs` 无 `--confirm` 即拒绝 |

## 其他已定

- 不引入 Docker 与外部 Agent 平台（内存、停更、工具面三重不匹配）。
- Worker 上限 2；预算 1.2 M/run；60% 收敛。
- 证据链强制：`file:line` + 复现命令 + 置信度。
- 仓库不含凭据/flag/附件原文。
- 领取/提交 flag 一律走 `mcp-lazy.mjs call`（子会话不继承 MCP 激活）。

## P0 状态（2026-11-10）

已完成：

1. `agents/*.md` 的 JSON 契约（recon / plan / verify / scribe 各自只输出一个 JSON 对象）。
2. `lib/sdk.mjs`：DSH JSON-RPC 客户端（协议复用 `work/eva-console/server/dsh-bridge.mjs`）+ 离线 `MockBridge`。
3. `lib/ledger.mjs`：按 run 累计 token，超预算抛 `BudgetStop`。
4. `lib/run.mjs`：编排主流程，串行 recon → 并发 worker → verifier，产物落 `runs/<runId>/`。
5. 三个入口：`bin/eva-super.mjs` / `bin/eva-submit.mjs` / `bin/eva-replay.mjs`。
6. `test/selftest.mjs` **11/11**；dry-run / submit dry-run / replay / 工单模式全链路验证通过。

## 与 dsh-superagent-prototype 对齐（2026-11-10，用户要求「把两者对齐」）

结论：**共存、分层，不合并代码。**

| 层 | 谁负责 | 依据 |
| --- | --- | --- |
| 事件接入、准入、Ticket、独立 Session、回帖/PR | prototype | 它已有 GitHub/飞书 Source 与 Policy 机制 |
| 侦察、拆解、并行、复核、预算、证据、提交 | 本仓库 CLI | prototype 的执行器没有这些闸门 |

- 契约写在 `AGENTS.md` 第七条：Ticket 的 worker Session 调
  `node <repo>/bin/eva-super.mjs --task "<标题+要点>" --task-dir <目录> --json`，只回帖
  `runId/status/verdict/spent/runDir` 与 report 路径；不得回帖 flag 原文，不得自行 `--confirm`。
- CLI 新增工单模式：`--task` / `--task-dir`，工单文本进 `meta.json.task`、`report.md`「工单：」行。
- prototype 的 profile 配置要点见 `docs/INTEGRATION.md` 与
  `integrations/dsh-superagent/profile.patch.example.yml`：桌面 profile 的 bundle 层已 insert
  `dsh-superagent` 条目但无 config，必须由 profile patch 补 `stateDir`（否则插件拒绝启动）。
- 本机现状：prototype 已作为依赖装进 desktop profile，但 profile patch 尚未加 `stateDir`；
  `gh` 未安装，GitHub Source 未启用，端到端未验证。

## 仓库状态（2026-11-10）

- 已 `git init`（本地 main），提交 `P0: EVA Supervisor CLI with ticket mode and dsh-superagent-prototype integration`。
- **已推送** `https://github.com/sqbsesy/EVAagent`（`main`，`origin` 跟踪，凭据由 Git Credential Manager 保存）。
- **prototype 已挂进 desktop profile 并联调通过**：patch 加 `- id: dsh-superagent` + `stateDir`，
  `dsh-superagent-github` 先 `disabled: true`（缺 gh）。用临时克隆档 `satcheck` 验证：插件激活、
  `prototype-state/orchestrator.sqlite` 落盘、`/orchestrator/api/{tickets,settings,prompts}` 均 200；
  验证后删除临时档。生效需完全退出并重开 DSH。
  - 关键坑：`stateDir` schema 为 `/^\//`，Windows 上必须写 `/Users/...` 而非 `C:/...`，
    否则报 `$.stateDir expect string to match regexp /^\//` 且插件不激活。
- **live 运行仍被余额阻塞**：`sdk` profile 仅注册 `deepseek-account` 适配器，返回
  `Insufficient Balance (request_id: ...)`；已试 `--patch` 挂 `dsh-our-free-model`，插件能加载但
  未注册 `our-free-model` 适配器（Host 半身绑定 desktop 的 web 组合），不可用。10 题回放待充值。

## 下一步

1. 充值或指定可用 provider 后跑 10 题回放（`bin/eva-replay.mjs`），按四项指标验收；
2. 视回放结果调 `agents/*.md` 契约与并发/预算参数；
3. 决定是否把 `runs/` 只读视图挂到控制台（D2 后期）；
4. 网络/凭据就绪后完成首次推送，并在 profile patch 里补 prototype 的 `stateDir` 做端到端联调。