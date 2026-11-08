# Changelog

## 1.0.12 — 2026-11-08

**`psh_elevated` 的"实时输出"之前是假的：真机一测就空**

- 症状：`psh_elevated` 跑一个先打印、再 `Start-Sleep -Seconds 180` 的命令，
  第 4 秒去读 `stdout.txt` 是**空的**，但那一行明明早就该打印了。
- 根因：宿主脚本用 `$items = & ([ScriptBlock]::Create($body)) *>&1` 收集输出，
  **数组要等整个 block 返回才有值**，`foreach` 才开写文件。命令跑多久，
  文件就空多久。之前 10:51 那次"看到 tick 一行行出来"的验证之所以通过，
  是因为整段代码 1 秒内就跑完了，看起来像流式而已。
- 修法：换成 **runspace 的 `PSDataCollection` + `DataAdded` 事件**，
  每产生一项就立刻写文件（`AutoFlush = true`），不等 block 结束。三个坑：
  - `Register-ObjectEvent -InputObject $pipe -EventName DataAdded` 不行：
    `PowerShell` 对象上没有 `DataAdded` 事件，事件挂在 `PSDataCollection` 上。
  - `[System.Management.Automation.DataAddedEventHandler]` 不是可解析的类型名，
    直接给 `add_DataAdded` 传 scriptblock，让它自己转委托。
  - `BeginInvoke($null, $outColl)` 会报"找不到重载"：泛型参数绑不上字面量 `$null`，
    **输入和输出都必须是真实的 `PSDataCollection` 实例**。
- 连带修 `$LASTEXITCODE`：body 现在在独立 runspace 里跑，宿主的 `$LASTEXITCODE`
  永远不会被它改。改为在 body 末尾追加 `"__DSHPS_EXIT__:$LASTEXITCODE"` 回传，
  发射器把这个控制行丢掉（不能当成用户输出），宿主用它定 `result.txt`。
  优先级：已有失败码 > 显式 `exit N` > body 回传码 > 宿主 `$LASTEXITCODE`。
- 新增 `test/elevated-stream-check.mjs`：跑一个三行、每行间隔 900 ms 的命令，
  从外面每 100 ms 采样 `stdout.txt`，断言在 `done.txt` 出现之前就读到内容。
  实测：**第一行 757 ms 落到文件**，而整段要 1.8 秒才结束。
- 新增 `test/kill-elevated-live.mjs`（真机 UAC）：显式 `runDir` 传给 `elevate()`，
  等 `pid.txt` 作为"UAC 已批准"的信号。真机验证通过——
  `killElevatedPid -> ok=true method=sentinel`，提权进程 `48528` 自杀，
  `done.txt` 不存在（被杀的运行不假装成功）。

## 1.0.11 — 2026-11-08

**`psh_kill` 之前那个"靠脚本块日志"的说法是假的，这次做成真的**

- 起因：用户问「要不要打开 ScriptBlockLogging 让 `psh_kill` 可用」。查代码才发现，
  那条注释描述的机制**从未被实现**：
  - 注释说提权进程会通过脚本块日志收到信号自杀。但 `ELEVATED_SCRIPT` 里没有任何地方
    读日志、也没有触发器。日志是**只写不读**的，它根本不能当通道。
  - 实际实现是用 `WScript.Shell` 起一个**普通权限**的 PowerShell 去 `Stop-Process` 目标——
    和 DSH 自己一样杀不掉提权进程。所以就算把系统策略打开，`psh_kill` 依然无效。
  - 更糟的是，全局打开脚本块日志会把**所有** PowerShell 脚本块（包括命令行里的密码、token）
    复制进系统事件日志。为一个不工作的机制付这个代价并不值得。
- 真机制：两边**唯一共享的通道是 run 目录**。
  - `ELEVATED_SCRIPT` 启动时在**后台 runspace** 里起一个监视线程，每 250 ms 看一次
    `$RunDir\kill-request` 是否存在。放在后台 runspace 是关键——用户代码把主线程
    `Start-Sleep 120` 卡住时，主线程根本没机会检查，而背景线程照样跑。
  - 哨兵出现 → `[Environment]::Exit(137)`（跨 runspace 唯一能结束整个进程的出口）。
  - `killElevatedPid(pid, { runDir })` 只做一件事：把那个文件写出来。创建文件不需要任何权限，
    所以任意完整性级别都能用。**不需要打开任何系统策略。**
  - 宿主结束时先 `Stop()` 掉监视线程，避免同一 runDir 重跑时被上一次的残留哨兵误杀。
