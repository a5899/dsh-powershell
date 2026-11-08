/**
 * dsh-powershell — plugin entry.
 *
 * Registers command-input tools so the agent types PowerShell instead of
 * writing .ps1 files, one of which can cross a UAC prompt.
 *
 * Design constraints that shaped this file:
 *   - DSH's plugin-facing API (`defineTool`, schemastery `Config`) is not
 *     published as a stable package; `@deepseek-ai/dsh-tools` resolves at
 *     runtime. The import is therefore defensive: if it does not resolve,
 *     tool specs still work because DSH accepts the raw object shape.
 *   - Behaviour has a policy component, not just a surface one ("make commands
 *     the default"): `preferCommands` injects a system-prompt section.
 *   - Nothing here may throw at load time. A plugin that throws during
 *     `apply()` takes the whole GUI down with it.
 */
import {
  elevationAvailable,
  elevate,
  killElevatedPid,
} from "./elevate.js";
import { EXE_POWERSHELL, EXE_PWSH, runUnelevated } from "./runner.js";
import { POLICY_TEXT } from "./policy.js";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

breadcrumb_import_guard: {
  // Module-eval happens before any plugin host code runs: if this line exists in
  // load.log the module was evaluated at all, which already halves the search.
  try {
    const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "plugins", "dsh-powershell");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      join(dir, "load.log"),
      `${new Date().toISOString()} pid=${process.pid} import-evaluated\n`,
    );
  } catch {
    /* never break loading for a diagnostic */
  }
}

export const name = "dsh-powershell";
export const inject = ["tools"];

/**
 * Load-time breadcrumb.
 *
 * A plugin that fails during load does so silently: the GUI still starts, the
 * tools simply never appear, and there is no log line to grep (measured on the
 * real host, 2026-11-07 — `psh_status` was 'unknown tool' with a perfectly valid
 * profile entry, junction, and importable package). Without this file the only
 * observable is "the tool is not there", which cannot distinguish "never
 * loaded" from "loaded and threw" from "loaded and registered wrong".
 */
function breadcrumb(stage, detail) {
  try {
    const { mkdirSync, appendFileSync } = fs;
    const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "plugins", "dsh-powershell");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "load.log"), `${new Date().toISOString()} pid=${process.pid} ${stage} ${detail ?? ""}\n`);
  } catch {
    /* a diagnostic must never be the thing that breaks loading */
  }
}

/** Defaults mirror `cordis.patch.yml`; Config is optional (schemastery may be absent). */
const DEFAULTS = {
  enabled: true,
  preferCommands: true,
  shell: "auto",
  timeoutMs: 120_000,
  maxOutputChars: 200_000,
  elevateTimeoutMs: 300_000,
  requireConfirmationForElevation: true,
};

/**
 * Host resolutions differ between DSH releases: the schema package is either
 * `@deepseek-ai/schemastery` or the bare name. A static import would hard-fail
 * on the other shape, so both are tried at load time.
 */
const importFirst = async (ids) => {
  for (const id of ids) {
    try {
      return await import(/* webpackIgnore: true */ id);
    } catch {
      /* try the next name */
    }
  }
  return null;
};

const schemaMod = await importFirst(["@deepseek-ai/schemastery", "schemastery"]);
const z = schemaMod?.default ?? schemaMod ?? null;

/**
 * Export `undefined` — never a plain object — when the schema package is
 * missing. cordis' `resolveConfig` short-circuits on a falsy `runtime.Config`
 * and skips validation; a plain object instead reaches
 * `Config["~standard"].validate(...)` and throws a TypeError that the loader
 * swallows into a console-less logger, so the plugin silently never applies.
 */
