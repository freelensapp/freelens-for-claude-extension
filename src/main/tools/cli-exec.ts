/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Common } from "@freelensapp/extensions";
import { LOG_BYTE_CAP, truncateBytes } from "./kube-format";
import type { ExecFileException } from "node:child_process";

// Shared spawn helper for the `freelens_kubectl` and `freelens_helm` tools,
// mirroring how Freelens itself runs the binaries (`resource-applier` and
// `exec-helm`): an explicit `--kubeconfig` flag rather than the env var, a clean
// environment, non-tty capture, and a truncated result that is returned to the
// model rather than thrown. Every side-effecting seam (child process,
// filesystem, preference lookup, process metadata) is injectable so tests never
// spawn a real process or touch the real filesystem.

/** Max bytes buffered from a child before it errors; comfortably above the truncation cap. */
export const CLI_MAX_BUFFER = 8 * 1024 * 1024;

/** Grace period after SIGTERM before a lingering child is SIGKILL-ed. */
export const KILL_GRACE_MS = 2000;

/** Default per-call timeout for a CLI tool, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/** Upper bound on a CLI tool's per-call timeout, in seconds. */
export const MAX_TIMEOUT_SECONDS = 600;

/** Clamp a requested timeout to the allowed range, defaulting when absent/invalid. */
export function clampTimeoutSeconds(seconds: number | undefined): number {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.floor(seconds), MAX_TIMEOUT_SECONDS);
}

/** Cluster-targeting flags the tool injects itself, which the model must not set. */
const REJECTED_FLAGS = new Set(["--kubeconfig", "--context", "--kube-context"]);

/**
 * Validate a CLI tool's argv: non-empty, every element a string free of NUL and
 * newline characters, and none of the cluster-targeting flags (bare or
 * `=`-joined) the tool injects itself. Throws a readable error on any violation
 * (the tool's `guard` wrapper turns it into an explanatory result).
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

/** Injectable dependencies for binary resolution and execution. */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  /** `process.resourcesPath` (the Electron resources dir holding bundled binaries). */
  resourcesPath: string;
  /** `process.arch` (the bundled binaries live in a per-arch subdirectory). */
  arch: string;
  /** `process.platform` (adds the `.exe` suffix on Windows). */
  platform: NodeJS.Platform;
  /** Whether a path exists (stubbed in tests). */
  fileExists: (path: string) => boolean;
  /** Directory entry names at `path`, or `[]` when it cannot be read (stubbed in tests). */
  listDir: (path: string) => string[];
  /** The user's kubectl-path preference override, possibly empty/undefined. */
  getKubectlPath: () => string | undefined;
  /**
   * Freelens' per-user data directory (`app.getPath("userData")`), the root of
   * the `binaries/kubectl/<version>` download tree, or undefined when unknown.
   */
  getUserDataPath: () => string | undefined;
  /** The child-process seam. */
  execFile: ExecFileFn;
}

/**
 * Freelens' per-user data directory via Electron's `app.getPath("userData")`,
 * or undefined when it cannot be resolved. Electron is a host runtime module
 * (external, absent under vitest), so it is required lazily and every failure
 * is swallowed - callers simply fall back to the bundled binary.
 */
function hostUserDataPath(): string | undefined {
  try {
    const electron = require("electron") as { app?: { getPath?(name: string): string } };
    return electron.app?.getPath?.("userData");
  } catch {
    return undefined;
  }
}

/** Directory entry names at `path`, or `[]` when it does not exist / cannot be read. */
function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Real dependencies wired to the host process; only touched outside tests. */
export function defaultCliDeps(): CliDeps {
  return {
    env: process.env,
    resourcesPath: (process as unknown as { resourcesPath?: string }).resourcesPath ?? "",
    arch: process.arch,
    platform: process.platform,
    fileExists: (path) => existsSync(path),
    listDir: (path) => safeReadDir(path),
    getKubectlPath: () => Common.App.Preferences.getKubectlPath(),
    getUserDataPath: () => hostUserDataPath(),
    execFile: execFile as unknown as ExecFileFn,
  };
}

/** The bundled `<resources>/<arch>/<name>[.exe]` path for a binary. */
function bundledBinaryPath(deps: CliDeps, name: string): string {
  const file = deps.platform === "win32" ? `${name}.exe` : name;
  return join(deps.resourcesPath, deps.arch, file);
}

