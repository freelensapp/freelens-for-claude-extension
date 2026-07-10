/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Freelens host does not auto-load the extension's bundled stylesheet, so
// `styles.tsx` injects every component SCSS module by hand. A module that is
// not listed there compiles and builds fine but renders unstyled at runtime
// (e.g. a popover collapsing into normal flow). Guard against that drift.
describe("styles.tsx", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const source = readFileSync(fileURLToPath(new URL("./styles.tsx", import.meta.url)), "utf8");
  const modules = readdirSync(dir).filter((name) => name.endsWith(".module.scss"));

  it("injects every component SCSS module", () => {
    expect(modules.length).toBeGreaterThan(0);
    const missing = modules.filter((name) => !source.includes(`./${name}?inline`));
    expect(missing, `SCSS modules not injected by styles.tsx: ${missing.join(", ")}`).toEqual([]);
  });
});
