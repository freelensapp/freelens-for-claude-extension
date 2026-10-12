/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, Main } from "@freelensapp/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "../claude/permission-broker";
import { describeApproval } from "./approval";
import { type ExecFileFn, type HostShell, ProcessRegistry } from "./cli-exec";
import { LOG_BYTE_CAP } from "./kube-format";
import { type KubectlToolConfig, runKubectl } from "./kubectl";
import type { ExecFileException } from "node:child_process";

import type { SessionEvent } from "../../common/protocol";

const KUBECTL = "/data/binaries/kubectl/1.37.0/kubectl";
const ENV = { PATH: "/data/binaries/kubectl/1.37.0:/usr/bin", KUBECONFIG: "/tmp/kubeconfig-c1" };

/** A captured child invocation, filled in by the fake execFile. */
interface Capture {
  file: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeout?: number;
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
    capture.timeout = options.timeout;
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { kill: () => true };
  };
}

/** A stand-in for `Main.Shell` that answers for any cluster. */
function fakeShell(overrides: Partial<HostShell> = {}): HostShell {
  return {
    getKubectlPath: async () => KUBECTL,
    getHelmPath: async () => "/resources/x64/helm",
    getEnvironment: async () => ENV,
    ...overrides,
  };
}

function makeConfig(execFile: ExecFileFn, shell: HostShell = fakeShell()): KubectlToolConfig {
  return {
    clusterId: "c1",
    ensureConnected: () => {},
    registry: new ProcessRegistry(),
    deps: { shell, execFile },
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
  afterEach(() => {
    vi.mocked(Common.logger.info).mockClear();
    vi.mocked(Common.logger.warn).mockClear();
  });

  it("runs the cluster's kubectl in the cluster's environment with the model's argv only", async () => {
    const capture: Capture = { file: "", args: [] };
    const getKubectlPath = vi.fn<HostShell["getKubectlPath"]>(async () => KUBECTL);
    const getEnvironment = vi.fn<HostShell["getEnvironment"]>(async () => ENV);
    const cfg = makeConfig(fakeExec(capture, { stdout: "NAME" }), fakeShell({ getKubectlPath, getEnvironment }));
    const out = await runKubectl(cfg, { args: ["get", "pods"] });
    expect(getKubectlPath).toHaveBeenCalledWith("c1", expect.any(Object));
    expect(getEnvironment).toHaveBeenCalledWith("c1", expect.any(Object));
    expect(capture.file).toBe(KUBECTL);
    expect(capture.args).toEqual(["get", "pods"]);
    expect(capture.env).toEqual(ENV);
    expect(out).toBe("NAME\n\n[exit code 0]");
  });

  it("refuses a disconnected cluster before asking the host", async () => {
    const getKubectlPath = vi.fn<HostShell["getKubectlPath"]>(async () => KUBECTL);
    const cfg = makeConfig(fakeExec({ file: "", args: [] }), fakeShell({ getKubectlPath }));
    cfg.ensureConnected = () => {
      throw new Error('Cluster "kind-kind" is not connected in Freelens. Connect to it in Freelens and try again.');
    };
    await expect(runKubectl(cfg, { args: ["get", "pods"] })).rejects.toThrow(
      'Cluster "kind-kind" is not connected in Freelens.',
    );
    expect(getKubectlPath).not.toHaveBeenCalled();
  });

  it("passes on a rejection of the host and starts nothing", async () => {
    const execFile = vi.fn<ExecFileFn>();
    const message = "The bundled kubectl v1.35.3 is not usable, so kubectl v1.37.0 was not prepared";
    const cfg = makeConfig(
      execFile,
      fakeShell({
        getKubectlPath: async () => {
          throw new Error(message);
        },
      }),
    );
    await expect(runKubectl(cfg, { args: ["version"] })).rejects.toThrow(message);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("asks for kubectl and its environment together and reports their problem once, in the result", async () => {
    const problem = "Failed to download kubectl v1.37.0 (timeout) - using the bundled v1.35.3";
    let release!: () => void;
    const environmentAsked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(
      fakeExec(capture, { stdout: "Client Version: v1.35.3" }),
      fakeShell({
        // Resolves only once the environment has been asked for too, so the
        // test hangs if the two calls are made one after the other.
        getKubectlPath: async (_clusterId, options) => {
          options?.onProblem?.(problem);
          await environmentAsked;
          return "/resources/x64/kubectl";
        },
        getEnvironment: async (_clusterId, options) => {
          options?.onProblem?.(problem);
          release();
          return ENV;
        },
      }),
    );
    const out = await runKubectl(cfg, { args: ["version"] });
    expect(out).toBe(`[Freelens: ${problem}]\n\nClient Version: v1.35.3\n\n[exit code 0]`);
    expect(Common.logger.warn).toHaveBeenCalledTimes(1);
    expect(capture.file).toBe("/resources/x64/kubectl");
  });

  it("logs the download phases and progress without putting them in the result", async () => {
    const cfg = makeConfig(
      fakeExec({ file: "", args: [] }, { stdout: "ok" }),
      fakeShell({
        getKubectlPath: async (_clusterId, options) => {
          options?.onDownloadProgress?.({ transferred: 1024, total: 4096 });
          options?.onPhase?.("Verifying kubectl v1.37.0 ...");
          return KUBECTL;
        },
      }),
    );
    const out = await runKubectl(cfg, { args: ["version"] });
    expect(out).toBe("ok\n\n[exit code 0]");
    expect(Common.logger.info).toHaveBeenCalledWith("[for-claude] kubectl: downloading kubectl, 1024 of 4096 bytes");
    expect(Common.logger.info).toHaveBeenCalledWith("[for-claude] kubectl: Verifying kubectl v1.37.0 ...");
  });

  it("gives the child the requested timeout, starting once kubectl is ready", async () => {
    const capture: Capture = { file: "", args: [] };
    const cfg = makeConfig(fakeExec(capture));
    await runKubectl(cfg, { args: ["get", "pods"], timeoutSeconds: 30 });
    expect(capture.timeout).toBe(30_000);
  });

  it("starts nothing when the turn is interrupted while kubectl is prepared", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execFile = vi.fn<ExecFileFn>();
    const cfg = makeConfig(
      execFile,
      fakeShell({
        getKubectlPath: async () => {
          await ready;
          return KUBECTL;
        },
      }),
    );
    const run = runKubectl(cfg, { args: ["delete", "pod", "web"] });
    await Promise.resolve();
    cfg.registry.killAll();
    release();
    expect(await run).toBe("[kubectl was not started: the turn was interrupted while it was being prepared]");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("asks Main.Shell of the host by default", async () => {
    vi.mocked(Main.Shell.getKubectlPath).mockRejectedValueOnce(new Error('There is no cluster with the id "c1"'));
    const config: KubectlToolConfig = { clusterId: "c1", ensureConnected: () => {}, registry: new ProcessRegistry() };
    await expect(runKubectl(config, { args: ["version"] })).rejects.toThrow('There is no cluster with the id "c1"');
    expect(Main.Shell.getKubectlPath).toHaveBeenCalledWith("c1", expect.any(Object));
    expect(Main.Shell.getEnvironment).toHaveBeenCalledWith("c1", expect.any(Object));
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
        error: { code: "ENOENT", message: `spawn ${KUBECTL} ENOENT` } as unknown as ExecFileException,
      }),
    );
    const out = await runKubectl(cfg, { args: ["get", "pods"] });
    expect(out).toBe(`Failed to run kubectl: spawn ${KUBECTL} ENOENT`);
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
