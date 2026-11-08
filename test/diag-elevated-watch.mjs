/**
 * Diagnose why the sentinel watcher fails in an ELEVATED host but works unelevated.
 *
 * Runs the real ELEVATED_SCRIPT through elevate(), then reports every mailbox
 * file including watch-error.txt, which the host writes when it cannot start the
 * watcher. Keeps the run dir so the evidence survives.
 *
 * Run: node test/diag-elevated-watch.mjs   (needs a human to click UAC)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const { elevate } = await import("../lib/elevate.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prints diagnostics about the watcher environment, then blocks. If the watcher
// never starts, this output is the only thing we get.
const CODE = String.raw`
"elevated= " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"LanguageMode= " + $ExecutionContext.SessionState.LanguageMode
# Try creating a runspace the same way the host does, and report the outcome.
try {
  $ps = [powershell]::Create()
  [void]$ps.AddScript('"probe from runspace: " + $PID')
  $h = $ps.BeginInvoke()
  $out = $ps.EndInvoke($h)
  "runspace probe OK: " + ($out -join '')
  $ps.Dispose()
} catch {
  "runspace probe FAILED: " + $_.Exception.GetType().Name + " / " + $_.Exception.Message
}
"run dir= $($args[0])"
"now sleeping 45s"
Start-Sleep -Seconds 45
"never reached"
`;

console.log("launching elevated diagnostic run — click YES on UAC");
const result = await elevate(CODE, { timeoutMs: 90_000, keepRunDir: true });
console.log(`status=${result.status} exitCode=${result.exitCode}`);
console.log(`runDir=${result.runDir}`);

const dir = result.runDir;
if (dir && existsSync(dir)) {
  const files = readdirSync(dir).sort();
  console.log("--- files ---");
  for (const f of files) {
    const p = join(dir, f);
    const size = statSync(p).size;
    console.log(`${f} (${size} B)`);
    if (size > 0 && size < 4000) console.log(readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/^/gm, "   | "));
  }
}
console.log("\n--- captured stdout ---");
console.log(result.stdout || "(empty)");
