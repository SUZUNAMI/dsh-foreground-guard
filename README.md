# dsh-wait-guard — 前台等待守卫

> 仓库：<https://github.com/SUZUNAMI/dsh-wait-guard>（私有）

一个 DSH Host 插件：在 `tools/pre-execute` 上做**前台等待门控**。违规的调用默认被拒绝；
开启 `promptOnViolation` 时改为**由你手动授权**——批准后本回合豁免，
拒绝后本回合不再打扰。它不依赖提示词依从性，对子代理同样生效；授权通道与沙箱/权限模式解耦。

## 为什么需要它

AGENTS.md 里的「前台等待禁止超过 1 分钟」管不住模型：规则的代价为零，而且「不超过 1 分钟」
本身留了 45s 的合法空间，模型会反复 45s 等待再查询。日志实测（本工作区会话）：

| 形态 | 日志命中 | 问题 |
|---|---|---|
| `Start-Sleep -Seconds 100` | 4 | 单发就破 60s |
| `Start-Sleep -Seconds 20/30/40` | 16/6/4 | 贴线等待 |
| `for(i<9){Sleep 10}`、`for(i<60){Sleep 30}` | 4/6 | 单条命令内累计 90s～30min |
| `Sleep -Milliseconds 500` | 3 | 无害 |

## 判定规则

| 规则 | 触发条件 | 默认动作 |
|---|---|---|
| 单次上限 | 命令里任一静态 sleep > `maxSleepSeconds`（60s） | 请求授权 |
| 回合预算 | 本回合累计等待（sleep 之和 + `job_output` 等待）> `turnBudgetSeconds`（60s） | 请求授权 |
| 前台超时 | shell 工具声明 `timeoutMs` > `maxForegroundTimeoutSeconds`（60s）且非后台 | 请求授权 |
| 放行 | `run_in_background: true`、毫秒级 sleep、`wait_agent`（默认不计入）、无 agent 的程序化调用 | 直接放行 |

**授权语义（一次一回合）**：首次违规问一次。
- 审批策略允许（`ask`）→ 走宿主审批框；`allowed-once` 即放行。
- 审批策略是 `never`（例如切到 `danger-full-access` 并关掉审批）→ 改走 `ctx.userQuestions.ask()`
  的**问答卡片**（带“允许/拒绝”按钮），这条通道不受审批策略影响；批准同样豁免本回合。
- 你点允许 → 本回合后续等待全部放行、不再询问。
- 你点拒绝 → 本次调用报错，且本回合后续违规**直接拒绝、不再弹框**。
- 两条通道都问不到人（无服务、子代理 `DELEGATED_CALLER`、被取消）→ 直接拒绝，且不会把
  「问不到人」误记成「用户拒绝」。
- 新用户消息 → 预算与授权状态清零。

拒绝时的模型侧文案（预算示例，就是你确认过的那版）：

```text
Error: wait-guard 拒绝：本回合前台等待已用 25s，再加这次 40s 会超过单回合预算 60s。
不要轮询，后台任务完成会自动唤醒你；需要等条件成立请用 sentinel_watch。
```

若你把 `promptOnViolation` 关掉、或部署没有审批通道，则直接给上面这段拒绝文案（前缀换成对应规则）。

## 配置

`cordis.patch.yml` 行 config（改完重装或重启）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxSleepSeconds` | 60 | 单条命令内任一 sleep 的上限 |
| `turnBudgetSeconds` | 60 | 每回合前台等待总预算 |
| `maxForegroundTimeoutSeconds` | 60 | 前台命令可声明的 `timeoutMs` 上限 |
| `promptOnViolation` | true | 违规时弹授权框；false 则直接拒绝 |
| `countJobWait` | true | `job_output(wait:true)` 计入预算 |
| `countWaitAgent` | false | `wait_agent` 计入预算 |
| `countRemoteExec` | true | `remote_exec` 的 `timeoutSeconds` 计入预算 |
| `shellTools` / `terminalTools` | `pwsh,bash` / `terminal_send` | 需要解析 sleep 的工具名 |
| `promptNotice` | true | 注入一段系统提示，把策略提前告诉模型 |
| `debugFile` | 无 | 填绝对路径即开启诊断日志（每次 pre-execute 的关键节点） |

非法值在插件加载时直接抛错（fail loud），不会静默降级。

## 配套的 L1 配置钳制（不在本仓库里）

`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾（2026-11-14 添加）：

