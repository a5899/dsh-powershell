/**
 * End-to-end UAC smoke test. ASKS FOR A UAC CLICK — run it only with a human present.
 *
 *   node test/e2e-uac.mjs           # counts to 5 slowly, then prints DONE
 *   node test/e2e-uac.mjs --cancel  # same, but expect the caller to click No
 *
 * It exercises exactly what `pwsh { elevated: true }` does, including the live
 * output pump, so it proves three things at once that unit tests cannot:
 *   1. the launcher survives and the prompt actually appears;
 *   2. output arrives INCREMENTALLY (timestamps are recorded per chunk);
 *   3. the exit code crosses the ShellExecute boundary.
 */
import { elevate } from "../lib/elevate.js";

const expectCancel = process.argv.includes("--cancel");
const chunks = [];
const t0 = Date.now();

// Deliberately plain statements: no pipeline, no formatting objects. A run of
// this exact shape has failed (output complete, no result.txt/done.txt), so this
// test must reproduce the ordinary case before it can be trusted at all.
const code = `
Write-Output "tick 1 at $(Get-Date -Format HH:mm:ss.fff)"
Start-Sleep -Seconds 1
Write-Output "tick 2 at $(Get-Date -Format HH:mm:ss.fff)"
Start-Sleep -Seconds 1
Write-Output "tick 3 at $(Get-Date -Format HH:mm:ss.fff)"
Start-Sleep -Seconds 1
Write-Output "tick 4 at $(Get-Date -Format HH:mm:ss.fff)"
Start-Sleep -Seconds 1
Write-Output "tick 5 at $(Get-Date -Format HH:mm:ss.fff)"
Write-Output "proof: elevated=$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
exit 0
`;

console.log(expectCancel ? ">>> click NO on the UAC prompt now" : ">>> click YES on the UAC prompt now");

const result = await elevate(code, {
  timeoutMs: 180_000,
  onData: (chunk) => {
    chunks.push({ at: Date.now() - t0, text: chunk.replace(/\n+$/, "") });
    console.log(`  [+${String(Date.now() - t0).padStart(6)}ms] ${chunk.replace(/\n+$/, "").split("\n").join(" ⏎ ")}`);
  },
});

console.log("\n--- result ---");
console.log("status     :", result.status);
console.log("exitCode   :", result.exitCode);
console.log("elevatedPid:", result.elevatedPid ?? "<none>");
console.log("durationMs :", result.durationMs);
console.log("chunks     :", chunks.length);
console.log("runDir     :", result.runDir ?? "<cleaned>");

if (expectCancel) {
  const ok = result.status === "cancelled";
  console.log(ok ? "VERDICT: cancellation reported correctly" : `VERDICT: expected cancelled, got ${result.status}`);
  process.exit(ok ? 0 : 1);
}

const lines = (result.stdout || "").trim().split("\n").filter(Boolean);
const incremental = chunks.length >= 3 && chunks[chunks.length - 1].at - chunks[0].at > 1500;
const ok = result.status === "ok" && result.exitCode === 0 && lines.length >= 6 && /elevated=True/i.test(result.stdout) && incremental;
console.log(`\nlines=${lines.length} incrementalStream=${incremental}`);
console.log(ok ? "VERDICT: PASS (prompt worked, output streamed, exit code crossed)" : "VERDICT: FAIL");
process.exit(ok ? 0 : 1);
