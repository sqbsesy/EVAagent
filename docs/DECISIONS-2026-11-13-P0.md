# 赛程优化 P0 落地记录（2026-11-13）

来源：`C:\Users\20606\WorkBuddy\EVA\eva-schedule-optimization-plan.md`（v1.0，批次一 P0 11 条）。
执行协议：范围锁定、逐条 DoD、改前备份、不引新依赖、提交保持 `manual`、失败即记、P0 全过才做 P1。

## 备份

- 目录：`_backup/20261113-p0/`（`policies/*`、`lib/run.mjs`、`package.json`、`test/selftest.mjs`）。
- 基线提交：`2ae833e`（P0 前的 HEAD）。

## 11 条落点与行为

| 条目 | 文件 | 行为 | 验证 |
| --- | --- | --- | --- |
| A1 赛程调度 | `lib/schedule.mjs`、`bin/eva-race.mjs` | `pool.json` 读入 → 按 `score/estMinutes` 出队；状态机 `queued/running/waiting_confirm/done/abandoned`；事件 `race/start|dispatch|dry-run|verified|await-confirm|idle|reconcile|requeue|end`；`state.json` 断点 | 干跑 3 题出队顺序 lfsr(19.231) → easycap(15) → bluetrace(14.3) |
| A2 双模调度 | `decideMode()`、`policies/schedule.json` | ≤15 min 走 solo，>15 min 或 `isContainer && pwn/web` 走 supervisor；`upgradeAfterMinutes 15`、只升一次 | 干跑两条 dispatch 均 `mode:"supervisor"`、`staged:true` |
| A3 环境租约 | `lib/env-lease.mjs` | `wx` 锁 + 30 s 悬挂清理 + `tmp+rename`；TTL 10 min；`heartbeat` 续租、`reclaimExpired` 抢占、`release` 释放 | 自测：抢占/续租/释放/回收四例 |
| A4 跨题并行 | `pickStartable()` | 槽位由 `maxParallel` 决定；满则留待下轮，不杀进程 | 干跑 `maxParallel:2` 只派 2 条 |
| B1 赛题结构化 | `lib/challenge.mjs` | 字段 `{value,source,confidence}`；缺失 `null`+`unknown`；`fillRate`、`inferFromText`（只补空、标 inferred） | 自测：来源标注、填充率 |
| B4 粒度硬校验 | `lib/run.mjs` | 子任务缺 goal/deliverable/acceptance（staged 加 artifact）→ `plan/rejected` → 带反馈重试一次 → 仍错 `plan/degraded` 降级单线 | 自测：拒绝并降级 |
| C2 断点续跑 | `recordCheckpoint`、`reconcileCheckpoints`、`hashFile` | 记阶段、产物 sha256 与字节数、花费；重启对账，哈希一致跳过 | 自测：一致 / 变更 / 缺文件 |
| C3 失败止损 | `nextActionFor()`、`finish()` | 五类：timeout / no-candidate / budget-exhausted / format-invalid / env-unavailable，各配动作；事件 `failure/classified` | 自测 + 既有 run 兼容（未验证时只记录不改变 status） |
| D1 看板 | `bin/eva-board.mjs` | 只读六块：题池 / 在跑 / 待确认 / 预算 / 租约 / 告警；`/api/race`、`meta refresh 5`；不写盘 | 快照输出 6 块，`budget.starting=7,500,000` |
| D2 心跳 | `lib/health.mjs`、`bin/eva-health.mjs` | 每 60 s 查控制台端口 / 最近事件 / 运行时 pid；连续 3 次失败才告警；同异常 10 min 去重 | `--once` 输出 JSON：console ok、events 因参数未指向 race 目录而失败，exit 3 符合契约 |
| D5 凭据 | 全仓库 | 只写环境变量名（`apiKeyEnv: QWEN_TOKEN_PLAN_CN_API_KEY`）；无明文 token/密钥 | `grep` 检索无 `sk-*`、`Bearer *`、`apiKey: "..."`；`submit.json` 仍 `manual` |

## 自测与冒烟

- `node test/selftest.mjs` → **35/35 passed**（新增 6 例：challenge、env-lease、schedule、C2 对账、D2、B4）。
- `node bin/eva-race.mjs --pool integrations/race-pool.example.json --dry-run --once --race-id race-smoke-dry` → exit 0，
  `runs/race-smoke-dry/events.jsonl` 6 行，含两条 dispatch 与两条 dry-run。
- `node bin/eva-board.mjs --runs ./runs --race race-smoke-dry --snapshot` → exit 0，六块 JSON。
- `node bin/eva-health.mjs --once --console-port 8787` → exit 3（`events: no events yet`），
  console 项 `tcp 127.0.0.1:8787 open`。

## 未验证 / 已知限制

- A1 的 live 派发（真 spawn `eva-super`）未跑：需要可用 provider，且 6 h 无人值守场景无法在本轮压测。
- A4 的「并行单题墙钟 ≤ 串行 1.3 倍」未量化：需要同题串行/并行各跑一次做对照。
- A3 的 1000 次取用无双占未压测，仅单测级别验证。
- C2 的「强杀重启重复计算 ≤1 阶段」未做真实强杀实验。
- D1 的「刷新 ≤10 s」由 `meta refresh 5` 保证，但未在浏览器实测。
- `policies/schedule.json` 与 `budget.json` 存在重叠字段（`workerMax`），目前以 CLI 显式参数优先。

## 下一步（P1，未开始）

A5 赛程预算池 → C1 并发动态化 → C4 单题熔断 → C5 策略指纹 → B2 题型路由 → B3 难度双通道 →
B5 批量确认 → D3 看门狗 → D4 告警分级。