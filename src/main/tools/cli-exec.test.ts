/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CliChild,
  type ExecFileFn,
  formatCliResult,
  KILL_GRACE_MS,
  type PreparedCli,
  ProcessRegistry,
  quoteCommand,
  runCli,
} from "./cli-exec";
import { LOG_BYTE_CAP } from "./kube-format";
import type { ExecFileException } from "node:child_process";

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
  const prepared: PreparedCli = {
    binary: "/opt/kubectl",
    env: { KUBECONFIG: "/tmp/kubeconfig-c1", PATH: "/usr/bin" },
    problems: [],
  };

  it("passes the prepared environment as it is and captures the result", async () => {
    let captured: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const execFileFn: ExecFileFn = (file, args, options, callback) => {
      captured = { file, args, env: options.env };
      queueMicrotask(() => callback(null, "ok", ""));
      return { kill: () => true };
    };
    const registry = new ProcessRegistry();
    const result = await runCli({
      prepared,
      label: "kubectl",
      args: ["get", "pods"],
      timeoutMs: 1000,
      generation: registry.generation,
      execFile: execFileFn,
      registry,
    });
    expect(result).toBe("ok\n\n[exit code 0]");
    expect(captured?.file).toBe("/opt/kubectl");
    expect(captured?.args).toEqual(["get", "pods"]);
    expect(captured?.env).toEqual({ KUBECONFIG: "/tmp/kubeconfig-c1", PATH: "/usr/bin" });
    // The child is untracked again once it completes.
    expect(registry.size).toBe(0);
  });

  it("puts the problems of the preparation before the output", async () => {
    const execFileFn: ExecFileFn = (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "ok", ""));
      return { kill: () => true };
    };
    const registry = new ProcessRegistry();
    const result = await runCli({
      prepared: { ...prepared, problems: ["first problem", "second problem"] },
      label: "kubectl",
      args: ["version"],
      timeoutMs: 1000,
      generation: registry.generation,
      execFile: execFileFn,
      registry,
    });
    expect(result).toBe("[Freelens: first problem]\n\n[Freelens: second problem]\n\nok\n\n[exit code 0]");
  });

  it("starts nothing once the registry has killed its children since the generation was read", async () => {
    const execFileFn = vi.fn<ExecFileFn>();
    const registry = new ProcessRegistry();
    const generation = registry.generation;
    registry.killAll();
    const result = await runCli({
      prepared,
      label: "helm",
      args: ["uninstall", "web"],
      timeoutMs: 1000,
      generation,
      execFile: execFileFn,
      registry,
    });
    expect(result).toBe("[helm was not started: the turn was interrupted while it was being prepared]");
    expect(execFileFn).not.toHaveBeenCalled();
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

  it("counts every call in the generation, with or without children", () => {
    const registry = new ProcessRegistry();
    expect(registry.generation).toBe(0);
    registry.killAll();
    registry.add({ kill: () => true });
    registry.killAll();
    expect(registry.generation).toBe(2);
  });
});
