/**
 * dsh-powershell — background job layer.
 *
 * Why this exists: DSH's tool contract is `execute(args, exec): Promise<unknown>`.
 * There is no incremental channel — `projectContent`/`finalizeContent` run once,
 * after the promise settles. So a long command inside `psh` is a black box: the
 * output is produced, sits in a Node stream, and only reaches the model when the
 * whole thing finishes (measured: 2.4 s of work → one blob 2.4 s later).
 *
 * The fix is not more streaming plumbing, it is a different shape: start the
 * command, return *immediately* with an id, and let the caller poll for whatever
 * has been written so far. Output goes to a file as it is produced, so the file
 * is the progress bar.
 *
 * Lifecycle rules that matter:
 *   - A job outlives the tool call that started it, but NOT the DSH process: the
 *     child is killed when the host exits (detached:false plus the pid sweep in
 *     `sweepOrphans`).
 *   - Output is capped. A command that prints forever must not fill the disk; on
 *     reaching `maxBytes` the child is killed and the job is marked
 *     `limit-exceeded`, so polling still returns what was captured.
 *   - Polls are cursor-based (`offset`), so nothing is delivered twice and nothing
 *     is lost if the caller polls slower than the command writes.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync, writeSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXE_POWERSHELL, encodeCommand, PRELUDE, removeStartupLatch } from "./runner.js";

/** Hard ceiling per job. Output past this is not captured; the job is stopped. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** How long a finished job stays pollable before it is evicted. */
const RETAIN_MS = 30 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