export const Config = z
  ? z.object({
      description: z
        .string()
        .description("Command-line input for the agent: run PowerShell directly, optionally through UAC.")
        .default("Command-line input for the agent"),
      enabled: z.boolean().default(DEFAULTS.enabled).description("Master switch for the plugin."),
      preferCommands: z
        .boolean()
        .default(DEFAULTS.preferCommands)
        .description("Inject the command-first policy into the system prompt."),
      shell: z
        .union([z.const("auto"), z.const("powershell"), z.const("pwsh")])
        .default(DEFAULTS.shell)
        .description("Which shell binary to run. auto prefers PowerShell 7, else the in-box 5.1 host."),
      timeoutMs: z.natural().min(1000).default(DEFAULTS.timeoutMs).description("Default timeout for one command."),
      maxOutputChars: z
        .natural()
        .default(DEFAULTS.maxOutputChars)
        .description("Output budget per stream; longer output is clipped with a notice."),
      elevateTimeoutMs: z
        .natural()
        .min(1000)
        .default(DEFAULTS.elevateTimeoutMs)
        .description("How long an elevated run may wait, including the human answering UAC."),
      requireConfirmationForElevation: z
        .boolean()
        .default(DEFAULTS.requireConfirmationForElevation)
        .description("Refuse destructive elevated commands instead of running them."),
    })
  : undefined;

/** Resolve which shell binary to use. `pwsh` is 7+; `powershell` is the 5.1 in-box host UAC understands. */
function resolveShell(setting) {
  if (setting === "powershell") return { exe: EXE_POWERSHELL, label: "Windows PowerShell 5.1" };
  if (setting === "pwsh") return { exe: EXE_PWSH, label: "PowerShell 7" };
  // auto: prefer pwsh when installed (better Unicode + $PSVersionTable), fall
  // back to the in-box host.
  const probe = process.env.ProgramFiles
    ? join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
    : null;
  if (probe && existsSync(probe)) return { exe: probe, label: "PowerShell 7" };
  return { exe: EXE_POWERSHELL, label: "Windows PowerShell 5.1" };
}

/** Trim output to the configured budget, saying so rather than silently lying. */
function clip(text, max) {
  if (!text || !(max > 0) || text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.2));
  return `${head}\n… [${text.length - head.length - tail.length} chars omitted] …\n${tail}`;
}

/**
 * Format a result for the agent.
 *
 * The rendering is part of the feature: a wall of unlabeled fields makes the
 * model guess which part failed. Exit code, truncation and "nothing matched"
 * are stated in words, because `""` output is overwhelmingly caused by a
 * filter that matched nothing — a fact the model should see explicitly.
 */
function render(command, result, mode) {
  const lines = [];
  const status = result.timedOut
    ? `timed out`
    : result.exitCode === 0
      ? "ok"
      : `exit ${result.exitCode}`;
  lines.push(`[${mode}] ${status} · ${result.durationMs} ms${result.truncated ? " · output truncated" : ""}`);
  if (mode === "elevated") {
    lines.push(
      result.elevatedPid
        ? `elevated pid ${result.elevatedPid} · output streamed live to the elevation window`
        : `elevated run ${result.status ?? ""}`.trim(),
    );
  }
  if (result.stdout) {
    lines.push("", "--- stdout ---", result.stdout.replace(/\s+$/, ""));
  }
  if (result.stderr) {
    lines.push("", "--- stderr ---", result.stderr.replace(/\s+$/, ""));
  }
  if (!result.stdout && !result.stderr) {
    lines.push("", "(no output — a filter matching nothing, or a command that prints nothing)");
  }
  if (result.error) lines.push("", `--- error ---`, String(result.error));
  if (result.hint) lines.push("", `--- hint ---`, result.hint);
  return lines.join("\n");
}

