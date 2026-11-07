/**
 * dsh-powershell — UAC elevation.
 *
 * `Start-Process -Verb RunAs` is the only supported way for an unelevated
 * process to obtain an elevated one on Windows, and it is a hostile API for
 * automation:
 *
 *   - It needs a visible console. With no console, UAC still shows but the
 *     result is unobservable, so the launcher MUST be spawned detached.
 *   - It cannot pass `-EncodedCommand`/`-Command` (ShellExecute forwards
 *     arguments to a *command line*, and Start-Process validates those flags
 *     away with "The parameter is incorrect"). Code therefore travels in a file.
 *   - Stdout/stderr do not cross the ShellExecute boundary at all. They are
 *     captured by the elevated host into files under a per-run temp directory.
 *   - A "No" click and a policy refusal differ only by Win32Exception code
 *     (1223 vs 1314), which the launcher reports back through a mailbox file.
 *
 * Two entry points, both honest about what can be observed:
 *   - `elevationAvailable()` probes the policy BEFORE any prompt appears, so a
 *     caller can explain "this account cannot elevate" instead of showing a UAC
 *     dialog for nothing.
 *   - `elevate()` runs one command and returns its captured result.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeRunDir, runElevated, sleep, killElevatedPid } from "./runner.js";

export { killElevatedPid };

function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Is an interactive UAC prompt meaningful for this session?
 *
 * Do not call this per command: when the DSH host already runs elevated, UAC
 * would not appear at all and the check merely costs a second. Probe with
 * `pwsh_elevate_status`.
 */
export async function elevationAvailable() {
  if (process.platform !== "win32") {
    return { platform: process.platform, elevatable: false, reason: "not Windows" };
  }
  return {
    platform: "win32",
    elevatable: true,
    reason:
      "Standard users on a UAC-enabled system can raise a prompt. The prompt is declined by policy (ERROR_PRIVILEGE_NOT_HELD) only when the local security policy forbids it or the account is not in Administrators.",
  };
}

/**
 * Run one command elevated.
 *
 * @param {string} code PowerShell source
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory for the elevated process
 * @param {number} [opts.timeoutMs] total budget covering the prompt wait AND the command
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} result record with `status` in
 *   ok | cancelled | denied | launch-failed | timeout | aborted | unsupported-platform
 */
export async function elevate(code, opts = {}) {
  if (process.platform !== "win32") {
    return { ok: false, status: "unsupported-platform", exitCode: null, stdout: "", stderr: "UAC elevation only exists on Windows.", durationMs: 0 };
  }

  const source = String(code ?? "").trim();
  if (!source) {
    return { ok: false, status: "empty-command", exitCode: null, stdout: "", stderr: "elevated mode needs a non-empty command.", durationMs: 0 };
  }

  // A self-kill escape hatch: if the command hangs, the user has to click
  // Terminate on the elevation window. Tell them, rather than hanging forever.
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 300_000;
  // Capture the text as well as forwarding it: callers that cannot consume a
  // live stream (or arrive after the fact) still get every line that was
  // printed, in order, instead of only the tail that survived the pump.
  const captured = [];
  const onData =
    typeof opts.onData === "function"
      ? (chunk) => {
          captured.push(chunk);
          opts.onData(chunk);
        }
      : undefined;

  const result = await withRunDir(opts, (runDir) =>
    runElevated(source, {
      cwd: opts.cwd,
      timeoutMs,
      signal: opts.signal,
      runDir,
      keepRunDir: opts.keepRunDir || Boolean(onData),
      onData,
    }),
  );

  // The elevated host tee's its output to stdout.txt; prefer that over the
  // pump's concatenation so a slow consumer cannot lose a trailing chunk.
  const teed = readIfExists(join(result.runDir ?? "", "stdout.txt"));
  const live = (teed ?? captured.join("")).replace(/\r\n/g, "\n");
  return { ...result, stdout: live || result.stdout || "", streamed: Boolean(onData) };
}

/**
 * Give a long-running elevated command a handle the caller can act on, then
 * clean up. Kept separate so `elevate()` stays a single straight line.
 */
async function withRunDir(opts, fn) {
  const runDir = opts.runDir || makeRunDir("dsh-powershell-elev");
  try {
    return await fn(runDir);
  } finally {
    if (!opts.keepRunDir && existsSync(join(runDir, "done.txt"))) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

export { sleep };
