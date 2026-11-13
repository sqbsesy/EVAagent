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
- 本机现状：`stateDir` 已补进 desktop profile 并做过启动联调（见下节）；`gh` 2.103.3 已安装并登录
  （`gh api user --jq .login` → `sqbsesy`），但 GitHub Source 在 Windows 上**不可用**，
  保持 `disabled`，端到端（事件→Ticket→CLI→回帖）无法在本机验证。三处阻碍与绕过办法见
  `docs/INTEGRATION.md` 第 7.2 节（panel-only 配置、上线检查 spawn Unix `env`、
  `stateDir` 的 `/` 前缀与 DSH 盘符全限定冲突）。

## P1：计量、跨 run 预算、基准脚本（2026-11-10）

- **计量修正**：`sdk.mjs` 从工具事件累计 `toolChars`；`usage` 缺失时
  `Ledger.addEstimate()` 按 `(prompt+reply+toolChars)/3.5` 估算并乘 `budget.estimateMultiplier`
  （默认 1.5），条目保留 `raw` 便于审计。理由：live 首跑 usage=null，旧逻辑只记 856 tok，
  与真实工具面（~57k tok 常驻）相差两个数量级。
- **跨 run 预算**：`lib/budget.mjs` 的 `challengeSpent()` 取
  `runs/*/meta.json`+`result.json` 与 `.dsh/memory/costs.jsonl` 两者较大值，dry-run 不计；
  `effectiveRunBudget()` 返回 `min(perRun, perChallenge-prior)`，<=0 立即 `config-error`。
  理由：单题 3.5M 是「本题」总量，不是「每次 run」额度。
- **基准脚本**：`bin/eva-bench.mjs` 顺序跑 N 题、写 `runs/bench-<stamp>/bench.{json,md}`，
  遇余额/适配器错误立即中止（exit 3）。默认 `easycap,bluetrace,lfsr`。

## 基准首跑与账号闸（2026-11-10）

- `eva-bench --challenges easycap,bluetrace,lfsr` 首跑 **0/3**：三题均在 recon 回合返回
  `Insufficient Balance (request_id: ...)`，合计 4,354 tok（全部为估算，usage=null），112 s。
  单题复测 `--challenge easycap` 同样 22 s 内失败，证实是账号余额而非代码。
- 据此增加 `FatalStop`：`lib/run.mjs` 匹配
  `Insufficient Balance|no adapter registered|invalid exact model metadata|missing API key` 时整条
  流水线中止（`config-error`，退出码 3），不再把 recon 失败降级成单线任务空转（selftest 16/16）。

## 仓库状态（2026-11-10）

- 已 `git init`（本地 main），P0 提交 `ab113f2`，后续文档与 P1 提交见 `git log`。
- **已推送** `https://github.com/sqbsesy/EVAagent`（`main`，`origin` 跟踪，凭据由 Git Credential Manager 保存）。
- **prototype 已挂进 desktop profile 并联调通过**：patch 加 `- id: dsh-superagent` + `stateDir`，
  `dsh-superagent-github` 先 `disabled: true`（缺 gh）。用临时克隆档 `satcheck` 验证：插件激活、
  `prototype-state/orchestrator.sqlite` 落盘、`/orchestrator/api/{tickets,settings,prompts}` 均 200；
  验证后删除临时档。生效需完全退出并重开 DSH。
  - 关键坑：`stateDir` schema 为 `/^\//`，Windows 上必须写 `/Users/...` 而非 `C:/...`，
    否则报 `$.stateDir expect string to match regexp /^\//` 且插件不激活。
- **推送通道**：本机对 `github.com:443` 时通时断，`.git` 推送多次超时/重置；改用
  `api.github.com`（稳定可达）+ Git Data API 生成同一 tree 的提交并 PATCH ref，
  SHA 会因消息末尾换行被规范化而与本地不同，随后在本地 `hash-object -w` 重建并
  `update-ref` 对齐（脚本 `work/eva-superagent/_scratch/api-push.mjs`）。