```yaml
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  config:
    timeoutMs: 60000
    pwshPath: 'C:\Program Files\PowerShell\7\pwsh.exe'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
  config:
    maxWaitTimeoutMs: 60000
```

- `timeoutMs: 60000`：前台命令 60s 未结束就转成后台 job（`promoteOnTimeout` 默认 true，不杀进程）。
- `maxWaitTimeoutMs: 60000`：`job_output` 的等待被钳到 60s。
- `pwshPath`：本机 Store 版 pwsh 的 App Execution Alias 消失导致沙箱 runner 起不来
  （`CreateProcessAsUserW failed (Win32 2)`），显式指向 Program Files 的 7.x。

## 运行与验证

```powershell
node test/smoke.mjs                 # 25 项离线用例，用假 ctx/假审批服务驱动门控
```

安装（link 本地目录；改代码后 `remove_bundle` + `install_bundle` 即可热替换，**不保证生效，行为没变就重启**）：

```
git clone https://github.com/SUZUNAMI/dsh-wait-guard.git C:\Users\Z\日常问题\dsh-wait-guard
plugin_manager action=install_bundle target=link:C:\Users\Z\日常问题\dsh-wait-guard
```

更新：`git pull` 后同样 `remove_bundle` + `install_bundle`（或重启）。

上线自测：让 agent 跑 `Start-Sleep -Seconds 100`——你会看到审批框；点允许则它真的睡 100 秒，
点拒绝则模型立刻拿到 `Error: wait-guard 拒绝：…`。

## 已知边界

- 只能静态解析常见写法（`Start-Sleep`/`sleep`/`timeout /t`/`time.sleep(N)`）。变量拼接
  （`-Seconds $n`）、脚本文件内部的 sleep 抓不到；这类由 L1 的前台超时兜底。
- 循环内的 sleep 按字面量计一次，不乘迭代次数；同样由 L1 兜底。
- 授权框会**阻塞这一步**直到你作答（和沙箱升级审批同一机制）。无人值守时要么关掉
  `promptOnViolation`，要么接受它一直等。
- 授权按「回合 + agent」记：子代理自己的回合单独计，不会蹭主代理的授权。
- 门控是同步判断、异步只发生在授权那一步；它不记录自己的持久状态，重启即清零。
- **改代码后 `remove_bundle` + `install_bundle` 不保证热替换**（实测有一次没生效，重启后才换上新模块）。
  换完先自测一条违规；行为没变就重启 DSH。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 插件本体：解析器 + 门控 + 授权请求 + 提示段落（零 DSH 依赖） |
| `cordis.patch.yml` | bundle 补丁，插入 `wait-guard` 行与默认阈值 |
| `test/smoke.mjs` | 25 项离线冒烟用例 |
| `locale/{en,zh}.json`、`icon.svg` | 插件列表里的标题、描述与图标 |

## 状态

2026-11-14：0.2.0。

| 验证项 | 结果 |
|---|---|
| 28 项离线用例 | 全过 |
| 会话审计 `approval/asked → approval/decided` | 两条 wait-guard 请求，你分别 4.3s / 2.1s 点了允许 |
| 单次 100s sleep | 0.1.0 时硬拒；0.2.0 改为弹框（实测弹出并批准） |
| 回合累计 25s+40s | 第二次被预算拒绝（0.1.0 实测） |
| `timeoutMs: 300000` | 弹框；修复前文案出现 `NaNs`，0.2.0 已改为真实秒数并有离线用例锁定 |
| 拒绝路径（你点拒绝） | 实测：文案带真实 `300s`，本回合后续直接拒绝 |
| `danger-full-access` 下的拦截 | 实测：`300s` 超时、`100s` sleep 仍被拒——门控不经过沙箱/权限层 |
| 策略 `never` 下的授权 | 实测：trace 显示 `policy=never` → `userQuestions=function` → 你选“允许” → `verdict=granted`；同回合第二次违规直接放行 |
| 65s 前台命令 | 60s 处转后台 job（L1 生效） |
