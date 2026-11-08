# dsh-powershell

给 DeepSeek Harness 的 agent 一个**直接敲命令**的工具：PowerShell 代码进，输出出，
需要时还能弹 **UAC 提权**运行。目标不是"多一个工具"，而是让 agent 默认**输入命令**，
而不是先写一个 `.ps1` 再运行。

> 适用于 Windows。Linux/macOS 上插件会正常加载，但提权工具会返回 `unsupported-platform`
>（UAC 是 Windows 独有的东西，没有假装支持的降级路径）。

## 为什么工具叫 `psh` 而不是 `pwsh`

**因为 DSH 自带一个叫 `pwsh` 的内置工具，而且撞名时内置的赢。** 这不是猜的，是在真机上验证出来的：

- 插件用 `name: "pwsh"` 注册时，本插件的另外两个工具（`psh_kill` / `psh_status`）在运行时里
  直接 `unknown tool`——说明插件整体没生效；
- 而会话里的 `pwsh` **接受**了 `elevated: true` 却**静默忽略**它：命令以普通权限跑，
  返回一个看起来像"权限不够"的普通报错，而不是"没提权"。

这个失败模式很危险：一个本该提权的操作，看起来只是失败了。所以现在提权是**独立的工具**
`psh_elevated`——它要么存在，要么不存在，不会退化。内置 `pwsh` 保持原样，两边不冲突。


## 为什么不是 MCP

MCP server 是**另一个进程**，架构上就跑不了 UAC：提权的进程在另一个会话、另一个 token 下，
MCP 的 stdio/HTTP 通道根本握不住它的输出。所以这里做成 DSH 原生插件——工具在 DSH 进程里注册，
提权走 `Start-Process -Verb RunAs`，结果靠临时目录里的文件信箱回收。

## 装了之后拿到什么

| 工具 | 作用 |
|---|---|
| `psh` | **主工具**。`code` 里直接写 PowerShell（多行脚本也行）。普通权限，一次调用一个新进程。 |
| `psh_elevated` | **提权工具**。弹 UAC 以管理员身份运行，输出边跑边流回来。用户取消（1223）如实报告，不重试。 |
| `psh_kill` | 让一个提权进程自己退出（低权限进程杀不掉高权限进程，原因见下）。 |
| `psh_status` | 当前是否已提权、用的哪个 shell、脚本块日志是否开着——**先问再断言**，别猜。 |

> 内置的 `pwsh` 与本插件的 `psh` 是两回事：内置那个不支持提权。要管理员权限时用 `psh_elevated`。


配置项（`cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-powershell
      # 必须是相对路径，不能是裸包名 —— 理由见下方「装」一节
      name: './node_modules/dsh-powershell/lib/index.js'
      config:
        enabled: true
        preferCommands: true          # 往系统提示注入「命令行优先」策略
        shell: auto                   # auto | powershell | pwsh
        timeoutMs: 120000             # 普通命令超时
        maxOutputChars: 200000        # 输出截断上限
        elevateTimeoutMs: 300000      # 提权总预算（含等用户点 UAC 的时间）
```

## 设计上必须知道的四件事

这些都是实测踩出来的，不是理论：

1. **`-EncodedCommand` 要 UTF-16LE。** 用 UTF-8 编码会变成乱码命令名，
   报 `CommandNotFoundException: 无法将"摁ⵤ祔数…"项识别为 cmdlet`。
2. **`Start-Process -Verb RunAs` 不能带 `-EncodedCommand` / `-Command`。** ShellExecute
   只转发命令行参数，Start-Process 校验时直接报 `The parameter is incorrect`。
   所以代码以**文件**形式传给提权后的宿主。
3. **提权进程的 stdout/stderr 过不了 ShellExecute 边界。** 落盘到每次运行独立的临时目录
   （`pid.txt` / `stdout.txt` / `stderr.txt` / `result.txt` / `done.txt`），父进程轮询信箱。
4. **低权限进程终止不了高权限进程**（拿不到 `PROCESS_TERMINATE`，报 `Access is denied`）。
   `psh_kill` 的绕法是让目标**自己**退出：用 `WScript.Shell` COM 起一个 PowerShell
   去碰脚本块日志，日志钩子先于代码执行触发 → 提权进程按策略把自己杀掉。
   **这依赖 `ScriptBlockLogging` 开着**；没开就如实返回失败，并告诉你只能手动点 Terminate。
   用 COM 而不是再起一个 `powershell.exe`，是因为新起的那个也会进日志、可能被误杀。

## 装

```powershell
# 1. 链接进 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-powershell" -Target "<本仓库路径>"

# 2. 加进 profile 的 bundles
#    ~/.dsh/profiles/desktop/package.json -> dsh.profile.bundles 里加 "dsh-powershell"

# 3. 在 profile 的 cordis.patch.yml 末尾追加（注意 name 是相对路径！）
#    - insert:
#        - id: dsh-powershell
#          name: './node_modules/dsh-powershell/lib/index.js'
#          config: { enabled: true, preferCommands: true }

# 4. 重启 DSH
```