- **live 运行仍被余额阻塞**：`sdk` profile 仅注册 `deepseek-account` 适配器，返回
  `Insufficient Balance (request_id: ...)`；已试 `--patch` 挂 `dsh-our-free-model`，插件能加载但
  未注册 `our-free-model` 适配器（Host 半身绑定 desktop 的 web 组合），不可用。10 题回放待充值。

## 工具链修复与计量口径（2026-11-10 晚）

- **审批无人应答是「每轮挂 5–12 分钟」的真因**：SDK 运行时在 `initialize` 传
  `approvalRequests:true` 时，会把 `approval/request` 反向发回客户端，要求回
  `{outcome:"allowed-once"|"rejected"}`；此前 `lib/sdk.mjs` 忽略所有带 id 的入站请求，
  工具调用一直等到超时。现在 `answerInbound()` 统一应答，策略由 `EVA_DSH_APPROVAL`/构造参数控制（默认 allow）。
- **usage 只在 `assistant/message` 与 `turn/end` 上**，`step/end` 没有；`turn/end.usage` 是聚合值。
  `addUsage()` 现在同时累计 `cacheReadTokens`。
- **计量按缓存权重折算**：`usage.totalTokens` 含缓存读（一次 worker 轮次原始 3.1 M，缓存占 90%+），
  全额计入会让 1.2 M 预算在单轮内爆掉。改为 `input+output+cacheRead*cacheWeight`，
  `cacheWeight=0.1` 写在 `policies/budget.json`；原始值存 `ledger.entries[].raw` 与 `turn/end.rawTokens`。
- **单轮落账后立刻 `ledger.check()`**：超预算的 run 以 `partial` + `budget-exhausted` 收尾，
  不再继续跑后面的 worker。
- **候选默认落盘**：worker 输出 `candidateFile`（工作区或题目目录内、纯文本、≤2KB）；
  `verdict.json`/`pending.json` 只记 `file:<相对路径>`；`eva-submit` 从文件读第一行。
- **兜底扫描**：worker 常把还原出的答案当「中间产物」（本轮 `raw38.bin` 就是 `FLAG:...`），
  没人认领时在 `<题目>/super/` 下按 flag 形态扫本轮新写文本，命中即写 `super/_candidate.txt`
  并以 `file:` 形式进入复核；事件 `candidate/scan`。

## 3 题基准（2026-11-11，pi-ai）

命令：

```bash
node bin/eva-bench.mjs --challenges easycap,bluetrace,lfsr --ignore-prior \
  --budget 2000000 --patch integrations/sdk-pi-ai.patch.yml \
  --provider qwen-token-plan-cn --model deepseek-v4.1-flash --max-seconds 3300
```

| 题目 | 结果 | 花费 | 墙钟 | 备注 |
| --- | --- | ---: | ---: | --- |
| easycap | verified / pass | 1,166,390 | 2140 s | 4 worker + verifier 全跑通 |
| bluetrace | failed / reject | 1,492,319 | 2290 s | 4 worker 均有 30–52 k 工具输出，无候选 |
| lfsr | failed / reject | 1,300,972 | 2516 s | 3 个 worker 720 s 超时；t2 实际已解出 |

- 合计 **1/3 verified，3,959,681 tok**。
- `easycap` 的候选来自 verifier 复核：38 B TCP 单字节通道（sha256 `db5cff21…`），
  提交形态 `KEY:32hex`，`eva-submit --dry-run` 与 verifier 记录一致。
- `lfsr` 的 `super/t2/t2_candidates.json` 已经给出 64 字符的可打印明文与 seed，
  但 worker 没写 `candidateFile`、兜底扫描只认 `flag{…}`/`FLAG:`/纯 hex 行，
  于是整条流水线判「无候选」。**这是检测面窄，不是解题能力不足**。

