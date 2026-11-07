# Changelog

## 1.0.0 — 2026-11-07

首个可用版本。

**新增**

- `pwsh` 工具：直接执行 PowerShell 命令/多行脚本，`elevated: true` 走 UAC 提权。
- `killElevatedPid`：让提权进程自我终止（依赖 PowerShell ScriptBlockLogging）。
- `pwsh_elevate_status`：报告当前是否已提权、所用 shell、脚本块日志状态。
- 策略注入：`preferCommands: true` 时向系统提示注入「命令行优先」规则，让 agent 默认敲命令而不是写 `.ps1`。

**实现要点（都是踩坑得来的）**

- `-EncodedCommand` 必须 UTF-16LE；UTF-8 会变成乱码命令名并报 `CommandNotFoundException`。
- 提权宿主不能用 `-EncodedCommand`/`-Command`（ShellExecute 边界），代码以文件传递，结果经临时目录信箱回收。
- 启动器**不能** `detached: true`，否则新控制台里没有可挂载 UAC 弹窗的控制台，启动器静默退出、屏幕上什么都不出现（已复现并修复）。
- 非交互 PowerShell 会在 stderr 写 CLIXML 进度信封，已剥离。
- 脚本里不能放裸标识符当分隔符（会被当成命令名执行并导致整个脚本失败）。
- 提权输出改为**边跑边追加 + 父进程增量读取**，长命令不再"看起来卡死"。