### ⚠️ `name` 必须是相对路径，写裸包名会被静默跳过

这是本项目最贵的坑，值得单独说：

```yaml
name: 'dsh-powershell'                            # ❌ 冷启动解析不到，插件静默不加载
name: './node_modules/dsh-powershell/lib/index.js'  # ✅
```

**冷启动时 loader 的解析基准还没定**，裸包名到不了 profile 的 `node_modules`，
于是这条 patch 被跳过——**没有任何报错**。表现出来是：DSH 正常启动、GUI 正常打开、
只是工具不在。而后端宿主进程根本没有控制台，加载期抛的错无处可去，日志里也查不到。

`id` 则必须保持完整包名，因为 dshmarket 拿它跟包名比对来判断"这行是不是已被用户接管"。

### 加载失败怎么查：`load.log`

插件会在 `~/.dsh/plugins/dsh-powershell/load.log` 里逐行记录自己的加载进度：

| 最后看到哪一行 | 说明 |
|---|---|
| 什么都没有 | **模块压根没被 import**——先查 patch 条目和 `name` 的写法 |
| `import-evaluated` | 模块求值了，但 `apply()` 没被调用——**查 `Config`**（见下一条） |
| `apply-enter` | 进 `apply()` 了，问题在注册阶段 |
| `register-failed <tool> <err>` | 注册抛异常了，错误信息在这行 |
| `apply-done N disposers` | 全部正常，工具应该可用 |

不要用"工具在不在"来判断插件是否工作——内置 `pwsh` 会顶替掉同名工具，让你误以为一切正常
（见本文开头的改名说明）。

### ⚠️ `Config` 必须是 schemastery schema，不能是普通对象

卡在 `import-evaluated` 却进不了 `apply-enter`，九成是这里。cordis 的
`resolveConfig()` 看到 `runtime.Config` 为真就会执行：

```js
runtime.Config["~standard"].validate(config)
```

普通对象没有 `~standard`，于是抛 `TypeError: Cannot read properties of undefined
(reading 'validate')`，而这个异常被 loader 吞进一个**没有控制台的 logger**——全程无提示。

两条硬规则：

1. `Config` 必须是 `z.object({...})`（schemastery）。
2. **拿不到 schema 时必须导出 `undefined`**，不能退化成普通对象：

```js
const schemaMod = await importFirst(["@deepseek-ai/schemastery", "schemastery"]);
export const Config = schemaMod ? z.object({ ... }) : undefined;
```

另外，插件**要自带 `@deepseek-ai/schemastery` 依赖**。用 junction 把插件装进
`profile/node_modules` 时，ESM 的动态 `import()` 会跟随真实路径解析，
从插件源码所在的盘符往上找不到任何 `node_modules`，schema 就静默变成 `null`。

### ⚠️ 工具 schema 的 `type` 只能是单个字符串，不能是数组

卡在 `register-failed` 并且**整个 DSH 宿主跟着崩**，多半是这里：

```
unsupported JSON schema: schema.properties.exitCode.type must be a single type string (type arrays are not supported)
```

DSH 的工具 schema 校验器不认 `{ type: ["number", "null"] }` 这种联合类型。而注册发生在
启动路径上，异常不会被隔离，一个字段写错就能带走整个后端宿主。

- 想要"可为空"的语义，就用单类型 + 哨兵值（本插件用 `-1` 表示"没拿到退出码"）。
- 真需要联合类型，用 `anyOf`，别用类型数组。
- **声明类型要和实际返回值一致**：schema 写 `number`，`execute` 就不能返回 `null`。
- `npm test` 会先跑 `test/schema-check.mjs`：真实注册一遍工具，再递归扫描所有
  `parameters` / `output.schema`，发现数组 `type` 直接失败。

### ⚠️ 每个工具都必须声明 `output.schema` **和** `output.render`

只给 `{ schema }` 不够，宿主会拒绝：

```
register-failed psh_kill tool "psh_kill" must declare output { schema, render, presentationMeta? }
```

这个错误不会让宿主崩，但**该工具和它之后的工具全部缺席**——插件看起来"加载了"，
实际少一半功能。排查时一定要数工具个数，别看到第一个工具能用就以为都好了。

```js
output: {
  schema: { type: "object", properties: { ok: { type: "boolean" } } },
  render(_args, value) {
    return [{ type: "text", text: value.ok ? "terminated" : "not terminated" }];
  },
}
```

`schema-check.mjs` 现在也校验这两项，本地就能拦住。

## 开发

```powershell
node test/schema-check.mjs         # 注册全部工具 + 递归扫描 schema（先跑它）
node test/run.mjs                  # 18 项集成测试（真跑 powershell，不打桩）
node test/e2e-uac.mjs              # 真 UAC 端到端：点「是」，验证提权 + 边跑边出输出
node test/uac-probe.mjs            # 真 UAC：点「是」，应报 status=ok
node test/uac-probe.mjs --cancel   # 真 UAC：点「否」，应报 status=cancelled
```

测试刻意用真实子进程：这里的每个难点都是 Windows 的怪癖，mock 会全绿而真机全红。

## 许可

MIT