- 配套改动：
  - `psh_elevated` 的返回**每条路径**都带 `pid` 和 `runDir`（原来只有超时分支在提示文本里提一句）。
    真正需要杀的正是"还没返回"的那次运行，pid 离开 runDir 就无从传递信号。
  - 超时/待 UAC 分支的提示改成可直接抄的调用：`psh_kill pid=... runDir='...'`。
  - `psh_kill` 新增 `runDir` 参数；拿不到 runDir 时**诚实报错**而不是假装试过。
  - `lib/policy.js` 里"用 `psh_kill`（依赖 PowerShell 脚本块日志）"改成正确描述。
- 新增 `test/kill-sentinel-check.mjs`：跑真实的 `ELEVATED_SCRIPT`，用户代码 `Start-Sleep -Seconds 120`，
  中途写下哨兵，断言宿主在几秒内退出、`done.txt` 不存在（被杀的运行不能声称跑完了）。
  实测「sentinel seen -> host exited after ~2337ms」，即便 120 秒的 sleep 仍在进行。
- 已知取舍（写在测试注释里）：输出要等整个 block 返回才收集，所以**被杀在中途的运行会丢掉
  它已经打印的部分**。能杀掉它本身比看到它卡住前的输出更重要。

## 1.0.10 — 2026-11-08

**在真宿主里跑通 `psh_job` 后当场发现的 stderr 噪声**

- 现象：重启后第一次真实 `psh_job poll`，`--- stderr ---` 段里只有一行 `#< CLIXML`。
  这是 PowerShell 5.1 在无控制台宿主上写进度记录用的封装头，不是错误——
  但 agent 读到 `#< CLIXML` 会以为出了事。
- 根因：`runner.js` 早有 `stripTransportNoise()` 处理它，但 `jobs.js` 没调用。
  而且**不能直接复用**：`stripTransportNoise` 要求拿到完整 envelope，
  而 `pollJob` 返回的是任意字节区间，可能从中间切开。
- 修法：`jobs.js` 新增 `cleanStderrChunk()`，按行处理、容错：
  丢掉 `#< CLIXML` 与 `<Objs>` 包装、拆开 `<S>…</S>` 记录、
  丢掉 `Preparing modules for first use` 这类纯进度，**其余原样保留**。
  只在 `stream === "stderr"` 时生效，stdout 一个字节都不动。
- 新增 `test/job-stderr-check.mjs`：真实错误必须存活、封装必须消失、
  用返回的 offset 续读不能重复（游标仍然指向磁盘真实字节）。
- `npm test` 现在串 6 个测试文件。

## 1.0.9 — 2026-11-08

**收尾 1.0.8 的遗留项，并把验证做成可复现的脚本**

- `node test/live-job-demo.mjs`：打印带时间戳的时间线，用输出本身的先后顺序证明"边跑边到"。
  实测 8.5 秒的命令，前 7 行在 `+734ms` … `+6.4s` 之间逐行到达，最后一行 `finished` 在 `+8.5s`。
- `node test/job-label-check.mjs`：`psh_job action=list` 里显示的是任务说明，不是脚本脚手架。
  - 修 `describe()`：循环头（`1..4 | ForEach-Object {`）、裸 `{`、格式化表达式行（`"…" -f …`）
    全都跳过，取第一条真正有意义的行；显式 `label` 永远优先。
  - 之前的 bug：`list` 里显示的标签是整行 PowerShell 源码 `("[{0:HH:mm:ss}] tick {1}" -f (Get-Date), $_)`。
- `npm test` 现在串起 5 个测试文件：schema-check / run / jobs-probe / job-tool-smoke / job-label-check。

## 1.0.8 — 2026-11-08

**新增 `psh_job`：让长命令的输出在运行时就能看到**

- 起因：用户要求「让你直接看到命令行输出了什么，以及如何变化」。实测 `psh` 跑一条
  2.44 秒的命令，结果是**跑完一次性**回来的，中间 2.4 秒屏幕上一片空白——长命令看起来像卡死。
- 根因在 DSH 的接口层，不是本插件的疏忽：`ToolDefinition.execute(args, ctx): Promise<unknown>`
  只在结束时落定一次，只有 `projectContent?` / `finalizeContent?`，**没有 onUpdate / stream / 增量帧**。
  （`psh_elevated` 之所以能"流式"，是因为提权进程在另一个会话、拿不到 stdout，被迫用文件做 mailbox。）
- 解法不是硬造流式管道，而是换形状：**后台任务 + 字节游标轮询**。
  - `psh_job action=start` 立刻返回 `id`，不等命令结束。
  - `psh_job action=poll id=… offset=…` 读到目前为止的新输出，返回下一个 `offset`。
  - `stderr` 用独立游标，单独返回，不混进 stdout。
