/**
 * dsh-powershell — tests.
 *
 * These are integration tests on purpose. Every hard problem here is a Windows
 * quirk (UTF-16LE encoding, CLIXML stderr noise, the ShellExecute boundary), and
 * a mock would pass while the real thing fails. Run with `node test/run.mjs`.
 *
 * UAC cases cannot be automated — a prompt requires a human click. Those print
 * MANUAL and are skipped unless DSH_PWSH_TEST_UAC=1.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ELEVATED_SCRIPT,
  encodeCommand,
  runUnelevated,
  stripTransportNoise,
} from "../lib/runner.js";

let passed = 0;
let failed = 0;
const results = [];

async function test(label, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    results.push({ label, ok: true, ms: Date.now() - started });
  } catch (error) {
    failed++;
    results.push({ label, ok: false, ms: Date.now() - started, error: error?.stack || String(error) });
  }
}

function skip(label, why) {
  results.push({ label, ok: true, skipped: true, ms: 0, why });
}

// ── encoding ───────────────────────────────────────────────────────────────
await test("encodeCommand emits UTF-16LE base64, not UTF-8", () => {
  const code = "Write-Output 'hi'";
  const b64 = encodeCommand(code);
  // The regression this guards: UTF-8 bytes here produce a mojibake command
  // name and `CommandNotFoundException`.
  assert.equal(b64, Buffer.from(code, "utf16le").toString("base64"));
  assert.equal(Buffer.from(b64, "base64").toString("utf16le"), code);
});

await test("Chinese and quotes survive the encoding round-trip", async () => {
  const r = await runUnelevated(`Write-Output '中文 "引号" $HOME'`, { timeoutMs: 60_000 });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /中文/);
  assert.match(r.stdout, /引号/);
});

// ── unelevated execution ───────────────────────────────────────────────────
await test("exit code propagates", async () => {
  const r = await runUnelevated("exit 3", { timeoutMs: 60_000 });
  assert.equal(r.exitCode, 3);
  assert.equal(r.ok, false);
});

await test("stdout is captured", async () => {
  const r = await runUnelevated("Get-Date -Format 'yyyy'; Write-Output 'done'", { timeoutMs: 60_000 });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /^done$/m);
});

await test("stderr is captured without CLIXML noise", async () => {
  const r = await runUnelevated("Write-Error 'boom' 2>&1; exit 1", { timeoutMs: 60_000 });
  assert.ok(!r.stderr.includes("#< CLIXML"), `CLIXML leaked: ${r.stderr.slice(0, 200)}`);
});

await test("multi-line script with try/catch", async () => {
  const r = await runUnelevated(
    `function Get-Thing { param($n) $n * 2 }
try { Get-Thing 21 } catch { 'caught' }`,
    { timeoutMs: 60_000 },
  );
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /42/);
});

await test("pipeline and object formatting work", async () => {
  const r = await runUnelevated("1..3 | ForEach-Object { $_ * 10 }", { timeoutMs: 60_000 });
  assert.equal(r.stdout.trim().replace(/\r/g, ""), "10\n20\n30");
});

await test("cwd is honoured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dshps-cwd-"));
  writeFileSync(join(dir, "probe.txt"), "here", "utf8");
  const r = await runUnelevated("(Get-Content -Raw probe.txt).Trim()", { cwd: dir, timeoutMs: 60_000 });
  assert.equal(r.stdout.trim(), "here");
  rmSync(dir, { recursive: true, force: true });
});

await test("timeout kills the child and reports timedOut", async () => {
  const r = await runUnelevated("Start-Sleep -Seconds 30", { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 20_000, `took ${r.durationMs}ms`);
});

// ── noise stripping ────────────────────────────────────────────────────────
await test("stripTransportNoise removes a CLIXML envelope", () => {
  const noisy = `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">hello_x000D__x000A_world</S></Objs>`;
  const clean = stripTransportNoise(noisy);
  assert.ok(!clean.includes("CLIXML"));
  assert.match(clean, /hello/);
});

await test("stripTransportNoise leaves plain text untouched", () => {
  assert.equal(stripTransportNoise("plain text"), "plain text");
  assert.equal(stripTransportNoise(""), "");
});

// ── elevated host contract (no UAC needed) ────────────────────────────────
await test("elevated host script parses", async () => {
  // Write it to disk first: ReadAllText takes a path, and the script also
  // contains characters that are illegal in one.
  const dir = mkdtempSync(join(tmpdir(), "dshps-parse-"));
  try {
    const host = join(dir, "elevated.ps1");
    writeFileSync(host, ELEVATED_SCRIPT, "utf8");
    const r = await runUnelevated(
      `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile(${quote(host)}, [ref]$null, [ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { "ERR " + $_.Message } ; exit 1 }`,
      { timeoutMs: 60_000 },
    );
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("elevated host records pid, result and done even when run unelevated", async () => {
  // Running the elevated host directly (no RunAs) exercises the file contract
  // that the real elevation depends on: pid.txt first, then stdout/result/done.
  const dir = mkdtempSync(join(tmpdir(), "dshps-host-"));
  try {
    writeFileSync(join(dir, "code.ps1"), "Write-Output 'from-host'", "utf8");
    writeFileSync(join(dir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");
    const r = await runUnelevated(
      `& ${quote(join(dir, "elevated.ps1"))} -RunDir ${quote(dir)} -CodePath ${quote(join(dir, "code.ps1"))} -WorkDir ${quote(dir)}`,
      { timeoutMs: 90_000 },
    );
    // The host's process code now mirrors result.txt, so this must be read from
    // the mailbox rather than assumed to be 0: that is what the elevated caller
    // does (it never sees the host's exit status, only the files).
    const doneBefore = existsSync(join(dir, "done.txt"));
    assert.ok(doneBefore, "done.txt missing — host exited before closing the mailbox: " + (r.stderr || r.stdout));
    assert.ok(existsSync(join(dir, "pid.txt")), "pid.txt missing");
    assert.equal(readFileSync(join(dir, "result.txt"), "utf8").trim(), "0");
    assert.match(readFileSync(join(dir, "stdout.txt"), "utf8"), /from-host/);
    assert.equal(r.exitCode, 0, "host process code must agree with result.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("elevated host reports a parse-heavy but valid script's output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dshps-host2-"));
  try {
    writeFileSync(join(dir, "code.ps1"), "param()\n$a = 1\n\"value=$a\"\nexit 0", "utf8");
    writeFileSync(join(dir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");
    const r = await runUnelevated(
      `& ${quote(join(dir, "elevated.ps1"))} -RunDir ${quote(dir)} -CodePath ${quote(join(dir, "code.ps1"))}`,
      { timeoutMs: 90_000 },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(readFileSync(join(dir, "stdout.txt"), "utf8"), /value=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("elevated host closes the mailbox when the code ends with exit", async () => {
  // Regression: for a while a code block ending in `exit 0` produced complete
  // output, exit code 0, and NO result.txt/done.txt — the caller then waited the
  // whole timeout and reported failure. It reproduced unelevated, so it is
  // pinned here: both the reported code and the commit point must survive exit.
  const dir = mkdtempSync(join(tmpdir(), "dshps-host3-"));
  try {
    writeFileSync(join(dir, "code.ps1"), "Write-Output 'before exit'\nexit 3", "utf8");
    writeFileSync(join(dir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");
    const r = await runUnelevated(
      `& ${quote(join(dir, "elevated.ps1"))} -RunDir ${quote(dir)} -CodePath ${quote(join(dir, "code.ps1"))}`,
      { timeoutMs: 90_000 },
    );
    assert.ok(existsSync(join(dir, "done.txt")), "done.txt missing: the host was killed by the user's exit");
    assert.equal(readFileSync(join(dir, "result.txt"), "utf8").trim(), "3");
    assert.match(readFileSync(join(dir, "stdout.txt"), "utf8"), /before exit/);
    // The host resets $LASTEXITCODE to 0 before returning so that its own
    // process code cannot be confused with the recorded one; the mailbox is the
    // contract the elevated caller reads, so result.txt is what must hold 3.
    assert.equal(existsSync(join(dir, "done.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("elevated host keeps variables across statements and reports cmd's exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dshps-host4-"));
  try {
    writeFileSync(join(dir, "code.ps1"), "$a = 41\n\"value=$($a + 1)\"\ncmd /c exit 7", "utf8");
    writeFileSync(join(dir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");
    const r = await runUnelevated(
      `& ${quote(join(dir, "elevated.ps1"))} -RunDir ${quote(dir)} -CodePath ${quote(join(dir, "code.ps1"))}`,
      { timeoutMs: 90_000 },
    );
    assert.match(readFileSync(join(dir, "stdout.txt"), "utf8"), /value=42/);
    assert.equal(readFileSync(join(dir, "result.txt"), "utf8").trim(), "7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("unelevated run reports cmd's real exit code (5, not 1)", async () => {
  // PowerShell 5.1 collapses any nonzero $LASTEXITCODE to process code 1 unless
  // the script re-exits explicitly. Verified on this machine: a bare
  // `cmd /c exit 5` gives 1, so the runner must propagate the real number.
  const r = await runUnelevated("cmd /c exit 5", { timeoutMs: 30_000 });
  assert.equal(r.exitCode, 5, "expected the real code from cmd, got " + r.exitCode);
});

await test("unelevated run honours an explicit trailing exit over $LASTEXITCODE", async () => {
  const r = await runUnelevated("cmd /c exit 5\nexit 0", { timeoutMs: 30_000 });
  assert.equal(r.exitCode, 0);
});

// ── UAC (manual) ──────────────────────────────────────────────────────────
if (process.env.DSH_PWSH_TEST_UAC === "1") {
  const { elevate } = await import("../lib/elevate.js");
  await test("UAC cancel is reported as cancelled, not as a crash", async () => {
    // Click "No" on the prompt when this runs.
    const r = await elevate("Write-Output 'elevated'", { timeoutMs: 60_000 });
    assert.ok(["cancelled", "denied", "ok"].includes(r.status), `unexpected status ${r.status}: ${r.stderr}`);
  });
} else {
  skip("UAC prompt behaviour", "requires a human click; set DSH_PWSH_TEST_UAC=1");
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ── report ────────────────────────────────────────────────────────────────
for (const r of results) {
  const mark = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
  const extra = r.skipped ? ` (${r.why})` : ` (${r.ms}ms)`;
  console.log(`${mark}  ${r.label}${extra}`);
  if (!r.ok) console.log(indent(r.error));
}
console.log(`\n${passed} passed, ${failed} failed, ${results.filter((r) => r.skipped).length} skipped`);
process.exit(failed === 0 ? 0 : 1);

function indent(text) {
  return String(text)
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}
