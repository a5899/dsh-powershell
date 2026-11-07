/**
 * Manual probe for the real UAC path. Run: node test/uac-probe.mjs [--cancel]
 *
 * Not part of `test/run.mjs` because it needs a human in front of the screen.
 * The command itself writes a harmless timestamp to %TEMP%; declining the
 * prompt must be reported as `cancelled` rather than as a crash or a timeout.
 */
import { elevate } from "../lib/elevate.js";

const expectCancel = process.argv.includes("--cancel");
console.log(
  expectCancel
    ? "A UAC prompt will appear — click NO. Expecting status=cancelled."
    : "A UAC prompt will appear — click YES. Expecting status=ok.",
);

const result = await elevate(
  `$p = Join-Path $env:TEMP 'dsh-powershell-uac-probe.txt'
Set-Content -LiteralPath $p -Value ("elevated at " + (Get-Date -Format o)) -Encoding utf8
"wrote $p"
"elevated-process: " + ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
  { timeoutMs: 120_000 },
);

console.log(JSON.stringify({
  status: result.status,
  ok: result.ok,
  exitCode: result.exitCode,
  durationMs: result.durationMs,
  stdout: result.stdout.trim(),
  stderr: result.stderr.trim().slice(0, 400),
  elevatedPid: result.elevatedPid,
}, null, 2));

const verdict = expectCancel
  ? result.status === "cancelled" || result.status === "denied"
  : result.status === "ok" && /True/.test(result.stdout);
console.log(verdict ? "VERDICT: as expected" : "VERDICT: UNEXPECTED");
process.exit(verdict ? 0 : 1);
