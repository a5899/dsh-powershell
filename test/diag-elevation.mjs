/**
 * Diagnose a UAC/elevation run that produced no output.
 * Run: node test/diag-elevation.mjs
 *
 * A silent failure was traced to a real cause worth keeping: the run directory
 * under %TEMP% survives to the elevated (admin) process, which reads it fine —
 * but if `Start-Process` is asked to start a *hidden* launcher, the prompt can
 * fail to present. The probe keeps everything visible and reports each hop.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_SCRIPT, ELEVATED_SCRIPT } from "../lib/runner.js";

const runDir = mkdtempSync(join(tmpdir(), "dshps-diag-"));
console.log(`runDir = ${runDir}`);

writeFileSync(join(runDir, "code.ps1"), `"elevated-ok " + (Get-Date -Format o) + " elevated=" + ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`, "utf8");
writeFileSync(join(runDir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");
writeFileSync(join(runDir, "launch.ps1"), LAUNCH_SCRIPT, "utf8");

// What the plugin does: detached, no console at all.
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", join(runDir, "launch.ps1"),
    "-RunDir", runDir, "-ScriptPath", join(runDir, "elevated.ps1"), "-WorkDir", process.cwd()],
  { cwd: process.cwd(), detached: true, stdio: "ignore" },
);
child.unref();
console.log(`launcher spawned (detached) pid=${child.pid} — click YES on the prompt`);

const deadline = Date.now() + 90_000;
let last = "";
while (Date.now() < deadline) {
  const files = ["launch.txt", "pid.txt", "done.txt"].filter((f) => existsSync(join(runDir, f)));
  const line = files.join(",") || "(none)";
  if (line !== last) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] mailboxes: ${line}`);
    last = line;
  }
  if (existsSync(join(runDir, "done.txt"))) break;
  await new Promise((r) => setTimeout(r, 250));
}

const read = (f) => (existsSync(join(runDir, f)) ? readFileSync(join(runDir, f), "utf8").trim() : "<missing>");
console.log("launch.txt:", read("launch.txt"));
console.log("pid.txt   :", read("pid.txt"));
console.log("result.txt:", read("result.txt"));
console.log("stdout.txt:", read("stdout.txt"));
console.log("stderr.txt:", read("stderr.txt"));

// Is the launcher still alive after it should have finished?
try {
  const out = execFileSync("tasklist", ["/FI", `PID eq ${child.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  console.log("launcher alive:", !out.includes("No tasks"));
} catch {
  console.log("launcher alive: (tasklist failed)");
}

const ok = existsSync(join(runDir, "done.txt"));
console.log(ok ? "VERDICT: completed" : "VERDICT: no completion file");
if (ok) rmSync(runDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
