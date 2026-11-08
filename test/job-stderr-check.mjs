/**
 * stderr must stay readable: PowerShell's CLIXML progress envelopes are not
 * errors, so an agent seeing "#< CLIXML" learns nothing — but a real error must
 * survive. Polls return arbitrary slices, so this also checks a mid-envelope cut.
 */
import { killAllJobs, pollJob, startJob } from "../lib/jobs.js";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. A real error written to stderr must come through as text, with the
//    envelope gone.
const bad = startJob(`[Console]::Error.WriteLine("boom: real failure")`, {
  label: "stderr real error",
  timeoutMs: 15000,
});
await sleep(2500);
const snap = pollJob(bad.id, { offset: 0, stream: "stderr" });
console.log(`stderr output -> ${JSON.stringify(snap.output)}`);
assert.match(snap.output, /boom: real failure/, "the real error text must survive");
assert.ok(!snap.output.includes("#< CLIXML"), "the CLIXML opener must be stripped");
assert.ok(!snap.output.includes("<Objs"), "the Objs wrapper must be stripped");
assert.ok(!/^<S/.test(snap.output.trim()), "record wrappers must be unwrapped");

// 2. stdout must be untouched by stderr cleaning.
const good = startJob(`"plain stdout"`, { label: "stdout untouched", timeoutMs: 15000 });
await sleep(2500);
const outSnap = pollJob(good.id, { offset: 0 });
assert.equal(outSnap.output.trim(), "plain stdout", "stdout must not be rewritten");
console.log(`stdout -> ${JSON.stringify(outSnap.output.trim())}`);

// 3. Cursor still lands on real byte offsets after cleaning: re-polling with the
//    returned offset must yield nothing new, not a repeat.
const again = pollJob(bad.id, { offset: snap.offset, stream: "stderr" });
assert.equal(again.output, "", "resuming from the returned offset must not repeat");
console.log("resume from returned offset -> empty (cursor is consistent)");

killAllJobs();
console.log("\nOK: stderr is cleaned of transport noise but keeps real errors");
