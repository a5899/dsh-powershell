# Changelog

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
