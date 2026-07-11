/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CliChild,
  type CliDeps,
  cleanCliEnv,
  type ExecFileFn,
  formatCliResult,
  KILL_GRACE_MS,
  ProcessRegistry,
  quoteCommand,
  resolveHelmBinary,
  resolveKubectlBinary,
  runCli,
} from "./cli-exec";
import { LOG_BYTE_CAP } from "./kube-format";
import type { ExecFileException } from "node:child_process";

/** Build injectable deps with sensible defaults for a stubbed environment. */
function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: {},
    resourcesPath: "/resources",
    arch: "x64",
    platform: "linux",
    fileExists: () => false,
    listDir: () => [],
    getKubectlPath: () => undefined,
    getUserDataPath: () => undefined,
    execFile: (() => ({ kill: () => true })) as unknown as ExecFileFn,
    ...overrides,
  };
}

describe("binary resolution", () => {
  it("prefers the configured kubectl path when non-empty", () => {
    const deps = makeDeps({ getKubectlPath: () => "  /opt/kubectl  ", fileExists: () => true });
    expect(resolveKubectlBinary(deps)).toBe("/opt/kubectl");
  });

  it("falls back to the bundled kubectl when the preference is empty and the file exists", () => {
    const seen: string[] = [];
    const deps = makeDeps({
      getKubectlPath: () => "",
      fileExists: (path) => {
        seen.push(path);
        return true;
      },
    });
    expect(resolveKubectlBinary(deps)).toBe("/resources/x64/kubectl");
    expect(seen).toContain("/resources/x64/kubectl");
  });

  it("falls back to the bare kubectl name when nothing else resolves", () => {
    const deps = makeDeps({ getKubectlPath: () => undefined, fileExists: () => false });
    expect(resolveKubectlBinary(deps)).toBe("kubectl");
  });

  it("adds the .exe suffix to the bundled binary on Windows", () => {
    const deps = makeDeps({ platform: "win32", fileExists: (path) => path === "/resources/x64/kubectl.exe" });
    expect(resolveKubectlBinary(deps)).toBe("/resources/x64/kubectl.exe");
  });

  it("prefers a downloaded version-matched kubectl over the bundled binary", () => {
    const deps = makeDeps({
      getUserDataPath: () => "/data",
      listDir: (path) => (path === "/data/binaries/kubectl" ? ["1.29.5"] : []),
      fileExists: (path) => path === "/data/binaries/kubectl/1.29.5/kubectl" || path === "/resources/x64/kubectl",
    });
    expect(resolveKubectlBinary(deps, "v1.29.5")).toBe("/data/binaries/kubectl/1.29.5/kubectl");
  });

  it("matches the downloaded kubectl by major.minor and picks the highest patch", () => {
    const deps = makeDeps({
      getUserDataPath: () => "/data",
      listDir: (path) => (path === "/data/binaries/kubectl" ? ["1.29.1", "1.29.11", "1.30.0"] : []),
      fileExists: (path) => path.startsWith("/data/binaries/kubectl/"),
    });
    // Cluster reports v1.29.4+patch: the 1.29.x downloads match, 1.29.11 wins on patch, 1.30.0 is ignored.
    expect(resolveKubectlBinary(deps, "v1.29.4+patch")).toBe("/data/binaries/kubectl/1.29.11/kubectl");
  });

  it("adds the .exe suffix to the downloaded binary on Windows", () => {
    const deps = makeDeps({
      platform: "win32",
      getUserDataPath: () => "C:/data",
      listDir: () => ["1.31.0"],
      fileExists: (path) => path === "C:/data/binaries/kubectl/1.31.0/kubectl.exe",
    });
    expect(resolveKubectlBinary(deps, "1.31.2")).toBe("C:/data/binaries/kubectl/1.31.0/kubectl.exe");
  });

  it("falls back to the bundled kubectl when no downloaded version matches the cluster", () => {
    const deps = makeDeps({
      getUserDataPath: () => "/data",
      listDir: () => ["1.28.0", "1.30.0"],
      fileExists: (path) => path === "/resources/x64/kubectl",
    });
    expect(resolveKubectlBinary(deps, "v1.29.5")).toBe("/resources/x64/kubectl");
  });

  it("ignores a matched directory whose kubectl file is missing", () => {
    const deps = makeDeps({
      getUserDataPath: () => "/data",
      listDir: () => ["1.29.5"],
      // The version directory exists but the binary inside it does not; only the bundled file does.
      fileExists: (path) => path === "/resources/x64/kubectl",
    });
    expect(resolveKubectlBinary(deps, "v1.29.5")).toBe("/resources/x64/kubectl");
  });

  it("prefers the explicit kubectl preference over any downloaded version", () => {
    const deps = makeDeps({
      getKubectlPath: () => "/opt/kubectl",
      getUserDataPath: () => "/data",
      listDir: () => ["1.29.5"],
      fileExists: () => true,
    });
    expect(resolveKubectlBinary(deps, "v1.29.5")).toBe("/opt/kubectl");
  });

  it("resolves helm to the bundled binary or the bare name, ignoring the kubectl preference", () => {
    const bundled = makeDeps({
      getKubectlPath: () => "/opt/kubectl",
      fileExists: (path) => path === "/resources/x64/helm",
    });
    expect(resolveHelmBinary(bundled)).toBe("/resources/x64/helm");
    const bare = makeDeps({ getKubectlPath: () => "/opt/kubectl", fileExists: () => false });
    expect(resolveHelmBinary(bare)).toBe("helm");
  });
});

