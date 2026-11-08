// 用真实的 apply() + 假 ctx 注册工具，然后逐个 schema 扫描：
// DSH 宿主拒绝数组形式的 `type`（register-failed: must be a single type string）。
// 这个脚本让同类崩溃在本地就能抓到，而不用等 DSH 崩掉。
import * as mod from "../lib/index.js";

const tools = [];
const fakeCtx = {
  tools: { register: (t) => { tools.push(t); return () => {}; } },
  effect: (fn) => fn(),
  prompt: { register: () => () => {} },
  logger: { info() {}, warn() {}, error() {} },
};

const cfg = mod.default.Config["~standard"].validate({});
await mod.apply(fakeCtx, cfg);
console.log("registered:", tools.map((t) => t.name).join(", "));

const walk = (node, path, bad) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.type)) bad.push(`${path}.type = ${JSON.stringify(node.type)}`);
  for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, bad);
};

const bad = [];
for (const t of tools) {
  walk(t.parameters, `${t.name}.parameters`, bad);
  walk(t.output?.schema, `${t.name}.output`, bad);
}

if (bad.length) {
  console.log("ARRAY TYPES FOUND:");
  for (const b of bad) console.log("  " + b);
  process.exit(1);
}
console.log("OK: every schema.type is a single string across", tools.length, "tools");
