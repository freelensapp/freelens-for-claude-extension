/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";
import {
  type CliDeps,
  clampTimeoutSeconds,
  defaultCliDeps,
  MAX_TIMEOUT_SECONDS,
  type ProcessRegistry,
  resolveKubectlBinary,
  runCli,
  validateCliArgs,
} from "./cli-exec";

// The `freelens_kubectl` escape-hatch tool: after approval, the bundled (or
// user-preference) kubectl is spawned non-tty against the same cluster
// kubeconfig and context every other tool uses. The model supplies argv only —
// never a shell string — so pipes, redirects and chaining are structurally
// impossible and no shell is ever involved.

export const kubectlSchema = {
  args: z
    .array(z.string())
    .describe(
      'kubectl argv WITHOUT the leading "kubectl", e.g. ["get","pods","-A"]. Provide argv tokens, never a ' +
        "shell string; --kubeconfig/--context are injected automatically and must not be set.",
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
export interface KubectlToolConfig {
  kubeConfigPath: string;
  contextName?: string;
  registry: ProcessRegistry;
  /** Injectable execution/resolution seams; defaults to the real host process. */
  deps?: CliDeps;
}

/**
 * Validate the argv, resolve the kubectl binary, append the cluster-targeting
 * flags, and run it. Returns the captured output plus exit code (or an error
 * line) — never throws past the tool's `guard` wrapper.
 */
export async function runKubectl(config: KubectlToolConfig, input: KubectlInput): Promise<string> {
  validateCliArgs("kubectl", input.args);
  const deps = config.deps ?? defaultCliDeps();
  const binary = resolveKubectlBinary(deps);
  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
  const args = [
    ...input.args,
    "--kubeconfig",
    config.kubeConfigPath,
    ...(config.contextName ? ["--context", config.contextName] : []),
  ];
  return runCli({ binary, label: "kubectl", args, timeoutMs: timeoutSeconds * 1000, deps, registry: config.registry });
}