- 新文件 `lib/jobs.js`：输出落盘到 `%TEMP%\dsh-powershell-jobs\<id>\stdout.txt`，
  文件本身就是进度条；字节上限默认 8 MiB，达到即停，避免"永远打印"的命令撑爆磁盘；
  超时仍能取回已完成的部分输出；完成 30 分钟后自动清理。
- `psh_kill` 之外新增 `action=stop` / `action=list`；`stopJob` 诚实返回
  `already-done` / `no-process` / `killed` / `kill-failed`，绝不假装杀成功。
- 插件 dispose 时 `killAllJobs()`，不留无人可寻址的子进程。
- 策略文本补写「命令跑得久时用 `psh_job` 而不是 `psh`」以及三步用法；
  同时提醒短命令不要用 `psh_job`（起任务再 poll 两次比直接 `psh` 慢也更啰嗦）。

**测试**

- 新增 `test/jobs-probe.mjs`（7 项）：边跑边读、游标无损、字节上限、超时保留部分输出、
  `cmd /c exit 7` 原样返回 7、`stop` 诚实、`list` 完整。
- 新增 `test/job-tool-smoke.mjs`：用真实的 `apply()` + `execute()` 驱动第 5 个工具，
  验证工具确实注册、流式确实发生、错误路径确实报 `ok: false`。

**踩到的三个坑（都已修）**

1. 测试里的 PowerShell 字符串 `"[{0:HH:mm:ss.fff}] line $_"` 忘了 `-f` 格式化，原样输出字面量；
   而断言只比了 `line N`，所以**测试通过但没测到东西**。教训：断言必须校验内容格式。
2. Windows 输出行尾是 `\r\n`，按 `\n` 切分会残留 `\r`。在 `pollJob` 里统一规范化，
   且**游标在规范化之前按原始字节数计算**，保证偏移始终指向磁盘上的真实位置。
3. 假 ctx 的 `effect` 写成 `() => () => {}`（不执行注册函数），导致探针里"一个工具都没注册"
   却看不出原因。宿主是 `ctx.effect(fn)` 立即执行，测试必须照做。

## 1.0.7 — 2026-11-08

**策略纠正：脚本更好时就写脚本，不要硬扛 `psh`**

- 用户指出：「如果在脚本更好的时候就不用 PSH」。原来的注入策略只写了"不要先写脚本"，
  容易被读成"一律禁止写脚本"，反向误用比原问题更糟——把几百行逻辑塞进 `code` 参数，
  既难改也留不下来。
- `lib/policy.js` 现在分三段写清边界：
  - 用 `psh` 直接跑：查状态、一次性操作、同口气完成的多步逻辑（附"每次调用都是新进程"的提醒）。
  - **脚本更合适**：超过 ~50 行、要复用/交付/进 git、要被计划任务长期调用、需要参数化、
    需要版本管理与 code review、复杂解析或状态机。
  - 落地方式：`write` 工具写 `.ps1`（不要用 `Set-Content` 写中文），再用 `psh` 执行
    `& 'D:\\path\\script.ps1' -Arg value`。
  - 一句话结论：**按"这件事的生命周期"选，不按工具偏好选。**
- 策略文本 1271 → 1676 字符。

**`psh_status` 渲染修正**

- 首行显示成 `dsh-powershell dsh-powershell`（`plugin` 字段本身就是包名，前缀又拼了一遍）。
- `elevatable: true` 时仍然附上"什么情况下会被拒绝"的长句，读起来像在报错。
  现在只在不可用时才显示原因。

## 1.0.6 — 2026-11-08

**修复：`psh_status` 声明 boolean，实际返回 null**

- 症状：工具能注册也能调用，但结果是
  `Error: tool "psh_status" returned invalid output: "value.scriptBlockLogging" must be a boolean`。
- 根因：`(Get-ItemProperty ...).EnableScriptBlockLogging` 在注册表键不存在时是 `null`，
  而 schema 声明了 `type: "boolean"`。**这次是调用期校验，只报错、不再崩宿主** ——
  比 1.0.4 的启动期崩溃好得多，但工具照样不可用。
- 修复：PowerShell 侧 `[bool](...)` 强制转换，JS 侧再逐个字段 `Boolean()/String()` 归一化，
  不依赖"JSON 里恰好有值"。
- 顺带修：`psh_elevated` 声明了 `elevated` 字段却从未返回它。现在明确返回
  `elevated: status ∈ {ok, error, timeout}` —— 用来区分"提权真的成立了"和
  "根本没起来"，免得把 `Access denied` 误读成权限不足。
