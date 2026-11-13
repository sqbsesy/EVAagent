# 赛程优化 P2（D6 复盘自动化）落地记录 — 2026-11-13

> 依据：`C:\Users\20606\WorkBuddy\EVA\eva-schedule-optimization-plan.md` v1.0 的 P2 唯一条目。
> 基线提交：`421846e`（P0 + P1 全绿，44/44）。备份：`_backup/20261113-p2/`。

## 一、实现

新增 `bin/eva-retro.mjs`：

- `--run <dir>`：读该 run 的 `meta.json`、`plan.json`、`result.json`、`events.jsonl`，产出复盘卡。
- `--race <dir>`：读赛程的 `pool.json` 与 `events.jsonl`，汇总每题状态、失败分类、技能、花费。
- `--workspace <dir>`：facts 写到哪里（默认自动向上找含 `_tools/eva/toolgate.mjs` 的工作区）。
- `--out <file>`：卡片路径（默认仓库 `retro/<kind>-<id>.md`）。
- `--dry-run`：只打印，不落卡、不写 facts。
- `--no-facts`：只出卡。

卡片字段（run）：`kind/id/challenge/category/difficulty/status/verdict/outcome/failureFamily/minutes/spentTokens/estimated/staged/skills/failedTasks/reasons/candidateFile/report`。
卡片字段（race）：`challenges/solved/abandoned/minutes/spentTokens/skills/failureClasses/perChallenge/blocked`。

写 facts 的规则（对应「长文不写」）：

- 只写 **1 条**，claim ≤ 200 字符：通过 →「用 X 编排跑通，N min，M k tok，技能 …」；
  未通过 →「卡在 <family>：<首个原因前 60 字>」。
- `evidence` 只放 `[RUN:<id>] <相对路径>\\events.jsonl`（必要时加 `报告 report.md`），不搬正文。
- `id` 由现有 facts 的最大 `F-<n>` 递增；`confidence`：通过 `high`、否则 `medium`。
- `tags` 带题型；写完自动调用 `facts.mjs index` 刷新索引。
- 事实只追加，不删除、不改写；去重仍走 `facts.mjs dedupe` 的「建议清单」。

## 二、验证

- `node test/selftest.mjs` → **45/45 passed**（新增 D6 用例：临时工作区里 F-7 → 写入 F-8、claim ≤200、
  卡片含题型/难度、`--dry-run` 前后 facts 字节一致）。
- 真机：`node bin/eva-retro.mjs --run runs/20261110110922-f5f9ee` → 生成
  `retro/run-20261110110922-f5f9ee.md`，写入 `F-403`；`facts.mjs query --tag forensics` 能检索到
  `F-403 [forensics] 「easycap」（forensics/medium）用单轮编排跑通，24.68 min，1401k tok`。
- 失败样本：`runs/20261113053805-d4723b` → `failureFamily=no-candidate`，claim 正确带出原因前缀。

## 三、已知限制

1. run 级卡的 `skills` 取 `meta.skills`，普通 `eva-super` 运行没有该字段（只有 race 调度会填），所以 run 卡技能常为空。
2. 失败分类沿用调度器的五类启发式；`unknown` 表示原因文本不匹配任何规则，需要人工看 `verdict.reasons`。
3. 复盘卡不做「有效技能」的因果判断——只记录当次用了哪些技能、结果如何，是否有效留给人工复盘。
4. facts 的 `dedup_key` 未由本工具写入（`facts.mjs` 会按 claim 归一化后现算），因此同题重跑会产生多条相似的复盘事实，
   需周期性跑 `facts.mjs dedupe --threshold 0.7` 出建议。

## 四、回滚

```powershell
Copy-Item _backup\20261113-p2\* . -Recurse -Force
node test/selftest.mjs      # 期望回到 44/44
```

已写入的 `F-403` 属真实复盘产物，回滚代码不回收该事实；如需撤回，按 AGENTS §6 的「只标 superseded、不物理删除」处理。