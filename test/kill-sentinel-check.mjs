/**
 * The sentinel kill must work even while the user's code is blocked.
 *
 * A lower-integrity process cannot TerminateProcess a higher one, so the only
 * way out of a hung elevated run is the host ending ITSELF. This drives the real
 * elevated host script unelevated (same code path, same watch) and proves:
 *   1. without a sentinel the host keeps running;
 *   2. writing `kill-request` into the run dir makes it exit while the user's
 *      code is still sleeping — i.e. the watcher is on a separate thread, not a
 *      check in the main pipeline.
 *
 * Run: node test/kill-sentinel-check.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const { ELEVATED_SCRIPT, EXE_POWERSHELL } = await import("../lib/runner.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runDir = mkdtempSync(join(tmpdir(), "dshps-kill-"));
const codePath = join(runDir, "code.ps1");
const hostPath = join(runDir, "elevated.ps1");

// The user's command blocks for 120 s. Nothing in the main pipeline can run
// while it sleeps, so a successful kill proves the watcher is separate.
writeFileSync(codePath, `"blocking start"\nStart-Sleep -Seconds 120\n"should never print"`, "utf8");
writeFileSync(hostPath, ELEVATED_SCRIPT, "utf8");

const child = spawn(EXE_POWERSHELL, [
  "-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass",
  "-File", hostPath, "-RunDir", runDir, "-CodePath", codePath,
], { windowsHide: true, stdio: "ignore" });

const pid = child.pid;

try {
  // 1. Wait until the mailbox exists: that means the host got past the watcher
  //    setup and is inside the user's blocking command.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !existsSync(join(runDir, "stdout.txt"))) await sleep(100);
  assert.ok(existsSync(join(runDir, "stdout.txt")), "the host should have started and created stdout.txt");

  await sleep(1500);
  const stillRunning = (() => {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  })();
  assert.ok(stillRunning, "before any sentinel the host must still be alive");
  console.log(`pid ${pid} running with a 120s sleep in progress`);

  // 2. Drop the sentinel. The watcher polls every 250 ms.
  writeFileSync(join(runDir, "kill-request"), "test", "utf8");
  const killDeadline = Date.now() + 8000;
  let gone = false;
  while (Date.now() < killDeadline) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") { gone = true; break; } }
    await sleep(150);
  }
  assert.ok(gone, "the sentinel must make the host exit even though the user code is blocking");
  const took = Math.round(8000 - (killDeadline - Date.now()));
  console.log(`sentinel seen -> host exited after ~${took}ms`);

  // 3. The run must be CUT SHORT, not completed: the line after the sleep must
  //    never appear. Note the line before it is also absent — output is
  //    collected only once the whole block returns (see the pipeline comment in
  //    ELEVATED_SCRIPT), so a run killed mid-block loses its partial output.
  //    That is the documented trade-off: being able to kill it at all matters
  //    more than seeing what it printed before it hung.
  const text = readFileSync(join(runDir, "stdout.txt"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(!text.includes("should never print"), "the run must be cut short, not completed");
  console.log(`stdout captured -> ${JSON.stringify(text.trim())} (empty is expected: killed mid-block)`);

  // 4. done.txt must NOT exist: the sentinel killed the host before the mailbox
  //    closed, so the caller correctly reports "did not finish".
  assert.ok(!existsSync(join(runDir, "done.txt")), "a killed run must not claim to have finished");
  console.log("done.txt absent (a killed run does not claim success)");

  console.log("\nOK: the sentinel terminates a blocked elevated run from outside");
} finally {
  try { child.kill(); } catch {}
  // The child may have died already; make sure no stray process holds the dir.
  try {
    if (existsSync(join(runDir, "pid.txt"))) {
      const p = Number(readFileSync(join(runDir, "pid.txt"), "utf8").trim());
      if (Number.isFinite(p) && p > 0) { try { process.kill(p, 0); spawn("taskkill", ["/PID", String(p), "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
    }
  } catch {}
  rmSync(runDir, { recursive: true, force: true });
}
