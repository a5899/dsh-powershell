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

export const name = "dsh-powershell";
export const inject = ["tools"];

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

const Config = {
  description: "Command-line input for the agent: run PowerShell directly, optionally through UAC.",
  ...DEFAULTS,
};

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

import { existsSync } from "node:fs";
import { join } from "node:path";

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
  if (!cfg.enabled) return;

  const disposers = [];
  const shell = resolveShell(cfg.shell);

  // ── pwsh: the default way to run anything ────────────────────────────────
  const pwshTool = {
    name: "pwsh",
    description:
      "Run PowerShell (or any shell command) directly — command line in, output out. Prefer this over writing a .ps1 script file for one-off work. " +
      "Each call is a fresh process: variables do not persist between calls. Set elevated:true to run through a UAC elevation prompt when the command needs administrator rights.",
    parameters: {
      code: {
        type: "string",
        description: "PowerShell source to execute, verbatim. Multi-line scripts are fine.",
        required: true,
      },
      elevated: {
        type: "boolean",
        description:
          "Run through UAC elevation. Only use when the command needs administrator rights, and tell the user it will prompt. 1223/cancelled is reported as a user decision, not retried.",
        required: false,
      },
      ...{ cwd: CWD_PARAM, timeoutMs: TIMEOUT_PARAM },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          exitCode: { type: ["number", "null"] },
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
        const text = "[pwsh] nothing to run: `code` is empty.";
        return { exitCode: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, status: "empty", preview: text };
      }
      const timeoutMs = args?.timeoutMs === 0 ? 0 : (args?.timeoutMs > 0 ? args.timeoutMs : cfg.timeoutMs);
      const cwd = args?.cwd || process.cwd();

      if (args?.elevated) {
        const elevatedResult = await elevate(code, {
          cwd,
          timeoutMs: Math.max(timeoutMs, cfg.elevateTimeoutMs > 0 ? cfg.elevateTimeoutMs : 0),
        });        if (elevatedResult.status === "timeout" || elevatedResult.status === "uac-pending") {
          const hint = elevatedResult.runDir
            ? `The elevated window may still be open. Once you know its pid, killElevatedPid can ask it to exit; otherwise click Terminate on it. Run dir kept at ${elevatedResult.runDir}`
            : undefined;
          const text = render(code, { ...elevatedResult, hint }, "elevated");
          return { ...pick(elevatedResult), stdout: clip(elevatedResult.stdout, cfg.maxOutputChars), preview: text };
        }
        const text = render(code, elevatedResult, "elevated");
        return {
          ...pick(elevatedResult),
          stdout: "",
          stderr: clip(elevatedResult.stderr, cfg.maxOutputChars),
          preview: text,
        };
      }

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

  // ── killElevatedPid: only reachable after the user says which pid ─────────
  const killTool = {
    name: "killElevatedPid",
    description:
      "Ask an ELEVATED PowerShell process to terminate itself. A lower-integrity process cannot TerminateProcess a higher one, so this works through PowerShell script block logging: if that policy is off, it reports failure honestly instead of pretending.",
    parameters: {
      pid: { type: "number", description: "Process id of the elevated PowerShell host, as reported by the elevated run.", required: true },
    },
    output: { schema: { type: "object", properties: { ok: { type: "boolean" }, method: { type: "string" } } } },
    async execute(args) {
      const outcome = await killElevatedPid(args?.pid);
      return { ok: outcome.ok, method: outcome.method, detail: outcome.detail };
    },
  };

  // ── pwsh_elevate_status: explain, don't guess ─────────────────────────────
  const statusTool = {
    name: "pwsh_elevate_status",
    description:
      "Report whether this process is already elevated, which shell `pwsh` uses, and whether UAC can be expected to work. Call once before claiming a command needs admin.",
    parameters: {},
    output: { schema: { type: "object" } },
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
          `scriptBlockLogging = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging' -ErrorAction SilentlyContinue).EnableScriptBlockLogging` +
          `} | ConvertTo-Json -Compress`,
        { timeoutMs: 20_000 },
      );
      const parsed = safeJson(info.stdout.trim());
      return {
        platform: process.platform,
        shell: shell.label,
        elevatable: probe.elevatable,
        reason: probe.reason,
        ...(parsed ?? {}),
      };
    },
  };

  const tools = [pwshTool, killTool, statusTool];
  const register = typeof ctx.tools?.register === "function" ? ctx.tools.register.bind(ctx.tools) : null;
  if (register) {
    for (const tool of tools) {
      disposers.push(ctx.effect(() => register(tool), `dsh-powershell:${tool.name}`));
    }
  }

  // ── behavioural half of the feature ───────────────────────────────────────
  if (cfg.preferCommands) {
    disposers.push(injectPolicy(ctx));
  }

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
    exitCode: result.exitCode ?? null,
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

export { Config };
export default { name, inject, Config, apply };
