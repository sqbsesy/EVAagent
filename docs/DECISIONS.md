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
6. `test/selftest.mjs` 10/10；dry-run / submit dry-run / replay 全链路验证通过。

未完成 / 阻塞：

- **live 运行被账户余额阻塞**：`sdk` profile 仅注册 `deepseek-account` 适配器，调用返回
  `Insufficient Balance (request_id: ...)`；离线链路不受影响。已试过用 `--patch` 把
  `dsh-our-free-model` 挂进 sdk 组合（`_scratch/free.yml`），插件能加载但未注册
  `our-free-model` 适配器（该插件把 Host 半身绑定在 desktop 的 web 组合上），不可用。
- 10 题回放未跑（同上）。回放脚本已就绪，充值后可直接跑。
- 尚未 `git init` / 提交 / 推送 `EVAagent`（需用户明确授权）。
- 与桌面 profile 已安装的 `dsh-superagent-prototype@0.1.3` 的关系待澄清：该插件是「单个 GitHub
  仓库的主动式 agent（GitHub/飞书事件 → Policy → Ticket → 独立 Session）」，与本 CLI 的
  「CTF 解题编排」定位不同，但名称相同，需确认是否要对齐或共存。

## 下一步

1. 充值或指定可用 provider 后跑 10 题回放（`bin/eva-replay.mjs`），按四项指标验收；
2. 视回放结果调 `agents/*.md` 契约与并发/预算参数；
3. 决定是否把 `runs/` 只读视图挂到控制台（D2 后期）；
4. 明确与 `dsh-superagent-prototype` 的边界后，再谈 `git init` 与推送。