/**
 * Live check of the background job layer — no DSH, no plugin host.
 *
 * The point of `psh_job` is that output must be readable WHILE the command is
 * still running, and that a fast poller must never lose or duplicate a byte.
 * Both properties are invisible in a "did it finish" test, so this drives the
 * real module and asserts them on wall-clock time and byte offsets.
 *
 * Run: node test/jobs-probe.mjs
 */
import { pollJob, startJob, listJobs, stopJob } from "../lib/jobs.js";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. output is readable before the command finishes ────────────────────
  // Six ticks at 700 ms = ~4.2 s total. Reading tick 3 while ticks 4-6 are
  // still in the future is the whole feature; a "wait for exit" implementation
  // cannot pass this.
  const job = startJob(
    `1..6 | ForEach-Object {
       ("[{0:HH:mm:ss.fff}] line {1}" -f (Get-Date), $_)
       Start-Sleep -Milliseconds 700
     }`,
    { label: "streaming check", timeoutMs: 30000 },
  );
  console.log(`started ${job.id} pid=${job.pid}`);

  const seenWhileRunning = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(900);
    const snap = pollJob(job.id, { offset });
    if (!snap) throw new Error("job vanished");
    offset = snap.offset;
    const midRun = !snap.done;
    for (const line of snap.output.split("\n").filter(Boolean)) {
      seenWhileRunning.push({ line, midRun });
    }
    if (snap.done) break;
  }

  const early = seenWhileRunning.filter((r) => r.midRun);
  console.log(`lines captured while still running: ${early.length}`);
  for (const r of early) console.log(`   (running) ${r.line}`);
  assert.ok(
    early.length >= 3,
    `expected several lines readable mid-run, got ${early.length}`,
  );

  // ── 2. the cursor is lossless and gap-free ───────────────────────────────
  const final = pollJob(job.id, { offset });
  assert.equal(final.done, true, "job should be finished by now");
  const all = [...early.map((r) => r.line), ...final.output.split("\n").filter(Boolean)];
  const expected = [1, 2, 3, 4, 5, 6].map((n) => `line ${n}`);
  // Timestamps must be real, not the unformatted "{0:HH:mm:ss.fff}" placeholder —
  // an earlier version of this test passed while the PowerShell line was never
  // formatted, because the assertion ignored everything before "line N".
  for (const line of all) {
    assert.match(line, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] line \d$/, `malformed line: ${JSON.stringify(line)}`);
  }
  const gotOrder = all.map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim());
  assert.deepEqual(gotOrder, expected, `lines out of order or missing: ${gotOrder.join(" | ")}`);
  console.log(`order intact across ${seenWhileRunning.length + final.output.split("\n").filter(Boolean).length} reads`);
  assert.equal(final.exitCode, 0, `exit code ${final.exitCode}`);

  // ── 3. a runaway printer is cut off at maxBytes ─────────────────────────
  const flood = startJob(`while ($true) { "spam spam spam spam spam spam spam spam" }`, {
    label: "flood",
    timeoutMs: 20000,
    maxBytes: 64 * 1024,
  });
  let floodSnap = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    floodSnap = pollJob(flood.id, { offset: 0 });
    if (floodSnap.done) break;
  }
  console.log(`flood: done=${floodSnap.done} limitExceeded=${floodSnap.limitExceeded} bytes=${floodSnap.total}`);
  assert.equal(floodSnap.done, true, "flood job must terminate on the byte cap, not run forever");
  assert.equal(floodSnap.limitExceeded, true, "flood job should report limit-exceeded");
  assert.ok(floodSnap.total <= 64 * 1024 + 4096, `captured ${floodSnap.total} bytes, cap was 64 KiB`);

  // ── 4. timeout still hands back partial output ──────────────────────────
  const slow = startJob(`"before the wait"; Start-Sleep -Seconds 30; "never"`, {
    label: "timeout",
    timeoutMs: 700,
  });
  await sleep(1600);
  const slowSnap = pollJob(slow.id, { offset: 0 });
  console.log(`timeout: done=${slowSnap.done} timedOut=${slowSnap.timedOut} out=${JSON.stringify(slowSnap.output.trim())}`);
  assert.equal(slowSnap.timedOut, true, "should be marked timed out");
  assert.match(slowSnap.output, /before the wait/, "partial output must survive the timeout");

  // ── 5. exit codes are passed through, not collapsed to 1 ────────────────
  const bad = startJob(`cmd /c exit 7`, { label: "exit code", timeoutMs: 15000 });
  await sleep(2500);
  const badSnap = pollJob(bad.id, { offset: 0 });
  console.log(`exit code: ${badSnap.exitCode} (expected 7)`);
  assert.equal(badSnap.exitCode, 7, "PS 5.1 must not collapse this to 1");

  // ── 6. stop works, and reports honestly when there is nothing to stop ───
  const victim = startJob(`Start-Sleep -Seconds 60`, { label: "victim", timeoutMs: 0 });
  await sleep(600);
  const stopResult = stopJob(victim.id);
  console.log(`stop: ${JSON.stringify(stopResult)}`);
  assert.equal(stopResult.stopped, true, "a live job should be stoppable");
  await sleep(800);
  const afterStop = pollJob(victim.id, { offset: 0 });
  assert.equal(afterStop.done, true, "stopped job should be marked done");
  const stopAgain = stopJob(victim.id);
  assert.equal(stopAgain.stopped, false);
  assert.equal(stopAgain.reason, "already-done", "second stop must not lie about killing it");

  // ── 7. listing sees everything started ──────────────────────────────────
  const listed = listJobs();
  console.log(`listed ${listed.length} jobs`);
  assert.ok(listed.length >= 5, `expected all jobs listed, got ${listed.length}`);

  console.log("\nOK: streaming, cursors, byte cap, timeout, exit codes, stop all behave");
}

main().catch((error) => {
  console.error("FAIL:", error.message);
  process.exit(1);
});
