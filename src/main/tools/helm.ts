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
  prepareHelm,
  runCli,
  validateCliArgs,
} from "./cli-exec";

// The `freelens_helm` escape-hatch tool: after approval, the helm the cluster
// terminal runs is spawned non-tty in the terminal's environment, whose
// `KUBECONFIG` reaches the cluster through the Freelens proxy, as every other
// tool does. The model supplies argv only — never a shell string — so pipes,
// redirects and chaining are structurally impossible and no shell is ever
// involved.

export const helmSchema = {
  args: z
    .array(z.string())
    .describe(
      'helm argv WITHOUT the leading "helm", e.g. ["list","-A"]. Provide argv tokens, never a shell string; ' +
        "the tool targets the current cluster, so --kubeconfig/--kube-context must not be set.",
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
export type HelmToolConfig = CliToolConfig;

/**
 * Validate the argv, refuse a disconnected cluster, get the cluster's helm and
 * environment from the host, and run it. The timeout starts once both are
 * ready. Returns the captured output plus exit code (or an error line) — never
 * throws past the tool's `guard` wrapper.
 */
export async function runHelm(config: HelmToolConfig, input: HelmInput): Promise<string> {
  validateCliArgs("helm", input.args);
  config.ensureConnected();
  const deps = config.deps ?? defaultCliDeps();
  const generation = config.registry.generation;
  const prepared = await prepareHelm(deps, config.clusterId);
  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
  return runCli({
    prepared,
    label: "helm",
    args: input.args,
    timeoutMs: timeoutSeconds * 1000,
    generation,
    execFile: deps.execFile,
    registry: config.registry,
  });
}
