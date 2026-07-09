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
  resolveHelmBinary,
  runCli,
  validateCliArgs,
} from "./cli-exec";

// The `freelens_helm` escape-hatch tool: after approval, the bundled (or bare)
// helm is spawned non-tty against the same cluster kubeconfig and context every
// other tool uses. The model supplies argv only — never a shell string — so
// pipes, redirects and chaining are structurally impossible and no shell is ever
// involved.

export const helmSchema = {
  args: z
    .array(z.string())
    .describe(
      'helm argv WITHOUT the leading "helm", e.g. ["list","-A"]. Provide argv tokens, never a shell string; ' +
        "--kubeconfig/--kube-context are injected automatically and must not be set.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe("Timeout in seconds (default 120, max 600)."),
};

const helmInput = z.object(helmSchema);
export type HelmInput = z.infer<typeof helmInput>;

/** Everything the helm tool needs to target a cluster and track its child. */
export interface HelmToolConfig {
  kubeConfigPath: string;
  contextName?: string;
  registry: ProcessRegistry;
  /** Injectable execution/resolution seams; defaults to the real host process. */
  deps?: CliDeps;
}

/**
 * Validate the argv, resolve the helm binary, append the cluster-targeting
 * flags, and run it. Returns the captured output plus exit code (or an error
 * line) — never throws past the tool's `guard` wrapper.
 */
export async function runHelm(config: HelmToolConfig, input: HelmInput): Promise<string> {
  validateCliArgs("helm", input.args);
  const deps = config.deps ?? defaultCliDeps();
  const binary = resolveHelmBinary(deps);
  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
  const args = [
    ...input.args,
    "--kubeconfig",
    config.kubeConfigPath,
    ...(config.contextName ? ["--kube-context", config.contextName] : []),
  ];
  return runCli({ binary, label: "helm", args, timeoutMs: timeoutSeconds * 1000, deps, registry: config.registry });
}
