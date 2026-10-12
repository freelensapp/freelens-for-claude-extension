/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { execFile } from "node:child_process";
import { Common, Main } from "@freelensapp/extensions";
import { LOG_BYTE_CAP, truncateBytes } from "./kube-format";
import type { ExecFileException } from "node:child_process";

// Shared spawn helper for the `freelens_kubectl` and `freelens_helm` tools. The
// binary and the environment come from `Main.Shell` of the host, for the
// session's cluster: the kubectl and helm the cluster terminal runs, with the
// user's preferences applied, and the terminal's environment, whose
// `KUBECONFIG` reaches the cluster through the Freelens proxy. The child runs
// non-tty, and its truncated result is returned to the model rather than
// thrown. The host API and the child process are injectable, so tests never
// spawn a real process.

/** Max bytes buffered from a child before it errors; comfortably above the truncation cap. */
export const CLI_MAX_BUFFER = 8 * 1024 * 1024;

/** Grace period after SIGTERM before a lingering child is SIGKILL-ed. */
export const KILL_GRACE_MS = 2000;

/** Default per-call timeout for a CLI tool, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/** Upper bound on a CLI tool's per-call timeout, in seconds. */
export const MAX_TIMEOUT_SECONDS = 600;

/** Interval between two log lines of a kubectl download's progress. */
const DOWNLOAD_LOG_INTERVAL_MS = 5000;

/** Clamp a requested timeout to the allowed range, defaulting when absent/invalid. */
export function clampTimeoutSeconds(seconds: number | undefined): number {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.floor(seconds), MAX_TIMEOUT_SECONDS);
}

/**
 * Cluster-targeting flags the model must not set: the environment's
 * `KUBECONFIG` targets the cluster, and these would point the child elsewhere.
 */
const REJECTED_FLAGS = new Set(["--kubeconfig", "--context", "--kube-context"]);

/**
 * Validate a CLI tool's argv: non-empty, every element a string free of NUL and
 * newline characters, and none of the cluster-targeting flags (bare or
 * `=`-joined). Throws a readable error on any violation (the tool's `guard`
 * wrapper turns it into an explanatory result).
 */
export function validateCliArgs(label: string, args: string[]): void {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error(`${label} requires a non-empty args array.`);
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error(`Every ${label} argument must be a string.`);
    }
    if (arg.includes("\0") || arg.includes("\n") || arg.includes("\r")) {
      throw new Error(`${label} arguments must not contain NUL or newline characters.`);
    }
    const flag = arg.split("=", 1)[0];
    if (REJECTED_FLAGS.has(flag)) {
      throw new Error(
        `The ${flag} flag is managed by Freelens and cannot be set here; the tool targets the current cluster automatically.`,
      );
    }
  }
}

