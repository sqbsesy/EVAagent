# workflows（P0 待实现）

DSH `workflow` 工具的脚本目录。设计约束：

## solve.ts

1. **recon**：Supervisor 读题面/附件清单，产出 `surface.json`。
2. **route**：按难度分流（easy 1 线 / medium 2 线 / hard 2 线 + verifier）。
3. **solve**：`parallel()` 扇出 worker，每个 worker 只领一个「产出物 + 验收方式」齐全的子任务。
4. **verify**：Verifier 独立复算，产出 `verdict.json`。
5. **report**：写 `runs/<id>/` 与台账，按 `policies/submit.json` 决定是否进入提交门禁。

## 硬约束

- 单 worker 单回合 ≤ 12 min；到点回收。
- 预算 60% 后停止新扇出（`policies/budget.json` 的 `convergeAt`）。
- 所有中间结论落文件，workflow 只传路径与摘要。
- 子代理不继承 MCP 激活状态，统一用 `mcp-lazy call`。

## 为什么先不写实现

P0 的提示词契约（`agents/*.md`）与闸门（`policies/*.json`）先定稿，再接 `workflow`；
否则很容易写成「能跑但不可验收」的脚本。实现顺序见 `docs/DECISIONS.md`。