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
\`psh_status\` 报告当前权限/Shell/UAC 可用性；\`psh_kill\` 让卡住的提权进程自行退出。

⚠️ 注意别和 DSH 内置的 \`pwsh\` 搞混：内置那个**不支持提权**，传任何提权意图都会被静默忽略。
凡是要管理员权限的，必须用 \`psh_elevated\`。

**默认这样做（不要先写脚本）**

- 需要看系统状态、查进程/服务/端口/磁盘/注册表、算点东西、批量改文件属性、装/卸载软件包，一律直接用 \`psh\`，
  命令写在 \`code\` 里执行。
- 一次性的 PowerShell 命令**不要**落盘成 \`.ps1\` 再跑：多一个文件、多一步、下次还得删。
- 需要多步逻辑时，用 \`code\` 里的一整段脚本（多行、带函数、try/catch 都行），而不是在两条工具调用之间丢状态：
  每次调用都是**新进程**，变量不跨调用保留。
- 只有这些情况才写文件：要交付给用户/进 git 的脚本、被计划任务或别的程序长期调用的脚本、超过几百行需要版本管理的代码。

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
- 提权进程一旦卡住，普通权限下能做的只有：让用户点掉窗口，或用 \`psh_kill\`（依赖 PowerShell 脚本块日志）。

**其它约定**

- 输出用 UTF-8；中文路径/内容直接写，不要转义成 \\u 序列。
- 破坏性命令（删目录、格盘、卸软件、改系统服务）先问用户。
- 命令失败时读 \`stderr\` 和 \`exitCode\`，不要重复跑同样的命令。`;