- 防线升级：`test/schema-check.mjs` 现在会**真的执行** `psh` 和 `psh_status`，
  再按 schema 逐字段校验返回值类型（`psh_elevated` 会弹 UAC、`psh_kill` 会碰真实进程，
  都不在自检里跑）。"声明与实际不符"这类问题本地就能抓到。

## 1.0.5 — 2026-11-08

**修复：`psh_kill` / `psh_status` 缺 `output.render` 导致注册失败**

- 症状：1.0.4 让宿主不再崩了，但 `load.log` 里是
  `register-failed psh_kill tool "psh_kill" must declare output { schema, render, presentationMeta? }`。
  `psh` / `psh_elevated` 注册成功，`psh_kill` 和它之后的工具全部缺席——插件"加载了但少一半工具"。
- 根因：DSH 要求**每个工具**都声明完整的 `output`，只给 `{ schema }` 不够，`render` 也必须有。
- 修复：两个工具都补上 `output.render`；`psh_status` 的 schema 从空的 `{ type: "object" }`
  改成列出真实字段，渲染成人可读的摘要。
- 防线：`test/schema-check.mjs` 现在同时校验 `output.schema` 存在且 `output.render` 是函数，
  `npm test` 会先跑它，这类问题本地就能拦。

## 1.0.4 — 2026-11-08

**修复：工具 output schema 里的数组 `type` 会把整个 DSH 带崩**

- 症状：`load.log` 一路走到 `register-scan`，紧接着
  `register-failed psh unsupported JSON schema: schema.properties.exitCode.type must be a single type string (type arrays are not supported)`，
  DSH 后端宿主随即崩溃。
- 根因：`psh` / `psh_elevated` 的 output schema 把可能为空的退出码写成
  `exitCode: { type: ["number", "null"] }`。DSH 的工具 schema 校验器**只接受单个类型字符串**，
  遇到数组直接抛异常——而注册发生在启动路径上，异常没被隔离，整个宿主跟着倒。
- 修复：`exitCode` 改为 `{ type: "number" }`，用 **`-1`** 表示「没有拿到退出码」
  （超时、用户取消 UAC、输入为空）；`pick()` 与两处空输入分支同步把 `null` 换成 `-1`，
  保证声明类型与实际返回值一致。
- 新增 `test/schema-check.mjs`：用真实的 `apply()` 注册全部工具，再递归扫描每个
  `parameters` / `output.schema`，只要出现数组 `type` 就失败。`npm test` 现在**先跑它**，
  这类崩溃在本地就能拦住，不用等 DSH 崩掉再查。

## 1.0.3 — 2026-11-07

**修复：`Config` 不是 schema，导致 `apply()` 永远不被调用**

- 症状：`load.log` 里有 `import-evaluated`（模块求值成功），但**没有 `apply-enter`**，
  工具全部 `unknown tool`，零报错。
- 根因链（读 `cordis-plugin-loader` + `cordis` 源码确认）：
  `_init()` → `import()` 成功 → `unwrapExports()` 拿到 `{name,inject,Config,apply}` →
  `new Fiber(...)` → `resolveConfig(runtime, config)` 执行
  `runtime.Config['~standard'].validate(config)`。
  旧代码把 `Config` 写成了一个普通对象（`{ description, ...DEFAULTS }`），没有 `~standard`，
  于是抛 `TypeError: Cannot read properties of undefined (reading 'validate')`；
  该异常被 `_init()` 的 `this.ctx.logger.error(error)` 吞掉，而宿主无控制台 → 全程无声。
- 正确写法：`Config` 必须是 schemastery 的 `z.object({...})`；拿不到 schema 时
  必须导出 `undefined`（`resolveConfig` 对 falsy `Config` 直接放行、跳过校验），
  **绝不能退化成普通对象**——那等于埋了一颗必炸的雷。
- 依赖修复：插件原先假设能解析宿主的 `@deepseek-ai/schemastery`。本机安装走的是
  **junction**（`profile/node_modules/dsh-powershell` → `D:\dsh-plugins\dsh-powershell`），
  ESM 的动态 `import()` 跟随真实路径解析，从 `D:\...` 向上找不到任何 `node_modules`，
  于是 schema 解析为 `null`、`Config` 退化成 `undefined`——又一次静默半瘫痪。
  现在 `@deepseek-ai/schemastery@3.18.4`（与宿主 vendored 版本一致）写入 `dependencies`，
  插件自带依赖，不再依赖 host 的解析位置，junction 安装与 npm 安装行为一致。
- `Config` 现在带完整字段说明（settings UI 可据此生成表单），`shell` 用
  `z.union([z.const("auto"), z.const("powershell"), z.const("pwsh")])` 约束取值。

