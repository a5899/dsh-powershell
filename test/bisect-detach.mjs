/**
 * Bisect WHY a detached launcher produces nothing.
 *
 * The failing path: node spawns a DETACHED powershell that calls
 * `Start-Process -Verb RunAs`, and no prompt appears and no file is written —
 * the launcher dies silently. The working path: the same launcher spawned with
 * `-WindowStyle Hidden` + PassThru from an interactive PowerShell prompt.
 *
 * Four variants, each writing a heartbeat file so "live but stuck" is
 * distinguishable from "died at once":
 *   A  node spawns launcher directly (detached)          — the failing case
 *   B  node spawns an intermediate, which spawns launcher — one extra hop
 *   C  launcher rewrites its own error to a file          — is it even throwing?
 *   D  launcher started from this script's own PowerShell — cross-check
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dshps-bisect-"));
console.log(`dir = ${dir}`);

const launcher = `param([string]$Dir, [string]$Tag)
$ErrorActionPreference = 'Continue'
$log = Join-Path $Dir "trace-$Tag.txt"
function Note($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss.fff), $m) }
Note "start pid=$PID"
try {
  Note "invoking Start-Process -Verb RunAs"
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 5') -Verb RunAs -PassThru
  Note "returned pid=$($p.Id)"
} catch {
  Note ("EXCEPTION: " + $_.Exception.GetType().FullName + " :: " + $_.Exception.Message)
  $inner = $_.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException; Note ("INNER: " + $inner.GetType().FullName + " :: " + $inner.Message) }
}
Note "exit"
`;
writeFileSync(join(dir, "launcher.ps1"), launcher, "utf8");

const ps = { windowsHide: true, stdio: "ignore", detached: true };

function spawnVariant(tag, args, opts = ps) {
  const child = spawn("powershell.exe", args, opts);
  child.unref();
  return child.pid;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const trace = (tag) => (existsSync(join(dir, `trace-${tag}.txt`)) ? readFileSync(join(dir, `trace-${tag}.txt`), "utf8").trim() : "<no trace — launcher never ran>");

// A: direct detached spawn, -File
const pidA = spawnVariant("A", ["-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", join(dir, "launcher.ps1"), "-Dir", dir, "-Tag", "A"]);
// B: direct detached spawn, -EncodedCommand instead of -File
const b64 = Buffer.from(`& '${join(dir, "launcher.ps1")}' -Dir '${dir}' -Tag 'B'`, "utf16le").toString("base64");
const pidB = spawnVariant("B", ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", b64]);
// D: through a cmd.exe hop (different console semantics)
const pidD = spawnVariant("D", ["/c", "start", "/min", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "launcher.ps1"), "-Dir", dir, "-Tag", "D"], { ...ps, shell: "cmd.exe" });

console.log(`spawned A=${pidA} B=${pidB} D=${pidD} — click YES on any prompts`);
await wait(8000);

for (const tag of ["A", "B", "D"]) {
  console.log(`\n===== variant ${tag} =====`);
  console.log(trace(tag));
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${tag === "A" ? pidA : tag === "B" ? pidB : pidD}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    console.log("launcher process alive:", !/No tasks/i.test(out));
  } catch {
    console.log("launcher process alive: (unknown)");
  }
}
console.log(`\ntraces in ${dir}`);
