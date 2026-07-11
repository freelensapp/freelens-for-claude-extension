/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../claude/permission-broker";
import { describeApproval } from "./approval";
import { type CliDeps, type ExecFileFn, ProcessRegistry } from "./cli-exec";
import { type HelmToolConfig, runHelm } from "./helm";
import { LOG_BYTE_CAP } from "./kube-format";
import type { ExecFileException } from "node:child_process";

import type { SessionEvent } from "../../common/protocol";

/** A captured child invocation, filled in by the fake execFile. */
interface Capture {
  file: string;
  args: readonly string[];
}

/** Build a fake execFile that records the call and completes with the given result. */
function fakeExec(
  capture: Capture,
  result: { error?: ExecFileException | null; stdout?: string; stderr?: string } = {},
): ExecFileFn {
  return (file, args, _options, callback) => {
    capture.file = file;
    capture.args = args;
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { kill: () => true };
  };
}

function makeConfig(execFile: ExecFileFn, deps: Partial<CliDeps> = {}): HelmToolConfig {
  return {
    kubeConfigPath: "/home/user/.kube/config",
    contextName: "prod",
    registry: new ProcessRegistry(),
    deps: {
      env: { PATH: "/usr/bin" },
      resourcesPath: "/resources",
      arch: "x64",
      platform: "linux",
      fileExists: () => false,
      listDir: () => [],
      getKubectlPath: () => undefined,
      getUserDataPath: () => undefined,
      execFile,
      ...deps,
    },
  };
}

describe("runHelm argv validation", () => {
  const cfg = makeConfig(fakeExec({ file: "", args: [] }));

  it("rejects an empty args array", async () => {
    await expect(runHelm(cfg, { args: [] })).rejects.toThrow(/non-empty/);
  });

  it("rejects a newline-injecting argument", async () => {
    await expect(runHelm(cfg, { args: ["list", "prod\nrm -rf /"] })).rejects.toThrow(/NUL or newline/);
  });

  it("rejects the --kubeconfig, --context and --kube-context flags, bare or =-joined", async () => {
    await expect(runHelm(cfg, { args: ["list", "--kubeconfig", "/x"] })).rejects.toThrow(/--kubeconfig/);
    await expect(runHelm(cfg, { args: ["list", "--kubeconfig=/x"] })).rejects.toThrow(/--kubeconfig/);
    await expect(runHelm(cfg, { args: ["list", "--context", "other"] })).rejects.toThrow(/--context/);
    await expect(runHelm(cfg, { args: ["list", "--kube-context", "other"] })).rejects.toThrow(/--kube-context/);
    await expect(runHelm(cfg, { args: ["list", "--kube-context=other"] })).rejects.toThrow(/--kube-context/);
  });
});

describe("runHelm execution", () => {
  it("appends the cluster-targeting flags and resolves the bare binary", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture, { stdout: "NAME" }));
    const out = await runHelm(cfg, { args: ["list", "-A"] });
    expect(capture.file).toBe("helm");
    expect(capture.args).toEqual(["list", "-A", "--kubeconfig", "/home/user/.kube/config", "--kube-context", "prod"]);
    expect(out).toContain("[exit code 0]");
  });

  it("omits --kube-context when the cluster has no context name", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture));
    cfg.contextName = undefined;
    await runHelm(cfg, { args: ["list"] });
    expect(capture.args).not.toContain("--kube-context");
  });

  it("resolves the bundled helm binary when present, ignoring the kubectl preference", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture), {
      getKubectlPath: () => "/opt/kubectl",
      fileExists: (path) => path === "/resources/x64/helm",
    });
    await runHelm(cfg, { args: ["version"] });
    expect(capture.file).toBe("/resources/x64/helm");
  });

  it("reports the exit code and truncates oversized output", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture, { stdout: "z".repeat(LOG_BYTE_CAP + 5000) }));
    const out = await runHelm(cfg, { args: ["list"] });
    expect(out).toContain("truncated");
    expect(out).toContain("[exit code 0]");
  });

  it("surfaces a non-zero exit code with stderr", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(
      fakeExec(capture, { error: { code: 1, message: "exit 1" } as ExecFileException, stderr: "release not found" }),
    );
    const out = await runHelm(cfg, { args: ["status", "nope"] });
    expect(out).toContain("release not found");
    expect(out).toContain("[exit code 1]");
  });

  it("returns an error line instead of throwing on a spawn failure", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(
      fakeExec(capture, {
        error: { code: "ENOENT", message: "spawn helm ENOENT" } as unknown as ExecFileException,
      }),
    );
    const out = await runHelm(cfg, { args: ["list"] });
    expect(out).toBe("Failed to run helm: spawn helm ENOENT");
  });
});

describe("describeApproval for freelens_helm", () => {
  it("uses a RUN HELM title and the shell-quoted command line as the proposal", () => {
    const descriptor = describeApproval("freelens_helm", { args: ["upgrade", "web", "./chart", "--set", "tag=1 2"] });
    expect(descriptor.actionTitle).toBe("RUN HELM");
    expect(descriptor.proposedValue).toBe("helm upgrade web ./chart --set 'tag=1 2'");
  });
});

describe("broker gating for freelens_helm", () => {
  function makeBroker() {
    const events: SessionEvent[] = [];
    let counter = 0;
    const broker = new PermissionBroker(
      (event) => events.push(event),
      async () => undefined,
      () => `req-${++counter}`,
    );
    return { broker, events };
  }

  const input = { args: ["uninstall", "web"] };

  it("denies in readOnly mode without a request", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("readOnly");
    const decision = await broker.decideMutating("freelens_helm", input);
    expect(decision.behavior).toBe("deny");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("prompts in approve mode with a RUN HELM title", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating("freelens_helm", input);
    await Promise.resolve();
    const request = events.find((e) => e.type === "permission_request") as Extract<
      SessionEvent,
      { type: "permission_request" }
    >;
    expect(request.data.actionTitle).toContain("RUN HELM");
    broker.resolve(request.data.requestId, "allow");
    expect(await decision).toEqual({ behavior: "allow" });
  });

  it("auto-approves in acceptAll mode", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("acceptAll");
    const decision = await broker.decideMutating("freelens_helm", input);
    expect(decision).toEqual({ behavior: "allow" });
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  });
});
