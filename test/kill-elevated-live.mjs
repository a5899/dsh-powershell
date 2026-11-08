/**
 * Live check: an ELEVATED run that hangs can be ended by psh_kill's sentinel.
 *
 * Unlike kill-sentinel-check.mjs (which drives the host unelevated), this raises
 * a real UAC prompt and then proves the sentinel reaches a genuinely elevated
 * process from a genuinely unelevated parent — the only configuration where a
 * direct TerminateProcess is impossible.
 *
 * The run directory cannot be read from the elevate() return value, because that
 * promise only settles when the run ENDS — and we need to act while it hangs. So
 * the directory is handed to this script explicitly: elevate() accepts runDir.
 *
 * Run: node test/kill-elevated-live.mjs      (needs a human to click UAC)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const { elevate, killElevatedPid } = await import("../lib/elevate.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

const runDir = mkdtempSync(join(tmpdir(), "dsh-powershell-elev-live-"));
console.log(`run dir: ${runDir}`);

const CODE = `"proof: elevated=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"\n"going to sleep for 180s - kill me"\nStart-Sleep -Seconds 180\n"should never print"`;

console.log("launching an elevated run that blocks for 180s — click YES on UAC");
const live = [];
const pending = elevate(CODE, {
  runDir,
  timeoutMs: 240_000,
  keepRunDir: true,
  onData: (chunk) => live.push(String(chunk)),
});

// Wait for the elevated host to announce itself. pid.txt is written by the
// launcher right after Start-Process returns (i.e. after the user clicks Yes),
// so its appearance is the signal that a genuinely elevated process exists.
const pidFile = join(runDir, "pid.txt");
console.log("waiting for UAC approval…");
const pidDeadline = Date.now() + 180_000;
while (Date.now() < pidDeadline && !existsSync(pidFile)) await sleep(300);
assert.ok(existsSync(pidFile), "no pid.txt: the UAC prompt was never approved (or was cancelled)");
const pid = Number(readFileSync(pidFile, "utf8").trim());
assert.ok(Number.isFinite(pid) && pid > 0, `bad pid in pid.txt: ${readFileSync(pidFile, "utf8")}`);
console.log(`elevated pid: ${pid}`);

// Give the user code a moment to start sleeping, then confirm it is running.
await sleep(4000);
assert.ok(alive(pid), "the elevated run should still be alive (it is sleeping 180s)");
console.log("still alive while sleeping, as expected");
console.log(`output so far: ${JSON.stringify(live.join("").trim())}`);

// The kill. taskkill from here must fail (different integrity level), so the
// sentinel is the only route; killElevatedPid reports which method won.
const outcome = await killElevatedPid(pid, { runDir, waitMs: 30_000 });
console.log(`killElevatedPid -> ok=${outcome.ok} method=${outcome.method}`);
console.log(`   ${outcome.detail}`);

assert.ok(!alive(pid), "the elevated process must be gone after the sentinel");
console.log("elevated process is gone");

// A killed run must not pretend it finished.
assert.ok(!existsSync(join(runDir, "done.txt")), "a killed run must not write done.txt");
console.log("done.txt absent, so the run does not claim success");

// Let the pending elevate() settle; it will report a non-ok status because the
// host died before closing its mailbox.
const result = await pending;
console.log(`elevate() settled: status=${result.status} exitCode=${result.exitCode}`);

try { rmSync(runDir, { recursive: true, force: true }); } catch {}
console.log("\nOK: a hung ELEVATED run is terminated from an unelevated parent, with no script block logging");
