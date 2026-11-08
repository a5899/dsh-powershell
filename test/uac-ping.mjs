/**
 * Minimal UAC ping: does the prompt still reach the screen at all?
 *
 * Fires Start-Process -Verb RunAs with a trivial payload that creates a marker
 * file. If the marker appears, elevation still works and the earlier timeouts
 * were about the user not seeing/clicking the prompt, not about the machinery.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "uac-ping-"));
const probe = join(dir, "pong.txt");
const command = `New-Item -ItemType File -Path '${probe}' -Force | Out-Null; 'pong'`;
const b64 = Buffer.from(command, "utf16le").toString("base64");

console.log("firing a minimal UAC ping — click YES if the prompt appears");
console.log(`marker will be: ${probe}`);

const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command",
    `Start-Process powershell -ArgumentList @('-NoProfile','-EncodedCommand','${b64}') -Verb RunAs -Wait`],
  { stdio: "ignore" },
);

const deadline = Date.now() + 100_000;
await new Promise((resolve) => {
  const tick = setInterval(() => {
    if (existsSync(probe)) {
      console.log("\napproved: the elevated command ran and created the marker");
      clearInterval(tick);
      resolve(undefined);
    } else if (Date.now() > deadline) {
      console.log("\ntimed out: no marker after 100s");
      clearInterval(tick);
      resolve(undefined);
    }
  }, 500);
});

try { child.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
