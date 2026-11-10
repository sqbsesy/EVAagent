# 与 dsh-superagent-prototype 对齐

本文说明本仓库（EVA Supervisor CLI）与 `dsh-superagent-prototype`（下称 prototype）的分工、
调用契约和落地步骤。两者不是替代关系：prototype 管「什么时候该干活、给谁回话」，
本仓库管「这一次解题怎么干、花多少、证据在哪」。

## 一、分层

```text
GitHub Issue / PR 评论 / （可选）飞书消息
        │
        ▼
dsh-superagent-prototype          # 事件 → Policy 评估 → Ticket（admission）
  ├─ router Session               # 判断该不该接、拆成几条 Ticket（不写盘、无 subagent）
  └─ worker Session × N            # 每 Ticket 一个独立 Session + 独立目录
        │  工作目录里有 AGENTS.md，Session 启动即读到本仓库的第七条约定
        ▼
node <repo>/bin/eva-super.mjs --task "<工单标题+要点>" --task-dir <当前目录> --json
        │
        ▼
runs/<runId>/  (meta/plan/state/events/ledger/verdict/report/turns/submissions)
        │
        ▼
worker Session 回帖：runId / status / verdict / spent / runDir + report.md 摘要
```

## 二、职责边界

| 关注点 | prototype | 本仓库 |
| --- | --- | --- |
| 事件接入（GitHub / 飞书） | ✅ | ❌ |
| 准入判断、限流、去重、Ticket 生命周期 | ✅ | ❌ |
| 每票独立 Session 与目录 | ✅ | ❌ |
| 回帖 / 开 PR | ✅ | ❌ |
| 侦察、分流、拆解、并行、复核 | ❌ | ✅ |
| 预算闸与台账 | ❌ | ✅ |
| 证据链（`file:line` + 复现命令） | ❌ | ✅ |
| 提交（人工 `--confirm`） | ❌ | ✅ |

一句话：**prototype 决定「做不做」，本仓库决定「怎么做、值不值、算不算数」。**

## 三、调用契约

prototype 的 worker Session 只做三件事：读工单 → 调 CLI → 回帖。

```bash
node <repo>/bin/eva-super.mjs \
  --task "<工单标题>\n<正文要点，去掉无关寒暄>" \
  --task-dir "<当前 Session 目录>" \
  --budget 1200000 \
  --json
```

- `--task` 与 `--challenge` 二选一；工单模式不要求目录像题目，目录只作工作区。
- 工单文本会写进 `runs/<runId>/meta.json` 的 `task` 字段和 `report.md` 的「工单：」行。
- `--json` 输出单行 JSON，含 `runId`、`status`、`verdict`、`spent`、`runDir`、`report`。
- 预算闸触发返回退出码 4，Session 应原样回报，不得自行加预算重跑。
- 禁止：把 flag 原文写进 Issue/PR；在工单会话里加 `--confirm` 自动提交。

## 四、配置步骤（desktop profile）

本机 `dsh-superagent-prototype@0.1.3` 已在 desktop profile 的 `dsh.profile.bundles` 里，
其 bundle 层 `cordis.patch.yml` 已 insert 了以下条目（无 config）：
`dsh-superagent`、`dsh-superagent-github`、`dsh-superagent-feishu`(disabled)、
`dsh-superagent-worker-preset`、`dsh-superagent-router-preset`。

插件在缺 `stateDir` 时**拒绝启动**，因此必须在 profile 的 `cordis.patch.yml` 覆盖该条目：

```yaml
- id: dsh-superagent
  config:
    stateDir: /Users/<you>/Documents/deepseek-harness/EVA/work/eva-superagent/prototype-state
    promptMaxChars: 6000
    admissionContextMaxPages: 3
    admissionContextTimeoutMs: 20000
```

> **Windows 注意**：`stateDir` 的 schema 是 `z.string().regex(/^\//)`，只接受**以 `/` 开头**的路径。
> 写 `C:/Users/...` 会在启动时报
> `invalid config: - $.stateDir expect string to match regexp /^\// (at stateDir)`，
> 插件不激活（日志里是 `warning: 1 entry did not activate`）。
> 本机可用 `/Users/<you>/...`：Node 在 Windows 上把它解析为当前盘符根目录下的路径（本机即 `C:`），
> 实测 `orchestrator.sqlite` 正确落在 `C:\Users\...` 目录。

模板见仓库 `integrations/dsh-superagent/profile.patch.example.yml`。要点：

1. patch 条目按 `id` 索引，`config` **整体替换**而不是深合并，所以要写全（其余字段走默认）。
2. 状态落在 `join(stateDir, "orchestrator.sqlite")`；执行目录默认 `join(stateDir, "work")`，
   可用 `settings.executor.directory` 改到题目目录。
