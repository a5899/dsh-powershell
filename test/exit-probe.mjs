/**
 * Reproduce "output arrives, then the process dies before the mailbox closes"
 * WITHOUT UAC, using the exact real host script.
 *
 * ASKS FOR A UAC CLICK — run it only with a human present.
 *   node test/exit-probe.mjs sync     # foreground: the launcher waits for the host
 *   node test/exit-probe.mjs noconsole
 *
 * The failing run showed: stdout.txt complete, pid.txt present, then the process
 * gone with no result.txt/done.txt and no stderr. That is the signature of a
 * process being torn down while the pipeline is still closing — not of an
 * exception. `Start-Process -Verb RunAs` opens a console, and `-Wait` holds that
 * host inside its own launcher, so we can provoke the same race deliberately.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEVATED_SCRIPT } from "../lib/runner.js";

const mode = process.argv[2] || "sync";
const dir = mkdtempSync(join(tmpdir(), `dshps-exitprobe-${mode}-`));
writeFileSync(join(dir, "elevated.ps1"), ELEVATED_SCRIPT, "utf8");
writeFileSync(
  join(dir, "code.ps1"),
  `Write-Output "tick 1 at $(Get-Date -Format HH:mm:ss.fff)"\nStart-Sleep -Seconds 1\nWrite-Output "tick 2 at $(Get-Date -Format HH:mm:ss.fff)"\nWrite-Output "proof: elevated=$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"\nexit 0\n`,
  "utf8",
);

const exe = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const hostArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "elevated.ps1"), "-RunDir", dir, "-CodePath", join(dir, "code.ps1")];

let child;
if (mode === "sync") {
  child = spawn(exe, hostArgs, { stdio: "ignore" });
} else if (mode === "noconsole") {
  // windowsHide gives the host no console at all: formatted output cannot be
  // laid out for a width that does not exist.
  child = spawn(exe, ["-NonInteractive", ...hostArgs], { stdio: "ignore", windowsHide: true });
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  if (existsSync(join(dir, "done.txt"))) break;
  await new Promise((r) => setTimeout(r, 100));
}
const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: "<alive>", signal: null }), 5000))]);

const show = (f) => (existsSync(join(dir, f)) ? JSON.stringify(readFileSync(join(dir, f), "utf8")) : "<missing>");
console.log("dir     :", dir);
console.log("files   :", readdirSync(dir).join(", "));
console.log("exit    :", JSON.stringify(exit));
console.log("stdout  :", show("stdout.txt"));
console.log("stderr  :", show("stderr.txt"));
console.log("result  :", show("result.txt"));
console.log("done    :", show("done.txt"));
const closed = existsSync(join(dir, "result.txt")) && existsSync(join(dir, "done.txt"));
console.log(closed ? "VERDICT: mailbox closed cleanly" : "VERDICT: FAILED — reproduced the drop-out without UAC");
process.exit(closed ? 0 : 1);
