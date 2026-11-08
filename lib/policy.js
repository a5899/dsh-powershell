/**
 * dsh-powershell — policy text injected into the agent's system prompt.
 *
 * The user's goal is behavioural, not just tool-shaped: "make commands the
 * default way I take input, instead of writing scripts". A tool that exists but
 * is only reached for when nothing else fits does not achieve that, so the
 * instruction travels with the tool as system context. It stays short — it is
 * re-sent on every turn of every session in this profile.
 */
export const POLICY_BASENAME = "dsh-powershell";

export const POLICY_TEXT = `## 命令行优先（dsh-powershell）

本 profile 装了 \`psh\` 工具：直接把 PowerShell 代码/命令传进去执行，**不需要**写成文件再运行。
提权是**独立的另一个工具** \`psh_elevated\`（会弹 UAC），不是 \`psh\` 的参数。
长命令用 \`psh_job\`（后台跑 + 边跑边读输出，见下）。
\`psh_status\` 报告当前权限/Shell/UAC 可用性；\`psh_kill\` 让卡住的提权进程自行退出。

⚠️ 注意别和 DSH 内置的 \`pwsh\` 搞混：内置那个**不支持提权**，传任何提权意图都会被静默忽略。
凡是要管理员权限的，必须用 \`psh_elevated\`。

**先判断：这一件事该用命令，还是该写脚本**

「命令行优先」指的是**不要为了跑一条命令而先造一个文件**，不是「一律禁止写脚本」。
反过来的误用同样要避免：几百行的逻辑硬塞进 \`code\` 参数，既难改也留不下来。

用 \`psh\` 直接跑（默认，大多数情况）：

- 查系统状态、进程/服务/端口/磁盘/注册表、算点东西、批量改文件属性、装卸软件包。
- 临时的、一次性的、三五行的操作：多一个文件就多一步，下次还得删。
- 需要多步但**同一口气完成**的：\`code\` 里写一整段（多行、函数、try/catch 都行）。
  注意每次调用都是**新进程**，变量不跨调用保留——要跨步骤保持状态，就在一次调用里做完或写文件。

**脚本更合适时，就写脚本**（不要硬扛 \`psh\`）：

- 逻辑偏长（经验阈值：超过 ~50 行）或需要反复调试、断点式排查。
- 要**复用**：以后自己还要跑、要交给用户、要进 git、要被计划任务或别的程序长期调用。
- 需要**参数化**：不同参数跑不同场景，做成 \`param(...)\` 比每次改 \`code\` 清楚。
- 需要版本管理、code review、或作为项目的一部分留存。
- 复杂的解析 / 状态机 / 多阶段流程，拆成文件后结构才看得清。

写脚本时照常做：用 \`write\` 工具把 \`.ps1\` 落到工作区（**不要**用 \`Set-Content\` 管道写中文），
然后用 \`psh\` 执行 \`& 'D:\\path\\to\\script.ps1' -Arg value\`。
**一条命令 vs 一个脚本，按"这件事的生命周期"选，不按工具偏好选。**

**命令跑得久时，用 \`psh_job\` 而不是 \`psh\`**

DSH 的工具调用**只在结束时返回一次**，没有增量通道。所以 \`psh\` 跑一条 5 分钟的命令，
前 5 分钟你看到的就是一片空白——分不清是卡死还是在干活。凡符合下面任一条，改用 \`psh_job\`：

- 预计超过 ~10 秒：构建、装包、扫描磁盘、遍历大量文件、跑测试。
- 会**持续输出**：\`tail\` 式日志、进度条、长时间下载。
- 需要边跑边判断：输出里出现某个错误就提前停手。

用法（三步，别只看一次就以为没输出）：

1. \`psh_job action=start code=... timeoutMs=0\` → 立刻返回 \`id\`，不等命令跑完。
2. \`psh_job action=poll id=... offset=0\` → 读到目前为止的新输出，返回新的 \`offset\`。
3. 用返回的 \`offset\` **继续 poll**，直到 \`done: true\`。stderr 单独返回，不混进 stdout。

\`action=list\` 看所有任务，\`action=stop\` 停掉一个。输出有字节上限（默认 8 MiB），
超了会自动停——所以"永远打印"的命令不会撑爆磁盘。

**短命令不要用 \`psh_job\`**：为了跑 \`Get-Date\` 起个后台任务再 poll 两次，比直接 \`psh\` 慢也更啰嗦。

**什么时候必须提权**

- 改系统级设置（服务、驱动、防火墙、hosts、计划任务、HKLM 注册表、Program Files 下的文件）、
  装卸需要管理员的软件、改别的用户的文件、启停系统服务。
- 不确定是否需要管理员时，先按普通权限用 \`psh\` 跑；命令因权限报错（"Access is denied"、"拒绝访问"、HRESULT 0x80070005）时，
  再**先告诉用户**这条命令需要提权、会弹 UAC，得到同意后用 \`psh_elevated\` 重跑。
- 用户已经明确说「提权/管理员/UAC 跑」时可以直接用 \`psh_elevated\`。

**提权的硬限制**

- UAC 弹窗只能由**用户**点：DSH 里的审批自动拒绝，任何程序都点不了它。所以提权前先说明，别在用户不在屏幕前时弹。
- 用户取消（Win32Exception 1223）是**用户的决定**，不是故障：如实报告，不要重试、不要换路子绕开。
- 提权进程在另一个会话：不能弹交互界面、不能写 DSH 的 stdout，只能靠输出文件/日志判断结果。
- 提权进程一旦卡住：\`psh_elevated\` 的返回里有 \`pid\` 和 \`runDir\`，把这两个传给
  \`psh_kill pid=... runDir=...\`，提权宿主会自己退出（它每 250ms 检查 runDir 里有没有 kill-request 文件）。
  杀不退时才让用户点窗口的 Terminate。不需要开任何系统策略。

**其它约定**

- 输出用 UTF-8；中文路径/内容直接写，不要转义成 \\u 序列。
- 破坏性命令（删目录、格盘、卸软件、改系统服务）先问用户。
- 命令失败时读 \`stderr\` 和 \`exitCode\`，不要重复跑同样的命令。`;