### 本轮暴露的问题（已修 / 待修）

- 已修：recon 把 `super/` 旧产物当「已解过半」（`easycap` 的 t2 因此只回 `"finding":"pending"`）→
  recon 文件清单排除 `super/ runs/ turns/ verify/`。
- 已修：worker 回 `"finding":"pending"` 也算产出 → 空/pending/run 之类直接判任务失败。
- 已修：`FLAG_SHAPE` 只匹配三种形态，JSON 里的人读明文（`inner_text`、`plaintext`、`key` 字段）
  不会被识别；现在扫描器同时匹配「候选字段名 + 长度 ≥ 8 的可打印串」，扫描上限从 2 KB 放宽到 64 KB，乱码候选被过滤（自测 20/20；对 lfsr 的 `t2_candidates.json` 实测能取到那段 64 字符明文）。
- 待修：hard 题 4 个任务、2 worker，单轮 720 s 仍偏紧（lfsr 三连超时）；
  已按 difficulty 乘 1.5，但 recon 若把 hard 判成 medium 就不生效，应按 plan 的 route 取值。

## 下一步

1. 充值或指定可用 provider 后跑 10 题回放（`bin/eva-replay.mjs`），按四项指标验收；
2. 视回放结果调 `agents/*.md` 契约与并发/预算参数；
3. 决定是否把 `runs/` 只读视图挂到控制台（D2 后期）；
4. GitHub Source 若确需自动接单，需在 WSL/macOS/Linux 上跑 prototype；Windows 本机用
   `gh issue view` + `eva-super.mjs --task` 手动转工单。
## 并发覆盖（2026-11-11）

- `--workers N` 现在是**显式覆盖**：`workerOverride=true` 时只受 `surface.hypotheses.length` 与 `workerMax` 限制，不再被 `DIFFICULTY_WORKERS`（easy 1 / medium 2 / hard 2）压回。默认（不传）仍按难度分级。
- 起因：bluetrace 有 4 个任务，但并发一直被压到 2，2290 s 里大半在排队；传 `--workers 3` 之前无效。

## lfsr 通过（2026-11-11 11:43）

- `bench-20261111031039`：`lfsr` **verified / pass**，1,541,758 tok，1944 s，3 并发、单轮 20 min。
- 通过的最后一环是三处修复：全角标点 JSON 修复（recon 不再降级）、历史产物警示（不再审计 `solve*.py`）、
  worker 拿到候选立刻落盘 + 20 min 单轮。此前两轮分别 1.30 M / 0.73 M tok 全败在“没产出候选”。
- 当前离线基准：easycap ✅、lfsr ✅、bluetrace ❌（21.5 MB BTSnoop 抓包，需写 HCI/L2CAP/RFCOMM 解析器，4 个 worker 均在 18–20 min 被强杀）。


## bluetrace 第三跑：前情指令化（2026-11-11 下午）

- 现象：`--notes` 首次实现只把前情当「背景」放进 recon，recon 仍给出 generic 单任务计划
  （misc/easy/1 task），且一处 CLI 漏传导致前情根本没进提示词。已修：CLI 传 `hintText`，
  题目模式下 `task: taskText || hintText`，让 recon 把前情当任务指令；新增回归自测（22/22）。
- 指令化后的计划质量明显好转：`forensics/medium`，4 个任务（提名字 → ZipCrypto 校验 → 解密 → 取 flag）。
- 结果（`runs/20261111061309-92692a`，3 M、2 并发、`--scaffold`、max 5400）：**failed/reject，
  2,693,104 tok，3,636 s（60.6 min）**。scaffold 20 min 超时烧 880,475 tok；t1/t2/t3 各 20 min 超时，
  合计 1.23 M；无候选，verifier skip。