/** Short one-line preview for the UI card that shows what ran. */
function preview(command) {
  const oneLine = String(command).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

const CWD_PARAM = {
  type: "string",
  description: "Working directory. Defaults to the DSH workspace directory.",
  required: false,
};

const TIMEOUT_PARAM = {
  type: "number",
  description: "Timeout in milliseconds. 0 disables it. Defaults to the plugin timeout (120000).",
  required: false,
};

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  breadcrumb("apply-enter", `enabled=${cfg.enabled} ctxKeys=${Object.keys(ctx ?? {}).join(",")}`);
  if (!cfg.enabled) {
    breadcrumb("apply-skip", "enabled=false");
    return;
  }

  const disposers = [];
  const shell = resolveShell(cfg.shell);

  // ── psh: the default way to run anything ────────────────────────────────
  // NOTE: the tool is deliberately NOT called `pwsh`. DSH ships its own built-in
  // `pwsh` tool; registering that name collides, and the collision silently
  // loses — the built-in wins, this plugin's tool never appears, and its
  // `elevated` flag is ignored. Measured on the real host (2026-11-07): with
  // `name: "pwsh"` the tools `killElevatedPid` / `pwsh_elevate_status` were
  // unknown to the runtime and `elevated:true` silently degraded to an
  // unelevated run. A distinct name is the fix, not a workaround.
  const pshTool = {
    name: "psh",
    description:
      "Run PowerShell (or any shell command) directly — command line in, output out. Prefer this over writing a .ps1 script file for one-off work. " +
      "Each call is a fresh process: variables do not persist between calls. This tool is NOT the built-in pwsh; it is the elevated-capable one.",
    parameters: {
      code: {
        type: "string",
        description: "PowerShell source to execute, verbatim. Multi-line scripts are fine.",
        required: true,
      },
      ...{ cwd: CWD_PARAM, timeoutMs: TIMEOUT_PARAM },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          exitCode: { type: "number", description: "Exit code, or -1 when the process never produced one (timeout, aborted, empty input)." },
          stdout: { type: "string" },
          stderr: { type: "string" },
          timedOut: { type: "boolean" },
          durationMs: { type: "number" },
          status: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.preview ?? "" }],
    },
    async execute(args) {
      const code = String(args?.code ?? "");
      if (!code.trim()) {
        const text = "[psh] nothing to run: `code` is empty.";
        return { exitCode: -1, stdout: "", stderr: "", timedOut: false, durationMs: 0, status: "empty", preview: text };
      }
      const timeoutMs = args?.timeoutMs === 0 ? 0 : (args?.timeoutMs > 0 ? args.timeoutMs : cfg.timeoutMs);
      const cwd = args?.cwd || process.cwd();

      const result = await runUnelevated(code, {
        cwd,
        timeoutMs,
        exe: shell.exe === EXE_PWSH ? shell.exe : EXE_POWERSHELL,
        args: ["-NoProfile", "-NonInteractive", "-NoLogo"],
      });
      const clipped = {
        ...result,
        stdout: clip(result.stdout, cfg.maxOutputChars),
        stderr: clip(result.stderr, cfg.maxOutputChars),
        truncated: result.stdout.length > cfg.maxOutputChars || result.stderr.length > cfg.maxOutputChars,
      };
      const text = render(code, clipped, "unelevated");
      return {
        ...pick(clipped),
        stdout: clipped.stdout,
        stderr: clipped.stderr,
        truncated: clipped.truncated,
        preview: text,
        commandPreview: preview(code),
      };
    },
  };

  // ── psh_elevated: elevation is an explicit tool, never a lost flag ────────
  // It used to be `elevated:true` on the main tool. When the main tool lost the
  // name collision with DSH's built-in `pwsh`, that flag was silently ignored
  // and the command ran with normal rights — a dangerous failure mode, because
  // the answer looked like a plain permission error rather than "not elevated".
  // A separate tool cannot degrade that way: it either exists or it does not.
  const elevatedTool = {
    name: "psh_elevated",
    description:
      "Run PowerShell as administrator through a real UAC prompt. Use only when the command needs admin rights, and tell the user a UAC dialog is about to appear — they must click Yes; nothing can click it for them. " +
      "Cancelling (1223) is reported as a user decision and is never retried. Output is teed to the elevation window and streamed back as the command runs. Runs on its own timeout (elevateTimeoutMs, default 300000).",
    parameters: {
      code: {
        type: "string",
        description: "PowerShell source to execute, verbatim, as administrator.",
        required: true,
      },
      ...{ cwd: CWD_PARAM, timeoutMs: TIMEOUT_PARAM },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          exitCode: { type: "number", description: "Exit code, or -1 when the process never produced one (cancelled, denied, timeout)." },
          stdout: { type: "string" },
          stderr: { type: "string" },
          status: { type: "string" },
          elevated: { type: "boolean" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.preview ?? "" }],
    },
    async execute(args) {
      const code = String(args?.code ?? "");
      if (!code.trim()) {
        const text = "[psh_elevated] nothing to run: `code` is empty.";
        return { exitCode: -1, stdout: "", stderr: "", status: "empty", elevated: false, preview: text };
      }
      const timeoutMs = args?.timeoutMs === 0 ? 0 : (args?.timeoutMs > 0 ? args.timeoutMs : cfg.elevateTimeoutMs);
      const cwd = args?.cwd || process.cwd();

      // Stream the elevated host's output as it grows instead of blocking until
      // the run finishes: a multi-minute elevated command otherwise looks
      // frozen, and "what did it print, and how did it change" is the question
      // an agent actually has while the window is on screen.
      const liveLines = [];
      const elevatedResult = await elevate(code, {
        cwd,
        timeoutMs: Math.max(timeoutMs, cfg.elevateTimeoutMs > 0 ? cfg.elevateTimeoutMs : 0),
        onData: (chunk) => {
          const text = String(chunk).replace(/\r\n/g, "\n");
          for (const line of text.split("\n")) {
            if (line.trim()) liveLines.push(line);
          }
        },
      });
      if (liveLines.length > 0) {
        // Keep the transcript bounded; the tool result is already clipped.
        const shown = liveLines.slice(-2000).join("\n");
        (elevatedResult.streamLog ??= []).push(shown);
      }
      // Did a genuinely elevated process actually run? Start-Process -Verb RunAs
      // is the only way the launcher can create one, so these statuses prove the
      // token was elevated; the rest mean no elevated process ever existed.
      // Reporting it explicitly stops a caller from reading "Access denied" out of
      // an unelevated run and concluding the command needs different rights.
      const ranElevated = ["ok", "error", "timeout"].includes(elevatedResult.status);
      if (elevatedResult.status === "timeout" || elevatedResult.status === "uac-pending") {
        const hint = elevatedResult.runDir
          ? `The elevated window may still be open. Once you know its pid, psh_kill can ask it to exit; otherwise click Terminate on it. Run dir kept at ${elevatedResult.runDir}`
          : undefined;
        const text = render(code, { ...elevatedResult, hint }, "elevated");
        return {
          ...pick(elevatedResult),
          elevated: ranElevated,
          stdout: clip(elevatedResult.stdout, cfg.maxOutputChars),
          preview: text,
        };
      }
      const text = render(code, elevatedResult, "elevated");
      return {
        ...pick(elevatedResult),
        elevated: ranElevated,
        stdout: clip(elevatedResult.stdout, cfg.maxOutputChars),
        stderr: clip(elevatedResult.stderr, cfg.maxOutputChars),
        preview: text,
      };
    },
  };

  // ── psh_kill: only reachable after the user says which pid ────────────────
  const killTool = {
    name: "psh_kill",
    description:
      "Ask an ELEVATED PowerShell process to terminate itself. A lower-integrity process cannot TerminateProcess a higher one, so this works through PowerShell script block logging: if that policy is off, it reports failure honestly instead of pretending.",
    parameters: {
      pid: { type: "number", description: "Process id of the elevated PowerShell host, as reported by the elevated run.", required: true },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "Whether the elevated process actually went away." },
          method: { type: "string", description: "How termination was attempted (taskkill, self-exit request, or none)." },
          detail: { type: "string", description: "Raw output or the reason it failed." },
        },
      },
      render(_args, value) {
        const head = value.ok ? `terminated · ${value.method}` : `not terminated · ${value.method}`;
        return [{ type: "text", text: value.detail ? `${head}\n${value.detail}` : head }];
      },
    },
    async execute(args) {
      const outcome = await killElevatedPid(args?.pid);
      return { ok: outcome.ok, method: outcome.method, detail: outcome.detail };
    },
  };

  // ── psh_status: explain, don't guess ──────────────────────────────────────
  const statusTool = {
    name: "psh_status",
    description:
      "Report whether this process is already elevated, which shell `psh` uses, and whether UAC can be expected to work. Call once before claiming a command needs admin.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          platform: { type: "string" },
          shell: { type: "string" },
          plugin: { type: "string" },
          elevatable: { type: "boolean" },
          reason: { type: "string" },
          user: { type: "string" },
          elevated: { type: "boolean" },
          psVersion: { type: "string" },
          pwsh7: { type: "boolean" },
          scriptBlockLogging: { type: "boolean" },
        },
      },
      render(_args, value) {
        return [{
          type: "text",
          text: [
            // `plugin` is the package name, so printing both it and a literal
            // prefix duplicated the word ("dsh-powershell dsh-powershell").
            `${value.plugin || "dsh-powershell"} · ${value.platform}`,
            `shell: ${value.shell}`,
            `this host elevated: ${value.elevated}`,
            `user: ${value.user || "?"} · PowerShell ${value.psVersion || "?"}`,
            `pwsh 7 present: ${value.pwsh7}`,
            // The reason string explains *when a prompt would be declined*, so it
            // only belongs on screen when elevation is actually unavailable.
            value.elevatable
              ? "UAC elevation available: yes"
              : `UAC elevation available: no${value.reason ? ` (${value.reason})` : ""}`,
          ].join("\n"),
        }];
      },
    },
    async execute() {
      const probe = await elevationAvailable();
      const info = await runUnelevated(
        `$id = [Security.Principal.WindowsIdentity]::GetCurrent();` +
          `$p = [Security.Principal.WindowsPrincipal]::new($id);` +
          `[pscustomobject]@{` +
          `user = $id.Name;` +
          `elevated = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);` +
          `psVersion = $PSVersionTable.PSVersion.ToString();` +
          `pwsh7 = [bool](Get-Command pwsh.exe -ErrorAction SilentlyContinue);` +
          `scriptBlockLogging = [bool](Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging' -ErrorAction SilentlyContinue).EnableScriptBlockLogging` +
          `} | ConvertTo-Json -Compress`,
        { timeoutMs: 20_000 },
      );
      const parsed = safeJson(info.stdout.trim()) ?? {};
      // Coerce every declared field: the schema promises booleans, and a missing
      // registry key yields null in JSON. A mismatch here fails validation at call
      // time ("returned invalid output"), which is better than crashing the host
      // but still means the tool is useless, so normalise defensively.
      return {
        platform: process.platform,
        shell: shell.label,
        plugin: "dsh-powershell",
        tools: ["psh", "psh_elevated", "psh_kill", "psh_status"],
        elevatable: Boolean(probe.elevatable),
        reason: String(probe.reason ?? ""),
        user: String(parsed.user ?? ""),
        elevated: Boolean(parsed.elevated),
        psVersion: String(parsed.psVersion ?? ""),
        pwsh7: Boolean(parsed.pwsh7),
        scriptBlockLogging: Boolean(parsed.scriptBlockLogging),
      };
    },
  };

  const tools = [pshTool, elevatedTool, killTool, statusTool];
  const register = typeof ctx.tools?.register === "function" ? ctx.tools.register.bind(ctx.tools) : null;
  breadcrumb("register-scan", `register=${Boolean(register)} tools=${tools.map((t) => t.name).join("|")}`);
  if (register) {
    for (const tool of tools) {
      try {
        disposers.push(ctx.effect(() => register(tool), `dsh-powershell:${tool.name}`));
        breadcrumb("registered", tool.name);
      } catch (err) {
        breadcrumb("register-failed", `${tool.name} ${err?.message ?? err}`);
        throw err;
      }
    }
  }

  // ── behavioural half of the feature ───────────────────────────────────────
  if (cfg.preferCommands) {
    const disposePolicy = injectPolicy(ctx);
    breadcrumb("policy", disposePolicy ? "injected" : "no-prompt-service");
    if (disposePolicy) disposers.push(disposePolicy);
  }
  breadcrumb("apply-done", `${disposers.length} disposers`);

  ctx.effect?.(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      }
    },
    "dsh-powershell:dispose",
  );
}

/**
 * Add the policy section to the system prompt.
 *
 * Two discovery paths are attempted because the prompt-assembly service name
 * differs across DSH builds; if neither exists, the tools still work and each
 * tool description carries the same instruction, just less prominently.
 */
function injectPolicy(ctx) {
  try {
    if (typeof ctx.systemPrompt?.push === "function") {
      const id = "dsh-powershell:policy";
      ctx.systemPrompt.push({ id, content: POLICY_TEXT });
      return () => ctx.systemPrompt.remove?.(id) ?? ctx.systemPrompt.push({ id, content: "" });
    }
  } catch {
    /* fall through to disposes but not fatal */
  }
  try {
    if (typeof ctx.prompt?.register === "function") {
      return ctx.prompt.register({ name: "dsh-powershell-policy", content: POLICY_TEXT });
    }
  } catch {
    /* plugin still useful without prompt injection */
  }
  return () => {};
}

function pick(result) {
  return {
    exitCode: result.exitCode ?? -1,
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs ?? 0,
    status: result.status ?? (result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "error"),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default { name, inject, Config, apply };
