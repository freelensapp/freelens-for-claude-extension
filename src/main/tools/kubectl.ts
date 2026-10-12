/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";
import {
  type CliToolConfig,
  clampTimeoutSeconds,
  defaultCliDeps,
  MAX_TIMEOUT_SECONDS,
  prepareKubectl,
  runCli,
  validateCliArgs,
} from "./cli-exec";

// The `freelens_kubectl` escape-hatch tool: after approval, the kubectl the
// cluster terminal runs is spawned non-tty in the terminal's environment, whose
// `KUBECONFIG` reaches the cluster through the Freelens proxy, as every other
// tool does. The model supplies argv only — never a shell string — so pipes,
// redirects and chaining are structurally impossible and no shell is ever
// involved.

export const kubectlSchema = {
  args: z
    .array(z.string())
    .describe(
      'kubectl argv WITHOUT the leading "kubectl", e.g. ["get","pods","-A"]. Provide argv tokens, never a ' +
        "shell string; the tool targets the current cluster, so --kubeconfig/--context must not be set.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe("Timeout in seconds (default 120, max 600)."),
};

const kubectlInput = z.object(kubectlSchema);
export type KubectlInput = z.infer<typeof kubectlInput>;

/** Everything the kubectl tool needs to target a cluster and track its child. */
export type KubectlToolConfig = CliToolConfig;

/**
 * Validate the argv, refuse a disconnected cluster, get the cluster's kubectl
 * and environment from the host, and run it. The timeout starts once kubectl
 * is ready, after a download if there is one. Returns the captured output plus
 * exit code (or an error line) — never throws past the tool's `guard` wrapper.
 */
export async function runKubectl(config: KubectlToolConfig, input: KubectlInput): Promise<string> {
  validateCliArgs("kubectl", input.args);
  config.ensureConnected();
  const deps = config.deps ?? defaultCliDeps();
  const generation = config.registry.generation;
  const prepared = await prepareKubectl(deps, config.clusterId);
  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
  return runCli({
    prepared,
    label: "kubectl",
    args: input.args,
    timeoutMs: timeoutSeconds * 1000,
    generation,
    execFile: deps.execFile,
    registry: config.registry,
  });
}