/** The numeric `[major, minor, patch]` of a version string like `v1.29.5+build`, or undefined. */
function parseVersionParts(version: string): [number, number, number] | undefined {
  const match = /^\D*(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * Locate an already-downloaded, version-matched kubectl under Freelens' binaries
 * tree (`<userData>/binaries/kubectl/<version>/kubectl[.exe]`). Freelens
 * downloads a kubectl whose minor version tracks the cluster's to avoid
 * "version skew" warnings; this reuses that binary when its major.minor matches
 * `clusterVersion`, preferring the highest patch. Returns undefined when the
 * userData path is unknown, no matching version has been downloaded, or the
 * binary file is missing. Never throws or downloads anything itself.
 */
export function findDownloadedKubectl(deps: CliDeps, clusterVersion: string): string | undefined {
  const userData = deps.getUserDataPath()?.trim();
  if (!userData) return undefined;
  const target = parseVersionParts(clusterVersion);
  if (!target) return undefined;
  const [major, minor] = target;
  const dir = join(userData, "binaries", "kubectl");
  const file = deps.platform === "win32" ? "kubectl.exe" : "kubectl";
  const matches = deps
    .listDir(dir)
    .map((name) => ({ name, parts: parseVersionParts(name) }))
    .filter((entry): entry is { name: string; parts: [number, number, number] } => {
      return entry.parts != null && entry.parts[0] === major && entry.parts[1] === minor;
    })
    .sort((a, b) => b.parts[2] - a.parts[2]);
  for (const match of matches) {
    const candidate = join(dir, match.name, file);
    if (deps.fileExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the kubectl binary: the user preference when set, else the version-
 * matched binary Freelens already downloaded for `clusterVersion` when present,
 * else the bundled binary, else the bare `kubectl` name from `PATH`. Preferring
 * the downloaded binary over the (newest) bundled one keeps kubectl's client
 * version aligned with the cluster and avoids version-skew warnings.
 */
export function resolveKubectlBinary(deps: CliDeps, clusterVersion?: string): string {
  const preference = deps.getKubectlPath()?.trim();
  if (preference) return preference;
  if (clusterVersion) {
    const downloaded = findDownloadedKubectl(deps, clusterVersion);
    if (downloaded) return downloaded;
  }
  const bundled = bundledBinaryPath(deps, "kubectl");
  if (deps.fileExists(bundled)) return bundled;
  return "kubectl";
}

/**
 * Resolve the helm binary: the bundled binary when present, else the bare `helm`
 * name from `PATH`. No preference is exposed to extensions.
 */
export function resolveHelmBinary(deps: CliDeps): string {
  const bundled = bundledBinaryPath(deps, "helm");
  if (deps.fileExists(bundled)) return bundled;
  return "helm";
}

/**
 * A clean copy of the environment for a CLI child: every case-variant of
 * `KUBECONFIG` and `DEBUG` is dropped (mirroring Freelens' `clear-kube-env-vars`)
 * so only the explicit `--kubeconfig` flag targets the cluster.
 */
export function cleanCliEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower === "kubeconfig" || lower === "debug") delete env[key];
  }
  return env;
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
   * Signal every tracked child with SIGTERM, then SIGKILL any survivor after a
   * short grace period. Clears the set immediately so new work is not caught by
   * the pending SIGKILL.
   */
  killAll(graceMs: number = KILL_GRACE_MS): void {
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
 * Spawn a CLI binary non-tty with a clean environment, tracking it in the given
 * registry for the session lifecycle and returning the formatted, truncated
 * result. Never throws: a non-zero exit or spawn failure comes back as text.
 */
export function runCli(params: {
  binary: string;
  label: string;
  args: string[];
  timeoutMs: number;
  deps: CliDeps;
  registry: ProcessRegistry;
}): Promise<string> {
  const { binary, label, args, timeoutMs, deps, registry } = params;
  const env = cleanCliEnv(deps.env);
  return new Promise<string>((resolve) => {
    let child: CliChild | undefined;
    const done = (error: ExecFileException | null, stdout: string, stderr: string): void => {
      if (child) registry.remove(child);
      resolve(formatCliResult(label, error, String(stdout ?? ""), String(stderr ?? "")));
    };
    child = deps.execFile(
      binary,
      args,
      { env, timeout: timeoutMs, maxBuffer: CLI_MAX_BUFFER, windowsHide: true, killSignal: "SIGTERM" },
      done,
    );
    registry.add(child);
  });
}
