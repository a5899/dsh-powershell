/**
 * Does the launcher survive when spawned the way the plugin now spawns it?
 *
 * The plugin used `detached:true` + `windowsHide:true`; the launcher then never
 * ran at all (no trace file, gone instantly). This probe uses plain spawn and a
 * fake elevation target so it CANNOT raise UAC: it proves the launcher runs,
 * writes its mailbox, and that a non-elevated Start-Process works — without
 * putting a prompt in front of someone who is away from the screen.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dshps-nouac-"));
console.log(`dir = ${dir}`);

// A launcher that exercises every step EXCEPT -Verb RunAs.
const launcher = `param([string]$Dir)
$log = Join-Path $Dir 'trace.txt'
function Note($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss.fff), $m) }
Note "launcher start pid=$PID interactive=$([Environment]::UserInteractive)"
try {
  # Same Start-Process shape as the real launcher, minus elevation.
  $args_ = @('-NoProfile','-NonInteractive','-File', (Join-Path $Dir 'child.ps1'), '-Dir', $Dir)
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args_ -PassThru -ErrorAction Stop
  Note "Start-Process returned pid=$($p.Id)"
  [System.IO.File]::WriteAllText((Join-Path $Dir 'launch.txt'), 'started', (New-Object System.Text.UTF8Encoding($false)))
} catch {
  Note ("EXCEPTION " + $_.Exception.Message)
  [System.IO.File]::WriteAllText((Join-Path $Dir 'launch.txt'), ('{"code":"launch-failed","message":"' + $_.Exception.Message.Replace('"','') + '"}'), (New-Object System.Text.UTF8Encoding($false)))
}
Note "launcher exit"
`;
const child = `param([string]$Dir)
"child ran at $(Get-Date -Format HH:mm:ss)" | Set-Content -LiteralPath (Join-Path $Dir 'pid.txt') -Encoding utf8
"from-child" | Set-Content -LiteralPath (Join-Path $Dir 'done.txt') -Encoding utf8
`;
writeFileSync(join(dir, "launcher.ps1"), launcher, "utf8");
writeFileSync(join(dir, "child.ps1"), child, "utf8");

const t0 = Date.now();
const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", join(dir, "launcher.ps1"), "-Dir", dir], {
  cwd: dir,
  stdio: "ignore",
});
console.log(`spawned launcher pid=${proc.pid} (plain spawn, no windowsHide, no detach)`);

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  if (existsSync(join(dir, "done.txt"))) break;
  await new Promise((r) => setTimeout(r, 200));
}

const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "<missing>");
console.log(`\nafter ${Date.now() - t0}ms`);
console.log("trace.txt :\n" + read("trace.txt"));
console.log("launch.txt:", read("launch.txt"));
console.log("pid.txt   :", read("pid.txt") || "<missing>");
console.log("done.txt  :", read("done.txt") || "<missing>");

const ok = existsSync(join(dir, "done.txt")) && read("launch.txt") === "started";
console.log(ok ? "VERDICT: launcher runs and the mailbox protocol completes" : "VERDICT: FAILED");
process.exit(ok ? 0 : 1);
