/**
 * Prove the job engine streams against a REAL long-running command while a
 * human is watching the clock — run this from the repo root:
 *
 *   node test/live-job-demo.mjs
 *
 * Unlike jobs-probe.mjs (which asserts), this prints a timeline so the output
 * sequence itself shows that bytes arrive before the command exits.
 */
import { pollJob, startJob, stopJob } from "../lib/jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(5)}ms`;

const job = startJob(
  `1..8 | ForEach-Object {
     ("[{0:HH:mm:ss.fff}] step {1}/8" -f (Get-Date), $_)
     Start-Sleep -Milliseconds 1000
   }
   ("[{0:HH:mm:ss.fff}] finished" -f (Get-Date))`,
  { label: "live demo", timeoutMs: 60000 },
);

console.log(`${stamp()} started ${job.id} pid=${job.pid}`);

let offset = 0;
let polls = 0;
while (polls < 40) {
  await sleep(700);
  polls++;
  const snap = pollJob(job.id, { offset });
  if (!snap) break;
  offset = snap.offset;
  for (const line of snap.output.split("\n").filter(Boolean)) {
    console.log(`${stamp()} [${snap.done ? "done" : "live"}] ${line}`);
  }
  if (snap.done) {
    console.log(`${stamp()} exit=${snap.exitCode} total=${snap.total}B polls=${polls}`);
    break;
  }
}

// A stopped job must say so, not hang.
const victim = startJob(`Start-Sleep -Seconds 120`, { label: "victim", timeoutMs: 0 });
await sleep(500);
console.log(`${stamp()} stop -> ${JSON.stringify(stopJob(victim.id))}`);
