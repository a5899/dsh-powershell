/**
 * Does `exit N` inside the elevated host leave the mailbox complete?
 * ASKS FOR A UAC CLICK — run it only with a human present.
 *
 *   node test/exit-uac.mjs lib     # 1..5 over 5 s with Start-Sleep (the e2e shape)
 *   node test/exit-uac.mjs pass    # 1..5 pumped fast, whole run done in ~1 s
 *   node test/exit-uac.mjs noexit  # same as lib, but no trailing `exit 0`
 *
 * The point: prove the drop-out is about how the run ends (an `exit` statement
 * while a sleep is pending), not about output volume or the writer.
 */
import { elevate } from "../lib/elevate.js";

const mode = process.argv[2] || "lib";
const tick = (i) => `Write-Output "tick ${i} at $(Get-Date -Format HH:mm:ss.fff)"`;
const tail = `Write-Output "proof: elevated=$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"`;

const code =
  mode === "pass"
    ? [1, 2, 3, 4, 5].map(tick).join("\n") + "\n" + tail + "\nexit 0\n"
    : [1, 2, 3, 4, 5].map((i) => `${tick(i)}\nStart-Sleep -Seconds 1`).join("\n") +
      "\n" + tail + (mode === "noexit" ? "\n" : "\nexit 0\n");

const t0 = Date.now();
console.log(`>>> mode=${mode}: click YES on the UAC prompt now`);
const result = await elevate(code, {
  timeoutMs: 120_000,
  onData: (chunk) => console.log(`  [+${String(Date.now() - t0).padStart(6)}ms] ${chunk.trimEnd()}`),
});
const files = result.runDir ? (await import("node:fs")).readdirSync(result.runDir).sort() : [];
console.log("status:", result.status, "| exit:", result.exitCode, "| runDir:", result.runDir ?? "<cleaned>");
console.log("files :", files.join(" "));
process.exit(result.status === "ok" ? 0 : 1);
