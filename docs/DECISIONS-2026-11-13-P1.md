# 赛程优化 P1（批次二）落地记录 — 2026-11-13

> 依据：`C:\Users\20606\WorkBuddy\EVA\eva-schedule-optimization-plan.md` v1.0 的批次二（9 条）。
> 基线提交：`c88a420`（P0 全绿）。备份：`_backup/20261113-p1/`（改前的 `lib/`、`bin/`、`policies/`、`test/`）。

## 一、逐条落点

| 条目 | 落点 | 关键实现 |
| --- | --- | --- |
| A5 赛程预算池 | `lib/schedule.mjs:raceBudget()` | `planned = n × perChallenge × budgetShare`，`reserve = planned × 0.1`，`hardCap = min(each, planned - reserve)`；`eva-race` 里显式 `--budget` 优先，否则单题用 `hardCap`，事件 `race/start.budgetPool` |
| C1 并发动态化 | `pressureSample()` / `parallelFromSamples()` | 每轮 `os.freemem()/os.totalmem()`；取最近 3 次最差档：>0.75→`parallelMin`、>0.55→2、否则 `parallelMax`；档位变化写 `race/parallel`（含 samples） |
| C4 单题熔断 | `shouldBreak()` | 触发条件三条：`attempts >= breakerAttempts(3)`、`streak >= breakerStreak(2)`、`spent >= perChallenge`；`eva-race` 置 `abandoned` 并写 `race/abandoned`、退出码 3 |
| C5 策略指纹 | `strategyFingerprint()` / `recentFingerprint()` / `recordFingerprint()` | `sha256(id|技能排序|promptVersion)` 取前 12 位；`state.fingerprints` 记时间戳；24 h 内命中 → `race/skip-fingerprint`，当轮全命中则 `race/idle` 退出 |
| B2 题型路由 | `policies/routing.json` / `pickSkills()` | 每类给 ≤3 个技能，可选 `mode` 覆盖双模；`eva-race` 以 `--notes "建议技能：…"` 注入 recon（不阻断，只提示） |
| B3 难度双通道 | `priorDifficulty()` / `combineDifficulty()` / `difficultyAgreement()` | 历史先验要求 ≥3 条同题型样本，通过率 ≥0.6 easy / ≥0.3 medium / 否则 hard；与模型判断按 `easy<medium<hard` 取高；一致率只做报告 |
| B5 批量确认 | `bin/eva-confirm.mjs` | 单批 > `confirmBatchMax(5)` 直接 exit 2；每条必须 `confirm:true` 且状态 `waiting_confirm`；`--submit` 才调用 `eva-submit --confirm`；写 `race/confirm-batch` |
| D3 看门狗 | `startWatchdog()` / `eva-health --watchdog` | 以 `events.jsonl` 的 mtime 判空闲；≥ `idleMs` 回调 onStall 并 exit 3；只报不杀 |
| D4 告警分级 | `alertLevel()` / `shouldEmitAlert()` | L1 决策（预算耗尽/环境不可用/全部放弃/空转）、L2 知晓（待确认/并发降级）、L3 记录；L1 8 h 内最多 5 条，超出写 `alert/suppressed` |

## 二、验证

- `node test/selftest.mjs` → **44/44 passed**（P1 新增 9 例：预算池、并发采样、熔断三触发、指纹稳定与 24 h 窗口、
  路由 ≤3、难度取高与先验门槛、告警 L1 上限、看门狗回调、批量确认 6 条拒绝 + 2 条成功）。
- 调度干跑（`runs/race-p1-smoke`）：
  - `race/start` 带 `budgetPool{planned:5250000,reserve:525000,perChallenge:2500000}`；
  - `race/parallel{parallel:1,pressure:0.897}`（当时机器内存压力高，动态降到 1，符合设计）；
  - `race/dispatch{id:"lfsr",skills:["ctf-reverse"],fingerprint:"cc438b2f88b5",budget:2500000}`。
- 确认链路：`eva-confirm --dry-run` → `{"ok":true,"dryRun":true,"confirmed":["easycap","lfsr"]}`；
  正式执行后 pool 两题置 `done`，事件 `race/confirm-batch{count:2}`。
- 健康链路：`eva-health --once` → `console ok / events ok`、exit 0（旧版因目录不对恒报 `no events yet`，已修：
  自动选 `runs/` 下最新带 `events.jsonl` 的赛程目录，并支持 `--events`）。`--watchdog` 对过期事件 exit 3。

## 三、未验证 / 已知限制

1. A5 的预算池只在调度层生效；`eva-super` 内部仍按 `--budget` 单题预算走，两者尚未做全局扣减对账。
2. C1 只采内存压力，未纳入模型额度/并发进程数；阈值为经验值，需要比赛期校准。
3. C5 的 `promptVersion` 目前硬编码 `p1`，提示词改动需人工升版本，否则会误判为「同策略」而跳过。
4. B2 技能名与工作区 `available-skills` 的对应关系未做校验，技能不存在时只是提示失效。
5. B3 先验来自人工喂入的 history 数组，尚未接 `facts.mjs` / `costs.jsonl` 自动生成。
6. B5 的 `--submit` 仅做参数透传，未在此层做 flag 脱敏复检（依赖 `eva-submit` 自身）。

## 四、回滚

```powershell
Copy-Item _backup\20261113-p1\* . -Recurse -Force   # 覆盖 lib/bin/policies/test/package.json
node test/selftest.mjs                              # 期望回到 35/35
```

提交策略未动：`policies/submit.json` 仍为 `manual`，批量确认也只做「人工逐条 confirm」。