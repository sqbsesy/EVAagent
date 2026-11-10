# 运行约定（草案）

继承 EVA 工作区 `AGENTS.md` 的安全、目录与成本纪律；以下是 Supervisor 层追加的硬规则。

## 一、角色隔离

- Supervisor 只做调度与仲裁，**不直接产出 flag**。
- Worker 只对自己的单假设负责，不读其他 Worker 的结论（避免锚定）。
- Verifier 独立复算，不复用 Worker 的中间结论，只复用产物文件。
- Scribe 只写台账，不改结论。

## 二、预算

- 单题 3.5 M tok；单 run 1.2 M tok；Worker 上限 2，单 Worker 400 k。
- 用量到 run 预算 60% 时，Supervisor 必须收敛到单线并停止新扇出。
- 超预算由 `policies/budget.json` 硬停，不靠提示词自觉。

## 三、证据

- 每个 finding 必须带：产物相对路径、行号或偏移、可复现命令、置信度。
- 只有「可离线复算」的结论才能进入 Verifier。
- Verifier 不通过 → 最多回炉一次 → 二次不过标记 partial。

## 四、提交

- 默认 `manual`：Verifier 通过后仍需人工确认。
- 提交前校验：格式、唯一性、来源、是否为本次算出。
- 比赛期遵守平台规则（只提交自己算出的 flag；环境启停受限）。

## 五、内容安全

- 汇总层只写结构（路径/字段/长度/哈希），不逐字复现载荷。
- 样本与利用代码一律落文件，回复用文件名指代。
- 命中输出审核后不原样重试，先降低敏感密度。

## 六、目录

- 运行产物：`runs/<runId>/`（gitignored）。
- 题目产物：`work/<题名>/`，与现有约定一致。
- 不向仓库写入凭据、flag、附件原文。

## 七、工单模式（与 dsh-superagent-prototype 对齐）

- 本仓库的 GitHub 工单由 `dsh-superagent-prototype` 转成 Ticket，每个 Ticket 在独立 Session 中执行，
  工作目录即该 Session 的目录。
- Session 拿到「解题 / 复核 / 复现」类工单时，**调用本 CLI 执行**，不要自己另起一套流程：

  ```bash
  node <repo>/bin/eva-super.mjs --task "<工单标题 + 正文要点>" --task-dir <当前目录> --json
  ```

- 只把 CLI 的 JSON 结果（`runId`/`status`/`verdict`/`spent`/`runDir`）与 `report.md` 路径回帖；
  不要把 flag 原文写进 Issue、PR 或评论。
- 提交仍走人工确认：`bin/eva-submit.mjs --run <runId> --challenge <id> --ground <id> --confirm`，
  Ticket 会话不得自行加 `--confirm`。
- 工单与本地 run 的对应关系写在 `runs/<runId>/meta.json` 的 `task` 字段，便于回查。
- 若 Ticket 属于仓库自身开发（非解题），按普通工程流程处理，不触发 CLI。