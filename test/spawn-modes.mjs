/**
 * Same launcher, spawned by node in four shell configurations.
 *
 * Question: does a launcher spawned from node run AT ALL? Variant Z already
 * proved the identical script works when spawned from an interactive shell.
 * If every node variant stays dead, the problem is the spawn call or the
 * environment node passes — not Start-Process and not UAC.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dshps-spawn-"));
console.log(`dir = ${dir}`);
console.log(`inherit windowsHide from node: ${process.platform}`);

const launcher = `param([string]$Dir, [string]$Tag)
$log = Join-Path $Dir "trace-$Tag.txt"
"[{0}] alive pid={1} interactive={2}" -f (Get-Date -Format HH:mm:ss.fff), $PID, [Environment]::UserInteractive | Set-Content -LiteralPath $log -Encoding utf8
try { $p = Start-Process -FilePath 'notepad.exe' -Verb RunAs -PassThru -ErrorAction Stop; Add-Content -LiteralPath $log -Value "started pid=$($p.Id)" }
catch { Add-Content -LiteralPath $log -Value ("EXC " + $_.Exception.Message) }
`;
writeFileSync(join(dir, "launcher.ps1"), launcher, "utf8");

const variants = {
  // Exactly what the plugin does today.
  "hide+detach": { options: { windowsHide: true, detached: true, stdio: "ignore" } },
  // Detached only.
  "detach": { options: { detached: true, stdio: "ignore" } },
  // Nothing special.
  plain: { options: { stdio: "ignore" } },
  // Pipes held open (node keeps child alive; we kill it later).
  piped: { options: { stdio: ["ignore", "pipe", "pipe"] } },
  // Shell: true — goes through cmd.exe, different console creation.
  shell: { options: { stdio: "ignore", shell: true } },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    return !/No tasks/i.test(execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }));
  } catch {
    return null;
  }
};
const trace = (tag) => (existsSync(join(dir, `trace-${tag}.txt`)) ? readFileSync(join(dir, `trace-${tag}.txt`), "utf8").trim() : "<never ran>");

const spawned = [];
for (const [tag, { options }] of Object.entries(variants)) {
  const args = ["-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", join(dir, "launcher.ps1"), "-Dir", dir, "-Tag", tag];
  const child = spawn("powershell.exe", args, options);
  child.on("error", (e) => console.log(`${tag}: spawn error ${e.message}`));
  if (options.detached) child.unref();
  spawned.push({ tag, pid: child.pid, child });
}

await wait(1500);
console.log("\n-- 1.5s after spawn --");
for (const s of spawned) console.log(`${s.tag.padEnd(12)} pid=${s.pid} alive=${alive(s.pid)} trace="${trace(s.tag).split("\n")[0]}"`);

await wait(6000);
console.log("\n-- final (no prompts clicked) --");
for (const s of spawned) {
  console.log(`\n[${s.tag}] alive=${alive(s.pid)}\n${trace(s.tag)}`);
  if (alive(s.pid)) s.child.kill();
}
