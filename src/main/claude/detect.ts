/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Outcome of locating and validating the user's Claude Code installation. */
export interface DetectionResult {
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

/** How long to wait for `claude --version` before giving up. */
const VERSION_TIMEOUT_MS = 5000;

/**
 * Injectable seams so the search order can be unit tested without touching the
 * real filesystem, PATH, or child processes.
 */
export interface DetectDeps {
  env: NodeJS.ProcessEnv;
  /** Resolve to the file's absolute path if it exists and is executable. */
  isExecutable: (path: string) => Promise<boolean>;
  /** Run `claude --version`; resolve stdout or reject. */
  runVersion: (path: string) => Promise<string>;
}

const defaultIsExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultRunVersion = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync(path, ["--version"], {
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
};

function defaultDeps(): DetectDeps {
  return {
    env: process.env,
    isExecutable: defaultIsExecutable,
    runVersion: defaultRunVersion,
  };
}

/** Parse a semantic-ish version out of `claude --version` output. */
export function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}

const isWindows = process.platform === "win32";
const executableName = isWindows ? "claude.cmd" : "claude";

/**
 * Build the ordered list of candidate paths to probe:
 * 1. `CLAUDE_CODE_PATH` override,
 * 2. every `PATH` entry,
 * 3. well-known install locations.
 */
export function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const push = (path: string | undefined) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  push(env.CLAUDE_CODE_PATH);

  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    push(join(entry, executableName));
  }

  const home = homedir();
  const wellKnown = [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    join(home, ".npm-global", "bin", "claude"),
    join(home, ".pnpm", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const path of wellKnown) push(path);

  return candidates;
}

/**
 * Locate the user's Claude Code binary and read its version. Never throws;
 * failures are reported through the returned `DetectionResult`.
 */
export async function detectClaudeCode(overrides: Partial<DetectDeps> = {}): Promise<DetectionResult> {
  const deps = { ...defaultDeps(), ...overrides };

  const candidates = candidatePaths(deps.env);
  let firstFoundPath: string | undefined;

  for (const candidate of candidates) {
    if (!(await deps.isExecutable(candidate))) continue;
    firstFoundPath = firstFoundPath ?? candidate;
    try {
      const output = await deps.runVersion(candidate);
      return {
        found: true,
        path: candidate,
        version: parseVersion(output),
      };
    } catch {
      // The file exists but did not run; keep searching in case a later
      // candidate is a working install.
    }
  }

  if (firstFoundPath) {
    return {
      found: false,
      path: firstFoundPath,
      error: "Found a Claude Code binary but could not run `claude --version`.",
    };
  }

  return {
    found: false,
    error: "Claude Code was not found on PATH or in well-known install locations.",
  };
}
