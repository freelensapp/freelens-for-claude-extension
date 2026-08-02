// Rolldown/Rollup plugin that records which npm packages were actually inlined
// into the production bundle (out/main + out/renderer) and writes them to
// prod-packages.json as a { "<name>@<version>": "<pnpm-store-path>" } map.
//
// This extension declares no runtime `dependencies`: everything ships
// pre-bundled in out/**, and every package is a devDependency. So "what runs on
// a user's machine" cannot be derived from package.json - it is exactly the set
// of node_modules modules the bundler pulled in. The security scans
// (main-scan.yaml, release-scan.yaml) use this file as the runtime closure: the
// SBOM covers the whole workspace (dev tools included), and this narrows it to
// the packages that actually ship, so build-only findings (typescript, vitest,
// electron-vite, ...) drop out.
//
// The map accumulates across the main and renderer builds - electron-vite runs
// both in the same process, so the module-scoped Map below is their union - and
// is rewritten after each build, the last write being the complete set.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const runtime = new Map();

// Matches a pnpm-virtual-store module id and captures the store directory, e.g.
// .../node_modules/.pnpm/@kubernetes+client-node@1.4.0_react@17.0.2/node_modules/@kubernetes/client-node/dist/x.js
// -> dir = "@kubernetes+client-node@1.4.0_react@17.0.2". Handles both slash
// styles so it works regardless of the host OS.
const PNPM_RE = /[/\\]node_modules[/\\]\.pnpm[/\\]([^/\\]+)[/\\]node_modules[/\\]/;

function record(id) {
  const m = PNPM_RE.exec(id);
  if (!m) return;
  const dir = m[1];
  // Store dir is "<name>@<version>[_<peer>...]"; drop the peer suffix, then
  // split off the version at the last "@" (scoped names start with "@"), and
  // decode pnpm's scope separator ("@scope+name" -> "@scope/name").
  const base = dir.split("_")[0];
  const at = base.lastIndexOf("@");
  if (at <= 0) return;
  const name = base.slice(0, at).replace(/\+/g, "/");
  const version = base.slice(at + 1);
  if (!version) return;
  runtime.set(`${name}@${version}`, `node_modules/.pnpm/${dir}/node_modules/${name}`);
}

/**
 * @param {string} [outFile] Path (relative to the project root) to write.
 * @returns {import("rollup").Plugin}
 */
export function prodPackages(outFile = "prod-packages.json") {
  return {
    name: "prod-packages",
    writeBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules ?? {})) record(id);
      }
      const sorted = Object.fromEntries([...runtime].sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(resolve(process.cwd(), outFile), `${JSON.stringify(sorted, null, 2)}\n`);
    },
  };
}
