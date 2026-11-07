import { runUnelevated } from "../lib/runner.js";

const cases = [
  ["cmd5", "cmd /c exit 5"],
  ["cmd5+exit", "cmd /c exit 5\nexit 0"],
  ["exit3", "Write-Output 'a'\nexit 3"],
  ["ok", "Write-Output 'a'"],
];

for (const [label, code] of cases) {
  const r = await runUnelevated(code, { timeoutMs: 20_000 });
  console.log(label.padEnd(10), "exit=" + r.exitCode, "out=" + JSON.stringify(r.stdout.trim()));
}