function jobsRoot() {
  const dir = join(tmpdir(), "dsh-powershell-jobs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read bytes [start, end) of a file. Returns "" when the file does not exist yet.
 * Reading by range instead of whole-file keeps a 200 MB log cheap to poll.
 */
function readRange(path, start, end) {
  const len = Math.max(0, end - start);
  if (len === 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Evict jobs that finished long ago so a long-lived DSH does not leak memory. */
function evictOld() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const done = job.finishedAt ?? 0;
    if (done && now - done > RETAIN_MS) jobs.delete(id);
  }
}

/**
 * Make a human-readable label out of a chunk of PowerShell.
 *
 * The first physical line is often just a pipeline header or an opening brace
 * (`1..4 | ForEach-Object {`), which tells a reader nothing. Skip the scaffolding
 * and take the first line that still names something.
 */
function describe(code) {
  const lines = String(code)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Comments and bare braces carry no meaning in a listing.
    .filter((l) => !l.startsWith("#") && !/^[{}()[\]]+$/.test(l));
  // Scaffolding: loop headers (`1..4 | ForEach-Object {`), bare block openers,
  // and format-expression log lines ("[{0:...}] tick {1}" -f ...). None of them
  // describe the job — they are the shape of the script, not its purpose.
  const isNoise = (l) =>
    /^[{}]/.test(l) ||
    /\{$/.test(l) ||
    /\|\s*ForEach-Object\s*\{?$/.test(l) ||
    /\s-f\s/.test(l);
  const pick = lines.find((l) => !isNoise(l)) ?? lines[0] ?? "(empty)";
  return pick.length > 80 ? `${pick.slice(0, 77)}...` : pick;
}

/**
 * Start a command in the background.
 *
 * @param {string} code PowerShell source
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs] 0 = no timeout (still bounded by maxBytes)
 * @param {number} [opts.maxBytes]
 * @param {string} [opts.label] human label shown in listings
 * @returns {{id: string, pid?: number, outPath: string}}
 */
export function startJob(code, opts = {}) {
  evictOld();
  removeStartupLatch();

  const id = `job-${randomUUID().slice(0, 8)}`;
  const dir = join(jobsRoot(), id);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "stdout.txt");
  const errPath = join(dir, "stderr.txt");

  // Same wrapper as runUnelevated, for the same reason: a trailing `exit N` must
  // be honoured, and the last foreign exit code must survive PowerShell 5.1's
  // habit of collapsing every nonzero $LASTEXITCODE to 1.
  const trailingExit = /\n\s*exit\b(\s+-?\d+)?\s*;?\s*$/i.exec(code);
  const body = trailingExit ? code.slice(0, trailingExit.index) : code;
  const codeStatement = trailingExit
    ? `\nexit ${(trailingExit[1] || "0").trim()}`
    : `\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
  const wrapped = `${PRELUDE}${body}${codeStatement}\n`;

  const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;

  const job = {
    id,
    // A first line of code is a poor label — `1..4 | ForEach-Object {` says
    // nothing about what the job is doing. Derive something readable instead.
    label: opts.label || describe(code),
    pid: null,
    outPath,
    errPath,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    killed: false,
    limitExceeded: false,
    maxBytes,
    cwd: opts.cwd || process.cwd(),
  };

  let child;
  try {
    child = spawn(opts.exe || EXE_POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encodeCommand(wrapped)],
      {
        cwd: job.cwd,
        windowsHide: true,
        env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        // Not detached: the child must die with DSH, not outlive it as an orphan
        // that keeps writing to a temp file nobody polls.
        detached: false,
      });
  } catch (error) {
    job.finishedAt = Date.now();
    job.exitCode = -1;
    job.spawnError = error.message;
    jobs.set(id, job);
    return { id, pid: null, outPath };
  }

  job.pid = child.pid ?? null;
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  let written = 0;

  const stop = (why) => {
    job.killed = true;
    job.stopReason = why;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  child.stdout?.on("data", (chunk) => {
    const room = maxBytes - written;
    if (room <= 0) {
      job.limitExceeded = true;
      stop("max-bytes");
      return;
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    try {
      writeSync(outFd, slice);
    } catch {
      /* disk full — the job will report a short read rather than crash */
    }
    written += slice.length;
    if (written >= maxBytes) {
      job.limitExceeded = true;
      stop("max-bytes");
    }
  });
  child.stderr?.on("data", (chunk) => {
    try {
      writeSync(errFd, chunk);
    } catch {
      /* see above */
    }
  });

  let timer = null;
  if (opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      job.timedOut = true;
      stop("timeout");
    }, opts.timeoutMs);
  }

  const finish = (code_, spawnError) => {
    if (timer) clearTimeout(timer);
    try {
      closeSync(outFd);
    } catch { /* already closed */ }
    try {
      closeSync(errFd);
    } catch { /* already closed */ }
    if (job.finishedAt) return;
    job.finishedAt = Date.now();
    job.exitCode = code_ ?? -1;
    if (spawnError) job.spawnError = spawnError;
  };

  child.on("error", (error) => finish(-1, error.message));
  child.on("close", (exitCode) => finish(exitCode));

  jobs.set(id, job);
  return { id, pid: job.pid, outPath };
}

/**
 * Read new output since `offset`.
 *
 * The returned `offset` is the cursor for the next call. When `stream` is
 * "stderr" the stderr file is read instead, with its own independent byte size.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {number} [opts.offset] byte offset to start at (default 0)
 * @param {string} [opts.stream] "stdout" (default) | "stderr"
 * @returns {object|null} null when the job is unknown
 */
export function pollJob(id, opts = {}) {
  const job = jobs.get(id);
  if (!job) return null;

  const useErr = opts.stream === "stderr";
  const path = useErr ? job.errPath : job.outPath;
  const total = sizeOf(path);
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  // A caller can pass an offset past the end (e.g. after truncation); clamp so
  // the next poll does not go backwards.
  const start = Math.min(offset, total);

  let chunk = readRange(path, start, total);
  let truncated = false;
  // A single poll should not dump a 200 MB log into the model's context. Cap it
  // and tell the caller where to resume — the cursor makes this lossless.
  const POLL_LIMIT = 64 * 1024;
  if (chunk.length > POLL_LIMIT) {
    // Cut on a line boundary so the returned text is not a broken half-line.
    let cut = chunk.lastIndexOf("\n", POLL_LIMIT);
    if (cut <= 0) cut = POLL_LIMIT;
    chunk = chunk.slice(0, cut + 1);
    truncated = true;
  }

  // PowerShell on Windows ends lines with CRLF. Left alone, every polled line
  // carries a trailing \r that shows up as a stray character in rendering and
  // breaks anything comparing lines. The cursor is computed BEFORE normalising,
  // so the byte offset still refers to the file on disk.
  const nextOffset = start + Buffer.byteLength(chunk, "utf8");
  chunk = chunk.replace(/\r\n/g, "\n");

  let elapsed;
  if (job.finishedAt) {
    elapsed = job.finishedAt - job.startedAt;
  } else {
    elapsed = Date.now() - job.startedAt;
  }

  return {
    id: job.id,
    label: job.label,
    pid: job.pid,
    done: Boolean(job.finishedAt),
    exitCode: job.exitCode,
    timedOut: job.timedOut,
    killed: job.killed,
    limitExceeded: job.limitExceeded,
    stopReason: job.stopReason ?? null,
    durationMs: elapsed,
    output: chunk,
    offset: nextOffset,
    total,
    stream: useErr ? "stderr" : "stdout",
    more: truncated || nextOffset < total,
    ...(job.spawnError ? { spawnError: job.spawnError } : {}),
  };
}

/** List live and recently finished jobs. */
export function listJobs() {
  evictOld();
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((job) => ({
      id: job.id,
      label: job.label,
      pid: job.pid,
      done: Boolean(job.finishedAt),
      exitCode: job.exitCode,
      timedOut: job.timedOut,
      limitExceeded: job.limitExceeded,
      durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      stdoutBytes: sizeOf(job.outPath),
      stderrBytes: sizeOf(job.errPath),
    }));
}

/**
 * Kill a job's process. Returns what happened rather than pretending success:
 * a job that already finished reports `already-done`, one that was never
 * spawned reports `no-process`.
 */
export function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.finishedAt) return { id, stopped: false, reason: "already-done", exitCode: job.exitCode };
  if (!job.pid) return { id, stopped: false, reason: "no-process" };
  job.killed = true;
  job.stopReason = "requested";
  try {
    process.kill(job.pid);
    return { id, stopped: true, reason: "killed", pid: job.pid };
  } catch (error) {
    return { id, stopped: false, reason: "kill-failed", error: error.message, pid: job.pid };
  }
}

/** Drop finished job records (and their directories are left for the OS temp cleaner). */
export function pruneJobs() {
  const before = jobs.size;
  for (const [id, job] of jobs) {
    if (job.finishedAt) jobs.delete(id);
  }
  return { removed: before - jobs.size, remaining: jobs.size };
}

/** Kill every live child. Called on plugin dispose so DSH exiting leaves no runners. */
export function killAllJobs() {
  const killed = [];
  for (const job of jobs.values()) {
    if (!job.finishedAt && job.pid) {
      try {
        process.kill(job.pid);
        killed.push(job.id);
      } catch {
        /* already gone */
      }
    }
  }
  return killed;
}