## 1.0.2 — 2026-11-07

**安装踩坑：patch 条目必须用相对路径**

- `cordis.patch.yml` 里 `- insert:` 的 `name` 如果写**裸包名**（`'dsh-powershell'`），
  冷启动时 loader 的解析基准未定，到不了 profile 的 `node_modules`，插件被**静默跳过**：
  进程正常起、GUI 正常开、工具就是不出现，没有任何报错。
- 现在文档与模板统一写 `'./node_modules/dsh-powershell/lib/index.js'`
  （相对路径由 `parsePatchList` 锚定到 patch 文件所在目录）。`id` 仍保持完整包名，
  因为 dshmarket 靠它判断这行已被用户接管。
- 同一条坑此前已在 omnissiah / session-delete 上踩过，patch 文件里有原注释记录。

**新增：加载面包屑（load breadcrumbs）**

- 模块加载与 `apply()` 的各阶段都会向 `~/.dsh/plugins/dsh-powershell/load.log`
  追加一行：`import-evaluated` / `apply-enter` / `apply-skip` / `register-scan` /
  `registered <tool>` / `register-failed <tool> <err>` / `policy` / `apply-done`。
- 存在的理由：DSH 后端宿主没有控制台，插件加载期抛异常**无处可去**。
  没有这个文件，唯一能观察到的是"工具不在"，而它无法区分
  "压根没加载" / "加载了但抛了" / "加载了但注册错位"三种情况。
- 面包屑永不抛出（整个写入包在 try/catch 里），不会自己成为加载失败的原因。

## 1.0.1 — 2026-11-07

**修复 / 破坏性改名**

- 工具名从 `pwsh` 改为 **`psh`**、`pwsh_elevate_status` → **`psh_status`**、
  `killElevatedPid` → **`psh_kill`**，并把提权从 `psh` 的 `elevated: true` 参数
  拆成**独立工具 `psh_elevated`**。
- 原因（真机实测）：DSH 自带一个叫 `pwsh` 的内置工具，插件用同名注册时整体失效——
  `psh_kill`/`psh_status` 在运行时 `unknown tool`，而 `elevated: true` 被静默忽略，
  命令以普通权限执行、返回一个看似"权限不足"的普通报错。独立成 `psh_elevated` 后不会退化：
  要么存在要么不存在。
- README / policy 同步说明"内置 `pwsh` 不支持提权"，避免 agent 混用。

## 1.0.0 — 2026-11-07

首个可用版本。

**新增**

- `psh` 工具（原 `pwsh`）：直接执行 PowerShell 命令/多行脚本。
- `psh_elevated`（原 `elevated: true` 参数）：走 UAC 提权运行，输出边跑边流回。
- `psh_kill`（原 `killElevatedPid`）：让提权进程自我终止（依赖 PowerShell ScriptBlockLogging）。
- `psh_status`（原 `pwsh_elevate_status`）：报告当前是否已提权、所用 shell、脚本块日志状态。
- 策略注入：`preferCommands: true` 时向系统提示注入「命令行优先」规则，让 agent 默认敲命令而不是写 `.ps1`。

**实现要点（都是踩坑得来的）**

- `-EncodedCommand` 必须 UTF-16LE；UTF-8 会变成乱码命令名并报 `CommandNotFoundException`。
- 提权宿主不能用 `-EncodedCommand`/`-Command`（ShellExecute 边界），代码以文件传递，结果经临时目录信箱回收。
- 启动器**不能** `detached: true`，否则新控制台里没有可挂载 UAC 弹窗的控制台，启动器静默退出、屏幕上什么都不出现（已复现并修复）。
- 非交互 PowerShell 会在 stderr 写 CLIXML 进度信封，已剥离。
- 脚本里不能放裸标识符当分隔符（会被当成命令名执行并导致整个脚本失败）。
- **用户代码顶层的 `exit N` 会整个杀进程**，宿主来不及写 `result.txt`/`done.txt`，
  调用方就误判成超时。现在宿主先剥离末尾的 `exit`，跑完余下语句再回放退出码。
- PS 5.1 会把非零 `$LASTEXITCODE` 一律塌缩成进程码 1；`psh` 现在把真实退出码放进末尾的 `exit` 语句里带出去。
- 提权前的 `Start-Process -Verb RunAs` 启动器不能 `detached`（见上），且 pid 由启动器写 `pid.txt`，
  避免提权宿主自报一个 ShellExecute 竞态里并不存在的 pid。
- 提权输出改为**边跑边追加 + 父进程增量读取**，长命令不再"看起来卡死"。
