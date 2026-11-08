/**
 * Labels must describe the job, not the script's scaffolding. `psh_job list`
 * is the only place a human sees these, so they have to be readable.
 */
import { killAllJobs, listJobs, startJob } from "../lib/jobs.js";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cases = [
  {
    code: `1..4 | ForEach-Object {
  ("[{0:HH:mm:ss}] tick {1}" -f (Get-Date), $_)
  Start-Sleep -Milliseconds 50
}`,
    expect: "(empty)", // every line is scaffolding → falls back, must not be a -f line
  },
  {
    code: `# build the thing
Get-Process | Measure-Object`,
    expect: "Get-Process | Measure-Object",
  },
  {
    code: `Write-Output "hello"`,
    expect: `Write-Output "hello"`,
  },
];

for (const c of cases) {
  const job = startJob(c.code, { timeoutMs: 5000 });
  await sleep(400);
  const entry = listJobs().find((j) => j.id === job.id);
  assert.ok(entry, `job ${job.id} should be listed`);
  assert.ok(
    !/-f\s/.test(entry.label ?? ""),
    `label must not be a format-expression line, got ${JSON.stringify(entry.label)}`,
  );
  console.log(`${job.id} label=${JSON.stringify(entry.label)}`);
}

// The explicit label always wins.
const labelled = startJob(`Start-Sleep -Milliseconds 100`, { label: "explicit label", timeoutMs: 5000 });
await sleep(300);
const found = listJobs().find((j) => j.id === labelled.id);
assert.equal(found.label, "explicit label", "explicit label must be preserved");
console.log(`explicit -> ${JSON.stringify(found.label)}`);

killAllJobs();
console.log("\nOK: labels describe jobs, never scaffolding");