- 结论：卡点不在「计划」而在「单轮 20 min 仍不足以把 HCI/L2CAP 重组 + 口令枚举做完」。
  已加限制：脚手架单轮 `min(turnWallClockSec, 600)`，避免铺路阶段吃掉预算。
- 下一步建议：把「名字提取」与「ZyCrypto 校验」拆成有依赖的两轮（前者 10 min 硬超时、产出候选名清单落盘），
  或在题目目录预置已知的 `extract_names.py`，让 worker 只做校验与解密。

## 三项调度优化（2026-11-11 晚）

针对「bluetrace 三跑 2.69 M 仍未过」暴露的三个结构问题，落地三机制（自测 28/28）：

1. **预置探针**（自动）：`findProbes()` 扫题目目录 `probes/**`（深度 ≤2）与根目录 `probe*/extract*`，
   把文件头 160 字符摘要注入 worker 提示词「## 预置脚本（…禁止重写）」。目的：把「已知怎么解析」
   从模型手里拿走——bluetrace 的 18 min 全花在重写 pcapng 解析器；现在只要题目目录里有 `probes/extract_names.py`，
   worker 只做校验与解密。事件 `probes/found`，plan/report 记录数量。
2. **依赖化分段**（`--staged`）：recon schema 增 `dependsOn`/`artifact`，`orderStages()` 拓扑排序
   （成环/悬空引用则回退并行并写 `plan/staged-invalid`），逐段串行、单段 `min(turnWallClockSec, stagedTurnSec)`、
   产物缺失写 `stage/missing` 并 `stage/skipped` 下游。默认 `stagedTurnSec=600`（`--stage-seconds` 可覆盖）。
   解决「4 路并行时 t2 拿不到 t1 的名字只能猜」。
3. **起跑前预算预留**（自动）：`admitTurn()` 以 `remainingRun()` 为准，`usable=剩余*(1-reserveShare)`，
   按 `stagesLeft` 平分出每段 cap（与角色上限取小），剩余 < `minReserve=20000` 直接拒绝。
   事件 `turn/admit`；单轮实测超 cap 1.5 倍写 `turn/over-cap` 便于事后追账。
   解决「闸门只在轮间检查、3 个并发轮各冲 600 k」。

`policies/budget.json` v2：新增 `verifierTokens: 300000`、`stagedTurnSec: 600`、`reserveShare: 0.2`、`scaffold: false`。
新增事件已写进 README「三个调度机制」表；`env` 仍只认 `EVA_DSH_*`，无新增密钥。
## 单题 30 分钟上限与墙钟感知调度（2026-11-13）

- `--max-seconds` 语义从 "bench 强杀" 改为 "整题墙钟配额"：eva-super 收到后按剩余时间 / 剩余段数给每段算超时
  （当前段 ×1.3 余量，下限 240 s，上限 1200 s），预算不够时抛 `BudgetStop` 正常收尾，不再被 bench 砍掉。
- 串行段基础 `stagedTurnSec` 540 → 420；recon 提示词要求每段 360–420 s、最后一段 720 s、计划最多 3 步。
- 阶段成链（`plan/chained`）：即使 recon 给出并列 dependsOn，也强制串成链，前段失败后面全部跳过。
- 产物认领（`stage/adopt` / `stage/adopt-partial`）：worker 把产物叫成 `surface.json`、`answer.txt` 时，
  取本段最新 json/txt/md（>200 B）复制成 artifact 名；超时但产物已落盘时按部分成功继续，不再整轮白烧。
- staged 模式关闭低置信回炉（`rounds` 只对并行模式生效）：回炉在有限墙钟下只会再烧一段。
- 实测：`bench-20261113053805` 用 1642 s / 880,028 tok 跑完 recon + t1 + t2 + t3（三段都靠认领续链），
  t1 只写 `stage_inputs.json`、t2 `carriers.json`、t3 `answer.txt`（pcapng 结构报告），无候选 → reject；
  回炉段（240 s）已由本次修复去掉。