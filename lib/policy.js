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

本 profile 装了 \`pwsh\` 工具：直接把 PowerShell 代码/命令传进去执行，**不需要**写成文件再运行。
它有两种模式：默认在 DSH 自己的权限下运行；\`elevated: true\` 会弹 UAC 提权运行。

**默认这样做（不要先写脚本）**

- 需要看系统状态、查进程/服务/端口/磁盘/注册表、算点东西、批量改文件属性、装/卸载软件包，一律直接用 \`pwsh\`，
  命令写在 \`code\` 里执行。
- 一次性的 PowerShell 命令**不要**落盘成 \`.ps1\` 再跑：多一个文件、多一步、下次还得删。
- 需要多步逻辑时，用 \`code\` 里的一整段脚本（多行、带函数、try/catch 都行），而不是在两条工具调用之间丢状态：
  每次调用都是**新进程**，变量不跨调用保留。
- 只有这些情况才写文件：要交付给用户/进 git 的脚本、被计划任务或别的程序长期调用的脚本、超过几百行需要版本管理的代码。

**什么时候必须提权**

- 改系统级设置（服务、驱动、防火墙、hosts、计划任务、HKLM 注册表、Program Files 下的文件）、
  装卸需要管理员的软件、改别的用户的文件、启停系统服务。
- 不确定是否需要管理员时，先按普通权限跑；命令因权限报错（"Access is denied"、"拒绝访问"、HRESULT 0x80070005）时，
  再**先告诉用户**这条命令需要提权、会弹 UAC，得到同意后带 \`elevated: true\` 重跑。
- 用户已经明确说「提权/管理员/UAC 跑」时可以直接用提权模式。

**提权的两个硬限制**

- 提权跑的命令**不能**弹交互界面（UAC 之后的进程在另一个会话，看不到 DSH 的窗口），也不能写 DSH 的 stdout — 所以只能靠输出文件/日志判断结果。
- 提权进程一旦卡住，普通权限下能做的只有：让用户点掉窗口，或用 \`killElevatedPid\`（依赖 PowerShell 脚本块日志）。
  因此提权命令里避免长交互、避免等 stdin。

**其它约定**

- 输出用 UTF-8；中文路径/内容直接写，不要转义成 \\u 序列。
- 破坏性命令（删目录、格盘、卸软件、改系统服务）先问用户。
- 命令失败时读 \`stderr\` 和 \`exitCode\`，不要重复跑同样的命令。`;