/** The subset of a child process the registry needs: the ability to signal it. */
export interface CliChild {
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The `execFile` seam (callback form), so tests never spawn a real process. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
    windowsHide?: boolean;
    killSignal?: NodeJS.Signals;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => CliChild;

/** The functions of `Main.Shell` the tools call, always for a cluster. */
export interface HostShell {
  getKubectlPath(clusterId: string, options?: Main.Shell.KubectlDownloadOptions): Promise<string>;
  getHelmPath(clusterId: string): Promise<string>;
  getEnvironment(clusterId: string, options?: Main.Shell.KubectlDownloadOptions): Promise<Record<string, string>>;
}

/** Injectable dependencies for binary resolution and execution. */
export interface CliDeps {
  /** The host's binaries and environment (`Main.Shell`). */
  shell: HostShell;
  /** The child-process seam. */
  execFile: ExecFileFn;
}

/** Real dependencies wired to the host process; only touched outside tests. */
export function defaultCliDeps(): CliDeps {
  return {
    shell: Main.Shell,
    execFile: execFile as unknown as ExecFileFn,
  };
}

/** What a CLI tool needs to target its cluster and track its child. */
export interface CliToolConfig {
  clusterId: string;
  /**
   * Throw when the cluster is not connected in Freelens, with the message the
   * other tools refuse it with (`KubeClient.ensureConnected`).
   */
  ensureConnected: () => void;
  registry: ProcessRegistry;
  /** Injectable execution/resolution seams; defaults to the real host process. */
  deps?: CliDeps;
}

/** A binary to run, the environment to run it in, and the problems the host reported on the way. */
export interface PreparedCli {
  binary: string;
  env: Record<string, string>;
  /** Problems preparing the version-matched kubectl that the host went on from; for the tool result. */
  problems: string[];
}

/**
 * Download callbacks that log the phases and the progress, and collect the
 * problems. The kubectl and the environment are asked for together and both
 * report the same problem of their one preparation, so it is collected once.
 */
function downloadOptions(label: string, problems: Set<string>): Main.Shell.KubectlDownloadOptions {
  let lastProgressLog = 0;
  return {
    onPhase: (message) => Common.logger.info(`[for-claude] ${label}: ${message}`),
    onDownloadProgress: ({ transferred, total }) => {
      const now = Date.now();
      if (now - lastProgressLog < DOWNLOAD_LOG_INTERVAL_MS) return;
      lastProgressLog = now;
      const size = total ? ` of ${total}` : "";
      Common.logger.info(`[for-claude] ${label}: downloading kubectl, ${transferred}${size} bytes`);
    },
    onProblem: (message) => {
      if (problems.has(message)) return;
      problems.add(message);
      Common.logger.warn(`[for-claude] ${label}: ${message}`);
    },
  };
}

/**
 * The kubectl the cluster terminal runs and its environment, from the host.
 * Both are asked for at once, so that they wait for one preparation of the
 * version-matched kubectl, which may download it. Rejects as `Main.Shell` does:
 * for an unknown or a disconnected cluster, and when Freelens has no kubectl of
 * its own to run.
 */
export async function prepareKubectl(deps: CliDeps, clusterId: string): Promise<PreparedCli> {
  const problems = new Set<string>();
  const options = downloadOptions("kubectl", problems);
  const [binary, env] = await Promise.all([
    deps.shell.getKubectlPath(clusterId, options),
    deps.shell.getEnvironment(clusterId, options),
  ]);
  return { binary, env, problems: [...problems] };
}

/**
 * The helm the cluster terminal runs and its environment, from the host. The
 * environment prepares the cluster's kubectl too; its problems concern kubectl,
 * not helm, so they go to the log only.
 */
export async function prepareHelm(deps: CliDeps, clusterId: string): Promise<PreparedCli> {
  const [binary, env] = await Promise.all([
    deps.shell.getHelmPath(clusterId),
    deps.shell.getEnvironment(clusterId, downloadOptions("helm", new Set())),
  ]);
  return { binary, env, problems: [] };
}

/**
 * Reject shell-style single-quote wrapping for a token that needs it, so the
 * display command is copy-pasteable and unambiguous. Bare tokens made only of
 * safe characters are left unquoted for readability.
 */
function shellQuote(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/** The human-readable, shell-quoted command line for a binary and its argv. */
export function quoteCommand(binaryLabel: string, args: readonly string[]): string {
  return [binaryLabel, ...args].map(shellQuote).join(" ");
}

/** Tracks in-flight children so a session can kill them on interrupt/new-chat/dispose. */
export class ProcessRegistry {
  private readonly children = new Set<CliChild>();
  private killed = 0;

  add(child: CliChild): void {
    this.children.add(child);
  }

  remove(child: CliChild): void {
    this.children.delete(child);
  }

  /** Number of tracked children (for tests and diagnostics). */
  get size(): number {
    return this.children.size;
  }

  /**
   * The number of {@link killAll} calls so far. A tool reads it before it
   * waits for its binary, and starts no child when it has changed since: the
   * user interrupted the turn, or started a new chat, while kubectl was
   * downloading.
   */
  get generation(): number {
    return this.killed;
  }

  /**
   * Signal every tracked child with SIGTERM, then SIGKILL any survivor after a
   * short grace period. Clears the set immediately so new work is not caught by
   * the pending SIGKILL.
   */
  killAll(graceMs: number = KILL_GRACE_MS): void {
    this.killed++;
    const snapshot = [...this.children];
    this.children.clear();
    if (snapshot.length === 0) return;
    for (const child of snapshot) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may already have exited; ignore.
      }
    }
    const timer = setTimeout(() => {
      for (const child of snapshot) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone; ignore.
        }
      }
    }, graceMs);
    timer.unref?.();
  }
}

/**
 * Format a captured child result into the tool's text output: the combined
 * stdout/stderr (truncated to the byte cap) plus the exit code, or a readable
 * error line for a timeout or a spawn failure. Never throws.
 */
export function formatCliResult(
  binaryLabel: string,
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): string {
  const sections: string[] = [];
  const out = stdout.trimEnd();
  const err = stderr.trimEnd();
  if (out) sections.push(out);
  if (err) sections.push(err);
  // Truncate the captured output first so the trailing status line always
  // survives (it is the most useful part when output is large).
  const body = truncateBytes(sections.join("\n\n"), LOG_BYTE_CAP);

  if (!error) {
    return `${body || "(no output)"}\n\n[exit code 0]`;
  }
  if (error.killed) {
    const prefix = body ? `${body}\n\n` : "";
    return `${prefix}[${binaryLabel} timed out or was terminated before completing]`;
  }
  if (typeof error.code === "number") {
    return `${body || "(no output)"}\n\n[exit code ${error.code}]`;
  }
  return `Failed to run ${binaryLabel}: ${error.message}`;
}

/**
 * Spawn a prepared CLI binary non-tty in its environment, tracking it in the
 * given registry for the session lifecycle and returning the formatted,
 * truncated result, after the problems the host reported while preparing it.
 * Starts nothing when the registry has killed its children since `generation`
 * was read. Never throws: a non-zero exit or spawn failure comes back as text.
 */
export function runCli(params: {
  prepared: PreparedCli;
  label: string;
  args: string[];
  timeoutMs: number;
  generation: number;
  execFile: ExecFileFn;
  registry: ProcessRegistry;
}): Promise<string> {
  const { prepared, label, args, timeoutMs, generation, execFile: execFileFn, registry } = params;
  const notes = prepared.problems.map((problem) => `[Freelens: ${problem}]\n\n`).join("");
  if (registry.generation !== generation) {
    return Promise.resolve(`${notes}[${label} was not started: the turn was interrupted while it was being prepared]`);
  }
  return new Promise<string>((resolve) => {
    let child: CliChild | undefined;
    const done = (error: ExecFileException | null, stdout: string, stderr: string): void => {
      if (child) registry.remove(child);
      resolve(`${notes}${formatCliResult(label, error, String(stdout ?? ""), String(stderr ?? ""))}`);
    };
    child = execFileFn(
      prepared.binary,
      args,
      { env: prepared.env, timeout: timeoutMs, maxBuffer: CLI_MAX_BUFFER, windowsHide: true, killSignal: "SIGTERM" },
      done,
    );
    registry.add(child);
  });
}
