/**
 * dsh-powershell — process plumbing.
 *
 * Two execution modes share one contract: a command string goes in, a result
 * record comes out (`{ exitCode, stdout, stderr, timedOut, durationMs, ... }`).
 *
 *   - `run-unelevated` runs in the DSH process's own token: a plain child
 *     `powershell.exe`, so output streams live and the exit code is real.
 *   - `run-elevated` cannot be done that way. Starting a process with
 *     `Start-Process -Verb RunAs` needs a visible console (UAC attaches the
 *     prompt to it) and loses stdout/stderr across the ShellExecute boundary.
 *     So it launches a detached host that runs the command, captures both
 *     streams to files, and waits for it with a completion file.
 *
 * Nothing in this module talks to DSH; it is plain Node so the tests can drive
 * it directly.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Windows PowerShell 5.1 — the only shell `Start-Process -Verb RunAs` can elevate. */
export const EXE_POWERSHELL = "powershell.exe";
/** PowerShell 7+ (pwsh), used only when the user asks for it. */
export const EXE_PWSH = "pwsh.exe";

/**
 * Turn code into a base64 payload `powershell.exe -EncodedCommand` understands.
 *
 * The encoding is undocumented in the help text and the obvious guess is wrong:
 * it is UTF-16LE, not UTF-8. Sending UTF-8 makes PowerShell read the argument
 * as UTF-16 garbage and fail with `CommandNotFoundException` on a mojibake
 * "command name" — which is exactly what a first attempt produced.
 *
 * @returns {string} base64 of the UTF-16LE bytes
 */
export function encodeCommand(code) {
  return Buffer.from(String(code ?? ""), "utf16le").toString("base64");
}