3. GitHub Source 还需要 `gh` CLI 已登录（本机当前 **未安装 gh**），`github` 配置形如
   `{ cli: "gh", login: "<username>", noreply: "<id>+<user>@users.noreply.github.com" }`
   —— 该条目字段以 `--dump-config` / Web 面板为准，本仓库只作示例。
4. 改完 patch 需完全退出并重开 DSH（运行中的 Host 不会重读）。
5. 仓库根的 `AGENTS.md` 会被 worker/router Session 自动加载（上限 65536 字节），
   第七条即调用约定，无需重复粘贴到工单里。

## 五、状态与产物

- 本仓库产物：`runs/<runId>/`（gitignored）。
- prototype 产物：`<stateDir>/orchestrator.sqlite`、`<stateDir>/work/<ticket>/`。
- 两者通过 `stateDir` 与 `meta.task` 关联；排查时先看 `runs/<runId>/events.jsonl`，再看 Ticket 记录。

## 六、本机落地与验证（2026-11-10）

已改动 `~/.dsh/profiles/desktop/cordis.patch.yml`（备份：`cordis.patch.yml.bak-sat-20261110122508`）：

```yaml
- id: dsh-superagent
  config:
    stateDir: /Users/20606/Documents/deepseek-harness/EVA/work/eva-superagent/prototype-state
    promptMaxChars: 6000
    admissionContextMaxPages: 3
    admissionContextTimeoutMs: 20000
- id: dsh-superagent-github
  disabled: true
```

联调方式与结果（不改动正在运行的 desktop 实例）：把 desktop profile 复制成临时档 `satcheck`
（`node_modules` 用 junction 指回 desktop），用 `--dump-config` 与真实启动验证，验证后删除临时档。

| 检查 | 结果 |
| --- | --- |
| patch 解析并覆盖 bundle 条目 | ✅ 输出里有 `# == dsh-superagent-prototype, patched by ...` |
| 插件激活 | ✅ 无 `did not activate` 告警 |
| 状态目录落盘 | ✅ `prototype-state/orchestrator.sqlite`（含 `-shm`/`-wal`） |
| 面板后端 | ✅ `GET /orchestrator/api/tickets` → `{"items":[],"total":0,...}`；`/settings`、`/prompts` 均 200 |
| GitHub Source | ⏸ 未启用（`disabled: true`，缺 `gh`） |

生效条件：**完全退出并重开 DSH**。重开后 Web 面板地址为 `/orchestrator`（服务端只注册
`/orchestrator/api/*`，裸 `/orchestrator` 返回 404 属正常；同源校验要求请求头
`x-orchestrator-request: 1`）。

## 七、启用 GitHub Source（安装 gh）

本机已装 winget（v1.29），用官方源安装：

```powershell
winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
```

装完**新开一个终端**（PATH 里是 `C:\Program Files\GitHub CLI\gh.exe`），确认：

```powershell
gh --version
```

登录（二选一）：

```powershell
# A. 交互式（浏览器 device flow，需能打开 github.com/login/device）
gh auth login --hostname github.com --git-protocol https --web

# B. 用已有令牌（本机 GCM 里存过 repo scope 的 token；--with-token 需要读 stdin）
$tok = ("protocol=https`nhost=github.com`n`n" | git credential fill) |
  Where-Object { $_ -match '^password=' } | ForEach-Object { $_ -replace '^password=','' }
$tok | gh auth login --hostname github.com --git-protocol https --with-token
Remove-Variable tok
```

校验（`repo` scope 足够读写 Issue/PR）：

```powershell
gh auth status
gh api user --jq .login
```

然后改 `~/.dsh/profiles/desktop/cordis.patch.yml`，把 `dsh-superagent-github` 的
`disabled: true` 去掉并补 config（字段以 `--dump-config` 校验为准）：

```yaml
- id: dsh-superagent-github
  config:
    stateDir: /Users/<you>/Documents/deepseek-harness/EVA/work/eva-superagent/prototype-state
    repository: sqbsesy/EVAagent
    github:
      cli: gh
      login: <github-username>
      noreply: <id>+<username>@users.noreply.github.com
```

改完完全退出并重开 DSH，再看 `GET /orchestrator/api/settings` 里 GitHub Source 是否 enabled。
注意 `gh` 是给 prototype 的 worker/router Session 用的；本仓库的 `eva-super.mjs` 不依赖它。

## 八、尚未验证

- `dsh-superagent-github` 的 config 字段以源码类型 `Deployment` 推断，未在本机跑通端到端
  （缺 `gh`，且该条目当前 disabled）。
- 飞书 Source 默认 disabled，未配置。
- 挂载后 UI 面板的人工操作（建 Ticket、看回帖）未实测。