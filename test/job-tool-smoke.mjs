/**
 * Drive the REAL plugin entry (apply + execute) through a fake ctx, focusing on
 * psh_job. Schema checks prove the tools register; this proves they actually
 * stream, because a tool that registers but returns the wrong shape is still a
 * broken tool.
 */
import { apply } from "../lib/index.js";

const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  // Must RUN the callback, exactly like the host's `ctx.effect(fn)` does.
  // Returning a no-op disposer without calling `fn` registers nothing, which
  // silently makes this test pass over an empty tool set.
  effect: (fn) => fn(),
  prompt: { register: () => () => {} },
  logger: { info() {}, warn() {}, error() {} },
};

apply(ctx, { enabled: true, preferCommands: false });

const job = tools.get("psh_job");
if (!job) { console.error(`FAIL: psh_job not registered (have: ${[...tools.keys()].join(", ")})`); process.exit(1); }
console.log(`registered: ${[...tools.keys()].join(", ")}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `-f` formatting on purpose: an unformatted template still "passes" a loose
// assertion, which is exactly how the first version of this test lied.
const started = await job.execute({
  action: "start",
  timeoutMs: 30000,
  code: `1..4 | ForEach-Object {
    ("[{0:HH:mm:ss}] tick {1}" -f (Get-Date), $_)
    Start-Sleep -Milliseconds 800
  }`,
});
console.log(`start -> id=${started.id} pid=${started.pid} ok=${started.ok}`);
if (!started.ok || !started.id) { console.error("FAIL: start", started); process.exit(1); }

// Poll while it runs. Each poll must return quickly and bring new lines.
let offset = 0;
let midRunReads = 0;
const lines = [];
for (let i = 0; i < 8; i++) {
  await sleep(500);
  const snap = await job.execute({ action: "poll", id: started.id, offset });
  offset = snap.offset;
  const text = String(snap.output || "").trim();
  if (text) for (const l of text.split("\n")) lines.push({ line: l, done: snap.done });
  if (!snap.done && text) midRunReads++;
  if (snap.done) { console.log(`finished exit=${snap.exitCode} after ${(snap.durationMs / 1000).toFixed(1)}s`); break; }
}

console.log(`lines read while still running: ${midRunReads > 0 ? "yes" : "NO"}; total lines=${lines.length}`);

// A completed job must still be readable (the caller usually polls once more).
const final = await job.execute({ action: "poll", id: started.id, offset: 0 });
console.log(`re-read from offset 0 -> ${String(final.output || "").trim().split("\n").length} lines, done=${final.done}, exit=${final.exitCode}`);

const listed = await job.execute({ action: "list" });
console.log(`list -> ${String(listed.jobs || "").split("\n")[0]}`);

// Error paths must be honest, not silent.
const missing = await job.execute({ action: "poll", id: "job-does-not-exist", offset: 0 });
const badAction = await job.execute({ action: "nonsense" });
const emptyCode = await job.execute({ action: "start", code: "   " });

console.log(`missing id -> ok=${missing.ok}`);
console.log(`bad action -> ok=${badAction.ok}`);
console.log(`empty code -> ok=${emptyCode.ok}`);

const problems = [];
if (midRunReads === 0) problems.push("nothing was readable while the job was running");
if (lines.length !== 4) problems.push(`expected 4 lines, saw ${lines.length}`);
if (final.exitCode !== 0) problems.push(`expected exit 0, got ${final.exitCode}`);
if (missing.ok) problems.push("unknown job should not report ok");
if (badAction.ok) problems.push("unknown action should not report ok");
if (emptyCode.ok) problems.push("empty code should not report ok");

// The stop path: start a sleeper, stop it, confirm it is gone.
const victim = await job.execute({ action: "start", code: "Start-Sleep -Seconds 60", timeoutMs: 0 });
await sleep(700);
const stopped = await job.execute({ action: "stop", id: victim.id });
console.log(`stop -> ok=${stopped.ok} ${stopped.message}`);
if (!stopped.ok) problems.push("stop failed");

// Busy (non-zero) exit codes must survive.
const bad = await job.execute({ action: "start", code: "cmd /c exit 7", timeoutMs: 15000 });
await sleep(2000);
const badSnap = await job.execute({ action: "poll", id: bad.id, offset: 0 });
console.log(`cmd /c exit 7 -> exitCode=${badSnap.exitCode}`);
if (badSnap.exitCode !== 7) problems.push(`expected exit 7, got ${badSnap.exitCode}`);

if (problems.length) {
  console.error(`\nFAIL:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("\nOK: psh_job streams through the real plugin entry, and its error paths are honest");
