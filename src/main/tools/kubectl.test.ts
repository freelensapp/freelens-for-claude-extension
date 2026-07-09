/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../claude/permission-broker";
import { describeApproval } from "./approval";
import { type CliDeps, type ExecFileFn, ProcessRegistry } from "./cli-exec";
import { LOG_BYTE_CAP } from "./kube-format";
import { type KubectlToolConfig, runKubectl } from "./kubectl";
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

function makeConfig(execFile: ExecFileFn, deps: Partial<CliDeps> = {}): KubectlToolConfig {
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
      getKubectlPath: () => undefined,
      execFile,
      ...deps,
    },
  };
}

describe("runKubectl argv validation", () => {
  const cfg = makeConfig(fakeExec({ file: "", args: [] }));

  it("rejects an empty args array", async () => {
    await expect(runKubectl(cfg, { args: [] })).rejects.toThrow(/non-empty/);
  });

  it("rejects a newline-injecting argument", async () => {
    await expect(runKubectl(cfg, { args: ["get", "pods\nrm -rf /"] })).rejects.toThrow(/NUL or newline/);
  });

  it("rejects the --kubeconfig, --context and --kube-context flags, bare or =-joined", async () => {
    await expect(runKubectl(cfg, { args: ["get", "--kubeconfig", "/x"] })).rejects.toThrow(/--kubeconfig/);
    await expect(runKubectl(cfg, { args: ["get", "--kubeconfig=/x"] })).rejects.toThrow(/--kubeconfig/);
    await expect(runKubectl(cfg, { args: ["get", "--context", "other"] })).rejects.toThrow(/--context/);
    await expect(runKubectl(cfg, { args: ["get", "--context=other"] })).rejects.toThrow(/--context/);
    await expect(runKubectl(cfg, { args: ["get", "--kube-context=other"] })).rejects.toThrow(/--kube-context/);
  });
});

describe("runKubectl execution", () => {
  it("appends the cluster-targeting flags and resolves the bare binary", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture, { stdout: "NAME" }));
    const out = await runKubectl(cfg, { args: ["get", "pods"] });
    expect(capture.file).toBe("kubectl");
    expect(capture.args).toEqual(["get", "pods", "--kubeconfig", "/home/user/.kube/config", "--context", "prod"]);
    expect(out).toContain("[exit code 0]");
  });

  it("omits --context when the cluster has no context name", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture));
    cfg.contextName = undefined;
    await runKubectl(cfg, { args: ["get", "pods"] });
    expect(capture.args).not.toContain("--context");
  });

  it("uses the configured kubectl-path preference when set", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture), { getKubectlPath: () => "/opt/kubectl" });
    await runKubectl(cfg, { args: ["version"] });
    expect(capture.file).toBe("/opt/kubectl");
  });

  it("reports the exit code and truncates oversized output", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture, { stdout: "z".repeat(LOG_BYTE_CAP + 5000) }));
    const out = await runKubectl(cfg, { args: ["get", "pods"] });
    expect(out).toContain("truncated");
    expect(out).toContain("[exit code 0]");
  });

  it("surfaces a non-zero exit code with stderr", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(
      fakeExec(capture, { error: { code: 1, message: "exit 1" } as ExecFileException, stderr: "not found" }),
    );
    const out = await runKubectl(cfg, { args: ["get", "nope"] });
    expect(out).toContain("not found");
    expect(out).toContain("[exit code 1]");
  });

  it("returns an error line instead of throwing on a spawn failure", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(
      fakeExec(capture, {
        error: { code: "ENOENT", message: "spawn kubectl ENOENT" } as unknown as ExecFileException,
      }),
    );
    const out = await runKubectl(cfg, { args: ["get", "pods"] });
    expect(out).toBe("Failed to run kubectl: spawn kubectl ENOENT");
  });
});

describe("describeApproval for freelens_kubectl", () => {
  it("uses a RUN KUBECTL title and the shell-quoted command line as the proposal", () => {
    const descriptor = describeApproval("freelens_kubectl", { args: ["get", "pods", "-l", "app=web x"] });
    expect(descriptor.actionTitle).toBe("RUN KUBECTL");
    expect(descriptor.proposedValue).toBe("kubectl get pods -l 'app=web x'");
  });
});

describe("broker gating for freelens_kubectl", () => {
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

  const input = { args: ["delete", "pod", "web"] };

  it("denies in readOnly mode without a request", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("readOnly");
    const decision = await broker.decideMutating("freelens_kubectl", input);
    expect(decision.behavior).toBe("deny");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("prompts in approve mode with a RUN KUBECTL title", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating("freelens_kubectl", input);
    await Promise.resolve();
    const request = events.find((e) => e.type === "permission_request") as Extract<
      SessionEvent,
      { type: "permission_request" }
    >;
    expect(request.data.actionTitle).toContain("RUN KUBECTL");
    broker.resolve(request.data.requestId, "allow");
    expect(await decision).toEqual({ behavior: "allow" });
  });

  it("auto-approves in acceptAll mode", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("acceptAll");
    const decision = await broker.decideMutating("freelens_kubectl", input);
    expect(decision).toEqual({ behavior: "allow" });
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  });
});