describe("cleanCliEnv", () => {
  it("removes every case-variant of KUBECONFIG and DEBUG, preserving everything else", () => {
    const cleaned = cleanCliEnv({
      KUBECONFIG: "/a",
      kubeconfig: "/b",
      Kubeconfig: "/c",
      KubeConfig: "/d",
      DEBUG: "1",
      debug: "2",
      Debug: "3",
      PATH: "/usr/bin",
      HOME: "/home/x",
      MY_TOKEN: "secret",
    });
    expect(cleaned).toEqual({ PATH: "/usr/bin", HOME: "/home/x", MY_TOKEN: "secret" });
  });

  it("does not mutate the source environment", () => {
    const source = { KUBECONFIG: "/a", PATH: "/usr/bin" };
    cleanCliEnv(source);
    expect(source.KUBECONFIG).toBe("/a");
  });
});

describe("quoteCommand", () => {
  it("leaves safe tokens bare and single-quotes tokens needing it", () => {
    expect(quoteCommand("kubectl", ["get", "pods", "-l", "app=web frontend"])).toBe(
      "kubectl get pods -l 'app=web frontend'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(quoteCommand("kubectl", ["-o", "jsonpath={'a'}"])).toBe("kubectl -o 'jsonpath={'\\''a'\\''}'");
  });
});

describe("formatCliResult", () => {
  it("reports the output and exit code 0 on success", () => {
    expect(formatCliResult("kubectl", null, "pod/web created", "")).toBe("pod/web created\n\n[exit code 0]");
  });

  it("includes stderr and the non-zero exit code on failure", () => {
    const error = { code: 1, message: "boom" } as ExecFileException;
    const out = formatCliResult("kubectl", error, "", "Error from server: not found");
    expect(out).toContain("Error from server: not found");
    expect(out).toContain("[exit code 1]");
  });

  it("reports a spawn failure as an error line, not an exit code", () => {
    const error = { code: "ENOENT", message: "spawn kubectl ENOENT" } as unknown as ExecFileException;
    expect(formatCliResult("kubectl", error, "", "")).toBe("Failed to run kubectl: spawn kubectl ENOENT");
  });

  it("reports a timeout/termination for a killed child", () => {
    const error = { killed: true, signal: "SIGTERM", message: "" } as ExecFileException;
    expect(formatCliResult("helm", error, "", "")).toContain("timed out or was terminated");
  });

  it("truncates oversized output through the byte cap", () => {
    const out = formatCliResult("kubectl", null, "y".repeat(LOG_BYTE_CAP + 5000), "");
    expect(out).toContain("truncated");
  });
});

describe("runCli", () => {
  it("passes a cleaned env and captures the result", async () => {
    let captured: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const execFileFn: ExecFileFn = (file, args, options, callback) => {
      captured = { file, args, env: options.env };
      queueMicrotask(() => callback(null, "ok", ""));
      return { kill: () => true };
    };
    const registry = new ProcessRegistry();
    const result = await runCli({
      binary: "/opt/kubectl",
      label: "kubectl",
      args: ["get", "pods"],
      timeoutMs: 1000,
      deps: makeDeps({ env: { KUBECONFIG: "/a", PATH: "/usr/bin" }, execFile: execFileFn }),
      registry,
    });
    expect(result).toBe("ok\n\n[exit code 0]");
    expect(captured?.file).toBe("/opt/kubectl");
    expect(captured?.env).toEqual({ PATH: "/usr/bin" });
    // The child is untracked again once it completes.
    expect(registry.size).toBe(0);
  });
});

describe("ProcessRegistry.killAll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("SIGTERMs each child immediately and SIGKILLs survivors after the grace period", () => {
    vi.useFakeTimers();
    const kill = vi.fn<CliChild["kill"]>(() => true);
    const child: CliChild = { kill };
    const registry = new ProcessRegistry();
    registry.add(child);

    registry.killAll();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    // The set is cleared immediately so new work is not caught by the SIGKILL.
    expect(registry.size).toBe(0);

    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there are no tracked children", () => {
    vi.useFakeTimers();
    const registry = new ProcessRegistry();
    expect(() => registry.killAll()).not.toThrow();
    vi.advanceTimersByTime(KILL_GRACE_MS);
  });
});
