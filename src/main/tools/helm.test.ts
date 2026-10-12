/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, Main } from "@freelensapp/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "../claude/permission-broker";
import { describeApproval } from "./approval";
import { type ExecFileFn, type HostShell, ProcessRegistry } from "./cli-exec";
import { type HelmToolConfig, runHelm } from "./helm";
import { LOG_BYTE_CAP } from "./kube-format";
import type { ExecFileException } from "node:child_process";

import type { SessionEvent } from "../../common/protocol";

const HELM = "/opt/helm/bin/helm";
const ENV = { PATH: "/usr/bin:/resources/x64", KUBECONFIG: "/tmp/kubeconfig-c1" };

/** A captured child invocation, filled in by the fake execFile. */
interface Capture {
  file: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Build a fake execFile that records the call and completes with the given result. */
function fakeExec(
  capture: Capture,
  result: { error?: ExecFileException | null; stdout?: string; stderr?: string } = {},
): ExecFileFn {
  return (file, args, options, callback) => {
    capture.file = file;
    capture.args = args;
    capture.env = options.env;
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { kill: () => true };
  };
}

/** A stand-in for `Main.Shell` that answers for any cluster. */
function fakeShell(overrides: Partial<HostShell> = {}): HostShell {
  return {
    getKubectlPath: async () => "/resources/x64/kubectl",
    getHelmPath: async () => HELM,
    getEnvironment: async () => ENV,
    ...overrides,
  };
}

function makeConfig(execFile: ExecFileFn, shell: HostShell = fakeShell()): HelmToolConfig {
  return {
    clusterId: "c1",
    ensureConnected: () => {},
    registry: new ProcessRegistry(),
    deps: { shell, execFile },
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
  afterEach(() => {
    vi.mocked(Common.logger.warn).mockClear();
  });

  it("runs the cluster's helm in the cluster's environment with the model's argv only", async () => {
    const capture: Capture = { file: "", args: [] };
    const getHelmPath = vi.fn<HostShell["getHelmPath"]>(async () => HELM);
    const getEnvironment = vi.fn<HostShell["getEnvironment"]>(async () => ENV);
    const getKubectlPath = vi.fn<HostShell["getKubectlPath"]>(async () => "/resources/x64/kubectl");
    const cfg = makeConfig(
      fakeExec(capture, { stdout: "NAME" }),
      fakeShell({ getHelmPath, getEnvironment, getKubectlPath }),
    );
    const out = await runHelm(cfg, { args: ["list", "-A"] });
    expect(getHelmPath).toHaveBeenCalledWith("c1");
    expect(getEnvironment).toHaveBeenCalledWith("c1", expect.any(Object));
    expect(getKubectlPath).not.toHaveBeenCalled();
    expect(capture.file).toBe(HELM);
    expect(capture.args).toEqual(["list", "-A"]);
    expect(capture.env).toEqual(ENV);
    expect(out).toBe("NAME\n\n[exit code 0]");
  });

  it("refuses a disconnected cluster before asking the host", async () => {
    const getHelmPath = vi.fn<HostShell["getHelmPath"]>(async () => HELM);
    const cfg = makeConfig(fakeExec({ file: "", args: [] }), fakeShell({ getHelmPath }));
    cfg.ensureConnected = () => {
      throw new Error('Cluster "kind-kind" is not connected in Freelens. Connect to it in Freelens and try again.');
    };
    await expect(runHelm(cfg, { args: ["list"] })).rejects.toThrow('Cluster "kind-kind" is not connected in Freelens.');
    expect(getHelmPath).not.toHaveBeenCalled();
  });

  it("logs a kubectl problem of the environment without putting it in the helm result", async () => {
    const problem = "Failed to download kubectl v1.37.0 (timeout) - using the bundled v1.35.3";
    const cfg = makeConfig(
      fakeExec({ file: "", args: [] }, { stdout: "NAME" }),
      fakeShell({
        getEnvironment: async (_clusterId, options) => {
          options?.onProblem?.(problem);
          return ENV;
        },
      }),
    );
    const out = await runHelm(cfg, { args: ["list"] });
    expect(out).toBe("NAME\n\n[exit code 0]");
    expect(Common.logger.warn).toHaveBeenCalledWith(`[for-claude] helm: ${problem}`);
  });

  it("reports the kubectl problem of the environment for the call, still not in the result", async () => {
    const problem = "Failed to download kubectl v1.37.0 (timeout) - using the bundled v1.35.3";
    const log: unknown[][] = [];
    const cfg = makeConfig(
      fakeExec({ file: "", args: [] }, { stdout: "NAME" }),
      fakeShell({
        getEnvironment: async (_clusterId, options) => {
          options?.onPhase?.("Verifying kubectl v1.37.0 ...");
          options?.onProblem?.(problem);
          return ENV;
        },
      }),
    );
    cfg.preparations = {
      begin: (callId) => {
        log.push(["begin", callId]);
        return {
          phase: (message) => log.push(["phase", message]),
          progress: (progress) => log.push(["progress", progress]),
          problem: (message) => log.push(["problem", message]),
          done: () => log.push(["done"]),
          failed: (message) => log.push(["failed", message]),
        };
      },
    };
    const out = await runHelm(cfg, { args: ["list"] }, "toolu_1");
    expect(out).toBe("NAME\n\n[exit code 0]");
    expect(log).toEqual([
      ["begin", "toolu_1"],
      ["phase", "Verifying kubectl v1.37.0 ..."],
      ["problem", problem],
      ["done"],
    ]);
  });

  it("asks Main.Shell of the host by default", async () => {
    vi.mocked(Main.Shell.getHelmPath).mockRejectedValueOnce(new Error('The cluster "kind-kind" (c1) is not connected'));
    const config: HelmToolConfig = { clusterId: "c1", ensureConnected: () => {}, registry: new ProcessRegistry() };
    await expect(runHelm(config, { args: ["list"] })).rejects.toThrow('The cluster "kind-kind" (c1) is not connected');
    expect(Main.Shell.getHelmPath).toHaveBeenCalledWith("c1");
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
        error: { code: "ENOENT", message: `spawn ${HELM} ENOENT` } as unknown as ExecFileException,
      }),
    );
    const out = await runHelm(cfg, { args: ["list"] });
    expect(out).toBe(`Failed to run helm: spawn ${HELM} ENOENT`);
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
