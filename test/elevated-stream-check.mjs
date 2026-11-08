/**
 * Prove the elevated host emits output WHILE the command is still running.
 *
 * The earlier implementation did `$items = & sb *>&1` and then looped — the
 * whole array came back only when the block returned, so a command that printed
 * and then slept wrote NOTHING to stdout.txt for the entire sleep. Every "live"
 * demo passed only because the command finished in under a second.
 *
 * This test runs the host UNELEVATED (same script) with a code body that prints
 * three lines 900 ms apart, and samples stdout.txt from outside. At least one
 * sample must be non-empty BEFORE result.txt/done.txt exist.
 *
 * Run: node test/elevated-stream-check.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const { ELEVATED_SCRIPT, runUnelevated, quoteArg: quote } = await import("../lib/runner.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "dshps-stream-"));
const outPath = join(dir, "stdout.txt");
const donePath = join(dir, "done.txt");

writeFileSync(
  join(dir, "code.ps1"),
  ["'first'", "Start-Sleep -Milliseconds 900", "'second'", "Start-Sleep -Milliseconds 900", "'third'"].join("\n"),
  "utf8",
);
writeFileSync(join(dir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");

const runPromise = runUnelevated(
  `& ${quote(join(dir, "elevated.ps1"))} -RunDir ${quote(dir)} -CodePath ${quote(join(dir, "code.ps1"))}`,
  { timeoutMs: 60_000 },
);

let sawOutputWhileRunning = false;
let samples = 0;
let firstNonEmptyAt = null;
const started = Date.now();
while (!existsSync(donePath) && Date.now() - started < 30_000) {
  samples += 1;
  let text = "";
  try { text = readFileSync(outPath, "utf8"); } catch {}
  if (text.trim()) {
    sawOutputWhileRunning = true;
    if (firstNonEmptyAt === null) firstNonEmptyAt = Date.now() - started;
    // Do not break: we want to confirm done.txt really was still absent.
  }
  await sleep(100);
}

const result = await runPromise;
const finalOut = readFileSync(outPath, "utf8");

console.log(`samples taken while running: ${samples}`);
console.log(`first non-empty sample at: ${firstNonEmptyAt === null ? "never" : firstNonEmptyAt + "ms"}`);
console.log(`stdout.txt final: ${JSON.stringify(finalOut)}`);
console.log(`exit code: ${result.exitCode}`);

try {
  assert.ok(sawOutputWhileRunning, "stdout.txt stayed empty for the whole run: output is still buffered, not streamed");
  assert.match(finalOut, /first[\s\S]*second[\s\S]*third/, "all three lines must be present, in order");
  assert.ok(firstNonEmptyAt !== null && firstNonEmptyAt < 1700, `first output arrived at ${firstNonEmptyAt}ms; expected well before the ~1800ms run ends`);
  console.log("\nOK: the host writes each line as it is produced, not when the run ends");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
