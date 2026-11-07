# dsh-powershell

给 DeepSeek Harness 的 agent 一个**直接敲命令**的工具：PowerShell 代码进，输出出，
需要时还能弹 **UAC 提权**运行。目标不是"多一个工具"，而是让 agent 默认**输入命令**，
而不是先写一个 `.ps1` 再运行。

> 适用于 Windows。Linux/macOS 上插件会正常加载，但 `elevated` 会返回 `unsupported-platform`
>（UAC 是 Windows 独有的东西，没有假装支持的降级路径）。

## 为什么不是 MCP

MCP server 是**另一个进程**，架构上就跑不了 UAC：提权的进程在另一个会话、另一个 token 下，
MCP 的 stdio/HTTP 通道根本握不住它的输出。所以这里做成 DSH 原生插件——工具在 DSH 进程里注册，
提权走 `Start-Process -Verb RunAs`，结果靠临时目录里的文件信箱回收。

## 装了之后拿到什么

| 工具 | 作用 |
|---|---|
| `pwsh` | **主工具**。`code` 里直接写 PowerShell（多行脚本也行），`elevated: true` 走 UAC。 |
| `killElevatedPid` | 让一个提权进程自己退出（低权限进程杀不掉高权限进程，原因见下）。 |
| `pwsh_elevate_status` | 当前是否已提权、用的哪个 shell、脚本块日志是否开着——**先问再断言**，别猜。 |

配置项（`cordis.patch.yml`）：

```yaml
- id: dsh-powershell
  name: 'dsh-powershell'
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
   `killElevatedPid` 的绕法是让目标**自己**退出：用 `WScript.Shell` COM 起一个 PowerShell
   去碰脚本块日志，日志钩子先于代码执行触发 → 提权进程按策略把自己杀掉。
   **这依赖 `ScriptBlockLogging` 开着**；没开就如实返回失败，并告诉你只能手动点 Terminate。
   用 COM 而不是再起一个 `powershell.exe`，是因为新起的那个也会进日志、可能被误杀。

## 装

```powershell
# 1. 链接进 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-powershell" -Target "<本仓库路径>"

# 2. 加进 profile 的 bundles
#    ~/.dsh/profiles/desktop/package.json -> dsh.profile.bundles 里加 "dsh-powershell"

# 3. 重启 DSH
```

## 开发

```powershell
node test/run.mjs              # 14 项集成测试（真跑 powershell，不打桩）
node test/uac-probe.mjs        # 真 UAC：点「是」，应报 status=ok
node test/uac-probe.mjs --cancel   # 真 UAC：点「否」，应报 status=cancelled
```

测试刻意用真实子进程：这里的每个难点都是 Windows 的怪癖，mock 会全绿而真机全红。

## 许可

MIT
