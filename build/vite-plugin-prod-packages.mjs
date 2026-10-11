/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Records which npm packages are inlined into the bundles in dist/ and writes
// them to prod-packages.json as a { "<name>@<version>": "<pnpm-store-path>" }
// map.
//
// This extension declares no runtime `dependencies`: everything ships
// pre-bundled in dist/, and every package is a devDependency. So "what runs on
// a user's machine" cannot be derived from package.json - it is exactly the set
// of node_modules modules the bundler pulled in. The security scans
// (main-scan.yaml, release-scan.yaml) use this file as the runtime closure: the
// SBOM covers the whole workspace (dev tools included), and this narrows it to
// the packages that actually ship, so build-only findings (typescript, vitest,
// vite, ...) drop out.
//
// `pnpm build` builds the two entries in two separate Vite processes, so the
// list is the union across them, kept in the file itself: the run that empties
// dist/ (the renderer run, which comes first) starts the list, and a run that
// leaves dist/ in place (the main run) adds its packages to the list the
// earlier run wrote. The list therefore describes what dist/ holds.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Matches a pnpm-virtual-store module id and captures the store directory, e.g.
// .../node_modules/.pnpm/@kubernetes+client-node@2.0.0_foo@1.0.0/node_modules/@kubernetes/client-node/dist/x.js
// -> dir = "@kubernetes+client-node@2.0.0_foo@1.0.0". Handles both slash
// styles so it works regardless of the host OS.
const pnpmModule = /[/\\]node_modules[/\\]\.pnpm[/\\]([^/\\]+)[/\\]node_modules[/\\]/;

/**
 * @param {Map<string, string>} packages
 * @param {string} id
 */
function record(packages, id) {
  const match = pnpmModule.exec(id);
  if (!match) return;
  const dir = match[1];
  // Store dir is "<name>@<version>[_<peer>...]"; drop the peer suffix, then
  // split off the version at the last "@" (scoped names start with "@"), and
  // decode pnpm's scope separator ("@scope+name" -> "@scope/name").
  const base = dir.split("_")[0];
  const at = base.lastIndexOf("@");
  if (at <= 0) return;
  const name = base.slice(0, at).replace(/\+/g, "/");
  const version = base.slice(at + 1);
  if (!version) return;
  packages.set(`${name}@${version}`, `node_modules/.pnpm/${dir}/node_modules/${name}`);
}

/**
 * The list an earlier run wrote, or an empty one.
 *
 * @param {string} path
 * @returns {Map<string, string>}
 */
function readList(path) {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    return new Map();
  }
}

/**
 * @param {string} [outFile] Path (relative to the project root) to write.
 * @returns {import("vite").Plugin}
 */
export function prodPackages(outFile = "prod-packages.json") {
  /** @type {import("vite").ResolvedConfig} */
  let config;

  return {
    name: "freelens:prod-packages",
    apply: "build",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    writeBundle(_options, bundle) {
      const path = resolve(config.root, outFile);
      const packages = config.build.emptyOutDir ? new Map() : readList(path);
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules ?? {})) record(packages, id);
      }
      const sorted = Object.fromEntries([...packages].sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
    },
  };
}
