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
const problems = [];
for (const t of tools) {
  walk(t.parameters, `${t.name}.parameters`, bad);
  walk(t.output?.schema, `${t.name}.output`, bad);
  // 宿主还会检查 output 的形态：缺 schema 或 render 都会 register-failed。
  if (!t.output || typeof t.output !== "object") {
    problems.push(`${t.name}: missing output { schema, render }`);
  } else {
    if (!t.output.schema) problems.push(`${t.name}: output.schema is missing`);
    if (typeof t.output.render !== "function") problems.push(`${t.name}: output.render is not a function`);
  }
}

if (bad.length) {
  console.log("ARRAY TYPES FOUND:");
  for (const b of bad) console.log("  " + b);
}
if (problems.length) {
  console.log("OUTPUT DECLARATION PROBLEMS:");
  for (const p of problems) console.log("  " + p);
}
if (bad.length || problems.length) process.exit(1);
console.log("OK: every schema.type is a single string across", tools.length, "tools");
console.log("OK: every tool declares output.schema and output.render");

// ── 声明 vs 实际返回值 ───────────────────────────────────────────────────────
// 这一层的教训：psh_status 声明 scriptBlockLogging 是 boolean，但注册表键不存在时
// PowerShell 返回 null，调用期报 "returned invalid output: ... must be a boolean"。
// 只在本地跑「注册」是不够的，必须真的执行一遍再按 schema 校验。
// 只跑安全的两个工具：psh（普通命令）和 psh_status。psh_elevated 会弹 UAC，
// psh_kill 会碰真实进程，都不在自检里执行。
const typeOk = (value, node, path, out) => {
  if (!node || typeof node !== "object") return;
  const t = node.type;
  if (t === "boolean" && typeof value !== "boolean") out.push(`${path}: expected boolean, got ${JSON.stringify(value)}`);
  if (t === "number" && typeof value !== "number") out.push(`${path}: expected number, got ${JSON.stringify(value)}`);
  if (t === "string" && typeof value !== "string") out.push(`${path}: expected string, got ${JSON.stringify(value)}`);
  if (t === "array") {
    if (!Array.isArray(value)) out.push(`${path}: expected array, got ${JSON.stringify(value)}`);
    else if (node.items) value.forEach((v, i) => typeOk(v, node.items, `${path}[${i}]`, out));
    return;
  }
  if (t === "object" && node.properties && value && typeof value === "object") {
    for (const [k, sub] of Object.entries(node.properties)) typeOk(value[k], sub, `${path}.${k}`, out);
  }
};

const samples = {
  psh: { code: "Write-Output 'schema-check'" },
  psh_status: {},
};
const mismatches = [];
for (const t of tools) {
  const args = samples[t.name];
  if (!args) continue;
  try {
    const value = await t.execute(args);
    const out = [];
    typeOk(value, t.output.schema, t.name, out);
    if (out.length) mismatches.push(...out);
    else console.log(`OK: ${t.name} output matches its declared schema`);
  } catch (err) {
    mismatches.push(`${t.name}: threw ${err && err.message}`);
  }
}
if (mismatches.length) {
  console.log("OUTPUT DOES NOT MATCH SCHEMA:");
  for (const m of mismatches) console.log("  " + m);
  process.exit(1);
}