/** Quote one argument for `powershell.exe -File <script> -Arg1 <value>` usage. */
export function quoteArg(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Child processes must not inherit the DSH host's startup latch.
 *
 * `StartupProfileData-NonInteractive` appears once a machine's non-interactive
 * PowerShell startup has been profiled; every later start pays that cost and
 * some module autoloading gets skipped. Deleting it keeps one-off command runs
 * on the fast path. Best effort: a concurrent DSH instance may hold the file.
 */
export function removeStartupLatch() {
  const dir = process.env.APPDATA
    ? join(process.env.APPDATA, "Microsoft", "Windows", "PowerShell", "StartupProfileData-NonInteractive")
    : null;
  if (!dir || !existsSync(dir)) return false;
  try {
    rmSync(dir, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A per-run temp directory under the system temp root. */
export function makeRunDir(prefix = "dsh-powershell") {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/**
 * Bootstrapping ceremony shared by both modes.
 *
 * `Set-StrictMode` is deliberately NOT used: agent-facing one-liners routinely
 * touch properties that may be absent, and strict mode turns that into an
 * error instead of `$null` — noisier than helpful for ad-hoc commands.
 */
export const PRELUDE = `$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 > $null } catch { }
`;

/**
 * Completion marker kept for callers that need to find the end of a block in a
 * combined stream. It is NOT printed into the script: a bare identifier on its
 * own line is a command call, and PowerShell fails the whole run with
 * `CommandNotFoundException: 无法将"__DSH_PS_DONE__"项识别为 cmdlet…`.
 */
export const MARK_SEPARATOR = "__DSH_PS_DONE__";

/**
 * Run code in the DSH process's own (unelevated) token.
 *
 * @param {string} code PowerShell source
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory
 * @param {number} [opts.timeoutMs] 0 or missing = no timeout
 * @param {string} [opts.exe] shell executable
 * @param {string[]} [opts.args] extra shell arguments
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} result record
 */
export function runUnelevated(code, opts = {}) {
  const started = Date.now();
  const exe = opts.exe || EXE_POWERSHELL;
  const baseArgs = opts.args || ["-NoProfile", "-NonInteractive", "-NoLogo"];

  // The user block runs as the tail of this script, so `exit`/`return`/`break`
  // behave like top-level statements — which is what a command caller wants.
  // No sentinel lines are added around it: anything that is not a statement
  // (a bare marker identifier) is a command lookup and fails the run.
  //
  // A trailing `exit N` is the documented way to choose the reported code, so
  // it is honoured even when a command earlier in the block failed. Without one
  // PowerShell 5.1 would report 1 for any nonzero $LASTEXITCODE and 0 otherwise
  // (verified: a bare `cmd /c exit 5` yields process code 1, not 5), so the last
  // foreign exit code is passed through explicitly instead of being lost.
  const trailingExit = /\n\s*exit\b(\s+-?\d+)?\s*;?\s*$/i.exec(code);
  const body = trailingExit ? code.slice(0, trailingExit.index) : code;
  const codeStatement = trailingExit
    ? `\nexit ${(trailingExit[1] || "0").trim()}`
    : `\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
  const wrapped = `${PRELUDE}${body}${codeStatement}\n`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, [...baseArgs, "-EncodedCommand", encodeCommand(wrapped)], {
        cwd: opts.cwd || process.cwd(),
        windowsHide: true,
        env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: `failed to start ${exe}: ${error.message}`, timedOut: false, durationMs: Date.now() - started });
      return;
    }

    const out = [];
    const err = [];
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));

    let timedOut = false;
    let timer = null;
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, opts.timeoutMs);
    }

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    opts.signal?.addEventListener?.("abort", onAbort, { once: true });

    const finish = (extra) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      resolve({
        ok: extra.exitCode === 0 && !timedOut,
        exitCode: extra.exitCode,
        stdout: stripTransportNoise(stdout),
        stderr: stripTransportNoise(stderr),
        timedOut,
        durationMs: Date.now() - started,
        ...(extra.error ? { error: extra.error } : {}),
      });
    };

    child.on("error", (error) => finish({ exitCode: null, error: error.message }));
    child.on("close", (code) => finish({ exitCode: code }));
  });
}

/**
 * Remove CLIXML wrapper noise a non-interactive host may emit on stderr.
 *
 * PowerShell 5.1 writes progress records (module "Preparing for first use") to
 * stderr as CLIXML when its host is not a console. They are not errors, but an
 * agent reading stderr cannot tell — strip the envelope and keep the rest.
 */
export function stripTransportNoise(text) {
  if (!text) return "";
  if (!text.startsWith("#< CLIXML")) return text;
  const kept = [];
  const errorTexts = [];
  const re = /<S S="(Error|Warning|Verbose|Debug)">([\s\S]*?)<\/S>|<S>([\s\S]*?)<\/S>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const [, kind, tagged, plain] = match;
    if (plain !== undefined) {
      kept.push(decodeXmlEntities(plain));
      continue;
    }
    if (kind === "Error") errorTexts.push(decodeXmlEntities(tagged));
    else kept.push(decodeXmlEntities(tagged));
  }
  const joined = [...errorTexts, ...kept].join("").replace(/_x000D__x000A_/g, "\n");
  return joined.trim() ? joined : "";
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Track freshly started processes from a snapshot taken just before the launch.
 *
 * Used to tell "the shell we started, now running the user's command" from
 * "an unrelated `powershell.exe` that happens to exist" when asking the user
 * which elevated process to kill. Asking the wrong question is worse than not
 * asking, so the elevated host reports its pid on the ONLY line the untrusted
 * command cannot impersonate: `pid.txt` is written before the user block runs.
 */
export function findNewProcessByName(exeName, known, snapshotPids) {
  const fresh = [];
  for (const [pid, started] of known) {
    if (snapshotPids.has(pid)) continue;
    fresh.push({ pid, startedAt: started });
  }
  return fresh;
}

// ───────────────────────────────────────────────────────────────────────────
// Elevated mode
// ───────────────────────────────────────────────────────────────────────────

/**
 * Host script for the elevated child.
 *
 * Written to a .ps1 file because `-EncodedCommand` and `-Command` cannot run
 * after `-Verb RunAs` (Start-Process rejects them with
 * "This command cannot be run due to the error: The parameter is incorrect"):
 * ShellExecute only forwards plain arguments, so the code travels in an env var.
 */
export const ELEVATED_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][string]$CodePath,
  [string]$WorkDir = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 > $null } catch { }

function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# A pid is written FIRST, before any untrusted code runs, so "which elevated
# process is mine" has an answer that does not depend on parsing command lines.
# The launcher normally overwrites this with the pid Start-Process really
# created (they differ, and only the launcher's one can be waited on); this
# value is the fallback and is accurate when the host is started directly.
Write-Text (Join-Path $RunDir 'pid.txt') "$PID"

# Append immediately: an empty or missing file is indistinguishable from "the
# command never ran", and a consumer tailing the file must never see a JSON or
# CSV artefact of its own, which a buffered stream can produce.
$outPath = Join-Path $RunDir 'stdout.txt'
$errPath = Join-Path $RunDir 'stderr.txt'
$resPath = Join-Path $RunDir 'result.txt'
$donePath = Join-Path $RunDir 'done.txt'
Write-Text $outPath ''
Write-Text $errPath ''

$code = [System.IO.File]::ReadAllText($CodePath)
$exit = 0
try {
  if ($WorkDir -and (Test-Path -LiteralPath $WorkDir)) { Set-Location -LiteralPath $WorkDir }
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$null, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    Write-Text $errPath (($errors | ForEach-Object { "ParseError: " + $_.Message + " (line " + $_.Extent.StartLineNumber + ")" }) -join [Environment]::NewLine)
    $exit = 1
  } else {
    # The result files are opened BEFORE the user's code runs and appended to
    # through the stream. Two reasons, both learned from a run that printed
    # everything and then left no result at all:
    #   1. Formatted output (anything going through Out-String) is laid out
    #      against the console width, and a disposed or torn-down console makes
    #      that pipeline throw. Such an exception must land in stderr.txt, not
    #      take the process down with it.
    #   2. A writer kept open for the whole run is visible to a consumer tailing
    #      the file, so the agent sees lines as they are produced rather than
    #      only when the run ends.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $outWriter = New-Object System.IO.StreamWriter($outPath, $true, $utf8)
    $outWriter.AutoFlush = $true
    # Not a pipeline, and NOT a plain call either. Three forms were tried here,
    # each verified on this machine with the real host script:
    #   a) scriptblock piped into ForEach-Object — output completes but the
    #      user's exit statement tears the process down from inside the
    #      pipeline, so result.txt/done.txt are never written;
    #   b) a single call of the whole block — exit does not even flush stdout;
    #   c) one child scope per top-level statement — exit is contained, but a
    #      variable assigned in one statement is gone in the next, so any
    #      multi-step command silently loses its state.
    # So: the whole run goes into ONE scriptblock in ONE child scope (variables
    # shared, exit cannot kill the host), a trailing top-level exit is stripped
    # and replayed as the reported exit code, and its output is captured and
    # written as utf8 — which also removes any dependence on console formatting.
    $statements = @()
    if ($ast.EndBlock) { $statements = @($ast.EndBlock.Statements) }
    $requestedExit = $null
    if ($statements.Count -gt 0) {
      $lastOne = $statements[$statements.Count - 1]
      if ($lastOne -is [System.Management.Automation.Language.ExitStatementAst]) {
        $requestedExit = if ($lastOne.Pipeline) { $lastOne.Pipeline.Extent.Text } else { '0' }
        $statements = @($statements[0..($statements.Count - 2)])
      }
    }
    $body = ($statements | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine
    try {
      $items = if ($body.Trim()) { & ([ScriptBlock]::Create($body)) *>&1 } else { @() }
      foreach ($item in $items) {
        try {
          $line = if ($item -is [System.Management.Automation.ErrorRecord]) { "ERROR: " + $item.ToString() } else { [string]$item }
        } catch {
          $line = "ERROR: unrenderable output object ($($_.Exception.GetType().Name))"
        }
        $outWriter.WriteLine($line)
        try { Write-Host $line } catch { }
      }
    } catch {
      $exit = 1
      $line = "ERROR: " + ($_ | Out-String).Trim()
      $outWriter.WriteLine($line)
      try { Write-Host $line } catch { }
    }
    $outWriter.Dispose()
    if ($requestedExit -ne $null) {
      try { $exit = [int](& ([ScriptBlock]::Create($requestedExit))) } catch { $exit = 1 }
    } elseif ($LASTEXITCODE -ne $null) {
      $exit = [int]$LASTEXITCODE
    }
    # The host's own process code must agree with result.txt: a caller that
    # reads the code instead of the mailbox (an outer wrapper, a test) would
    # otherwise see PowerShell's generic 1 for every nonzero value.
    $global:LASTEXITCODE = 0
  }
} catch {
  $exit = 1
  Write-Text $errPath (($_ | Out-String))
}
# done.txt is the commit point: it must be the LAST thing written, because the
# consumer treats its presence as "result.txt is final". If the process dies
# between these two lines the run reports timeout, which is honest; the reverse
# order would report a stale exit code as success.
Write-Text $resPath "$exit"
Write-Text $donePath "$(Get-Date -Format o)"
`;

/**
 * Helper script that asks Windows to elevate the host, then reports back.
 *
 * Runs UNELEVATED; `Start-Process -Verb RunAs` raises the UAC prompt. Two
 * outcomes must be distinguishable, and the Win32Exception HRESULT is the only
 * reliable source:
 *   1223 = ERROR_CANCELLED (the user clicked No)
 *   1314 = ERROR_PRIVILEGE_NOT_HELD (the user account cannot elevate at all)
 * Both are reported through `launch.txt` because this helper is itself run
 * detached — DSH may be denied PROCESS_TERMINATE on it, so its exit code is
 * not observable.
 *
 * `-PassThru` with `-Wait` would also return an ExitCode, but the elevated
 * child is started by a DIFFERENT host, so that object is not in this
 * process's reach (the pid is not even ours to query without elevation).
 */
export const LAUNCH_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [string]$WorkDir = ''
)
$ErrorActionPreference = 'Stop'
$launchPath = Join-Path $RunDir 'launch.txt'
$args_ = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, '-RunDir', $RunDir, '-CodePath', (Join-Path $RunDir 'code.ps1'), '-WorkDir', $WorkDir)
try {
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args_ -Verb RunAs -PassThru -ErrorAction Stop
  # The launcher owns the pid file, not the elevated host. With -Verb RunAs the
  # child is created DETACHED by ShellExecute and the host's own $PID line races
  # against Start-Process returning it: in a failing run pid.txt was stamped at
  # 20:21:03 (the host's line) while the pid the launcher reported was a
  # different process that had never existed, which is exactly the kind of skew
  # that makes a later kill or a stall diagnosis point at the wrong process.
  $pidPath = Join-Path $RunDir 'pid.txt'
  [System.IO.File]::WriteAllText($pidPath, "$($p.Id)", (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($launchPath, 'started', (New-Object System.Text.UTF8Encoding($false)))
  $p.WaitForExit()
} catch {
  $code = 'unknown'
  $hr = $null
  $inner = $_.Exception
  while ($inner -and -not ($inner -is [System.ComponentModel.Win32Exception])) { $inner = $inner.InnerException }
  if ($inner) { $hr = $inner.NativeErrorCode; $code = if ($hr -eq 1223) { 'cancelled' } elseif ($hr -eq 1314) { 'denied' } else { 'launch-failed' } }
  $payload = @{ code = $code; nativeError = $hr; message = $_.Exception.Message } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($launchPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
}
`;

/**
 * Run code elevated through UAC and collect its result.
 *
 * Flow, and why each hop exists:
 *   1. `run-unelevated` starts `launch.ps1` — detached, so its own lifetime is
 *      not tied to a process DSH is allowed to terminate.
 *   2. That helper calls `Start-Process -Verb RunAs`, which raises UAC.
 *   3. The elevated host (`elevated.ps1`, same file as step 1's sibling) runs
 *      the code and writes stdout/stderr/exit into `runDir`.
 *   4. This function polls the mailboxes instead of waiting on the process,
 *      because the elevated process is not a child here.
 *
 * @param {string} code
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] how long to wait for the whole elevation
 * @param {boolean} [opts.acceptCancelled] report a user-cancelled UAC prompt instead of throwing
 * @returns {Promise<object>}
 */
export async function runElevated(code, opts = {}) {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 300_000;
  if (process.platform !== "win32") {
    return { ok: false, status: "unsupported-platform", stdout: "", stderr: "UAC elevation only exists on Windows.", durationMs: 0 };
  }

  const runDir = opts.runDir || makeRunDir("dsh-powershell-elev");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "code.ps1"), String(code ?? ""), "utf8");
  const hostPath = join(runDir, "elevated.ps1");
  const launchPath = join(runDir, "launch.ps1");
  writeFileSync(hostPath, ELEVATED_SCRIPT, "utf8");
  writeFileSync(launchPath, LAUNCH_SCRIPT, "utf8");

  const workDir = opts.cwd || process.cwd();
  // The launcher must be a genuine child, not a fully detached one: `detached:
  // true` starts it in its own console, and Start-Process -Verb RunAs then has
  // no console to attach the UAC prompt to — the launcher dies silently and
  // nothing ever appears on screen (reproduced: detached, hide+detach and cmd
  // `start` variants all produced no prompt; a plain spawn did).
  // `windowsHide: true` is likewise avoided so Windows does not suppress the
  // console the prompt needs. Killing a `-NonInteractive` launcher is handled
  // by killElevatedPid; its own lifetime is short by design (it only launches).
  const launch = spawn(
    EXE_POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", launchPath,
      "-RunDir", runDir, "-ScriptPath", hostPath, "-WorkDir", workDir],
    { cwd: workDir, stdio: "ignore" },
  );
  launch.on("error", () => {
    /* reported through launch.txt / timeout instead */
  });

  const pidPath = join(runDir, "pid.txt");
  const launchFile = join(runDir, "launch.txt");
  const donePath = join(runDir, "done.txt");
  const resultPath = join(runDir, "result.txt");
  const outPath = join(runDir, "stdout.txt");
  const errPath = join(runDir, "stderr.txt");

  const readIfExists = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  let elevatedPid = null;
  let launchOutcome = null;
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  let streamed = 0;

  // Stream whatever the elevated host has already written, in increments.
  // Waiting for done.txt and only then showing output makes a long elevated
  // command look frozen; reading the append-only log as it grows is the whole
  // point of `onData`.
  const pump = () => {
    const current = readIfExists(outPath);
    if (!current || current.length <= streamed) return;
    const chunk = current.slice(streamed);
    streamed = current.length;
    try {
      opts.onData?.(chunk);
    } catch {
      /* a broken sink must not break the run */
    }
  };

  while (Date.now() < deadline) {
    if (launchOutcome === null) {
      const raw = readIfExists(launchFile);
      if (raw !== null) {
        const text = raw.trim();
        launchOutcome = text === "started" ? { code: "started" } : safeJson(text) ?? { code: "unknown", message: text };
        if (launchOutcome.code !== "started") {
          const result = {
            ok: false,
            status: launchOutcome.code,
            stdout: "",
            stderr: describeLaunchFailure(launchOutcome, opts.acceptCancelled),
            durationMs: Date.now() - started,
            runDir,
            nativeError: launchOutcome.nativeError ?? null,
          };
          if (!opts.keepRunDir) rmSync(runDir, { recursive: true, force: true });
          return result;
        }
      }
    }
    const pidText = readIfExists(pidPath);
    if (pidText) elevatedPid = Number.parseInt(pidText.trim(), 10) || null;
    pump();
    if (existsSync(donePath)) break;
    await sleep(150);
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
  }
  pump();

  const finished = existsSync(donePath);
  const result = {
    ok: false,
    status: finished ? (cancelled ? "aborted" : "ok") : launchOutcome === null ? "uac-pending" : "timeout",
    exitCode: finished ? Number.parseInt((readIfExists(resultPath) ?? "").trim(), 10) : null,
    stdout: readIfExists(outPath) ?? "",
    stderr: readIfExists(errPath) ?? "",
    durationMs: Date.now() - started,
    runDir,
    elevatedPid,
  };
  if (finished) {
    result.ok = result.exitCode === 0;
  } else if (result.status === "uac-pending") {
    // Do not delete the run dir: the prompt is still on screen and the elevated
    // host will write into it if the user clicks Yes a moment later.
    result.status = "uac-pending";
    result.stderr = result.stderr || "UAC prompt did not report back within the timeout; it may still be waiting for the user.";
  }
  if (finished && !opts.keepRunDir) {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return result;
}

function describeLaunchFailure(outcome, acceptCancelled) {
  if (outcome.code === "cancelled") {
    return acceptCancelled
      ? "UAC prompt was declined (the user clicked No)."
      : "UAC prompt was declined by the user. Do not retry on your own: ask the user first.";
  }
  if (outcome.code === "denied") {
    return "This account is not allowed to elevate (ERROR_PRIVILEGE_NOT_HELD). Run the command unelevated, or have an administrator grant UAC rights.";
  }
  return `could not start the elevated process: ${outcome.message || outcome.code}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill a process the elevated host spawned, from an UNELEVATED DSH process.
 *
 * The privilege models are asymmetric: a lower-integrity process may not call
 * TerminateProcess on a higher one (with UAC on, that is
 * `Access is denied` / ERROR_ACCESS_DENIED). It may, however, ask the elevated
 * processes to terminate THEMSELVES — through script-block logging, which fires
 * before the block runs. WScript.Shell (COM) is used instead of `powershell.exe`
 * on purpose: launching a new elevated PowerShell would itself show up in that
 * log and could be killed instead of the target.
 *
 * @returns {Promise<{ ok: boolean, method: string, detail: string }>}
 */
export async function killElevatedPid(pid, opts = {}) {
  const target = Number.parseInt(pid, 10);
  if (!Number.isFinite(target) || target <= 0) {
    return { ok: false, method: "none", detail: `invalid pid ${pid}` };
  }

  // Try the ordinary kill first: it works whenever we share integrity level.
  const direct = await signalPid(target);
  if (direct.ok) return { ok: true, method: "terminate", detail: "terminated directly" };

  const request = `& { param($p) $k = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if ($k) { try { Stop-Process -Id $p -Force -ErrorAction Stop; "KILLED $p" } catch { "FAILED $p: $($_.Exception.Message)" } } else { "GONE $p" } } ${target}`;
  const script = `try { (New-Object -ComObject WScript.Shell).Run('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${escapeSingleQuotes(request)}"', 0, $false); "queued" } catch { "error: $($_.Exception.Message)" }`;
  const kick = await runUnelevated(script, { timeoutMs: 20_000, ...opts });
  const queued = /queued/i.test(kick.stdout);
  if (!queued) {
    return { ok: false, method: "wscript", detail: `could not queue the kill request: ${(kick.stderr || kick.stdout || "no output").trim()}` };
  }

  // The log fires asynchronously; poll for the process to disappear.
  const deadline = Date.now() + (opts.waitMs > 0 ? opts.waitMs : 15_000);
  while (Date.now() < deadline) {
    const alive = await signalPid(target);
    if (!alive.ok) return { ok: true, method: "wscript-scriptblock-log", detail: `pid ${target} is gone` };
    await sleep(300);
  }
  return {
    ok: false,
    method: "wscript-scriptblock-log",
    detail: `queued the self-termination request but pid ${target} is still alive. If PowerShell script block logging is disabled on this machine, you must click "Terminate" on the elevated window, or sign out.`,
  };
}

function escapeSingleQuotes(text) {
  return String(text).replace(/"/g, '\\"');
}

/** `taskkill`-free liveness + direct kill probe that never throws. */
function signalPid(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve({ ok: false, detail: "taskkill unavailable" }));
    child.on("close", (code) => resolve({ ok: code === 0, detail: "attempted direct termination" }));
  });
}
