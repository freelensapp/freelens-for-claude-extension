/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { delimiter } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { candidatePaths, detectClaudeCode, parseVersion } from "./detect";

describe("parseVersion", () => {
  it("extracts a semantic version from CLI output", () => {
    expect(parseVersion("1.2.3 (Claude Code)")).toBe("1.2.3");
    expect(parseVersion("claude 0.3.204")).toBe("0.3.204");
    expect(parseVersion("2.0.0-beta.1")).toBe("2.0.0-beta.1");
  });

  it("returns undefined when no version is present", () => {
    expect(parseVersion("no version here")).toBeUndefined();
  });
});

describe("candidatePaths", () => {
  it("puts the CLAUDE_CODE_PATH override first", () => {
    const paths = candidatePaths({ CLAUDE_CODE_PATH: "/custom/claude", PATH: "/usr/bin" });
    expect(paths[0]).toBe("/custom/claude");
  });

  it("includes an entry per PATH directory", () => {
    const paths = candidatePaths({ PATH: ["/a", "/b"].join(delimiter) });
    expect(paths.some((p) => p.includes("/a"))).toBe(true);
    expect(paths.some((p) => p.includes("/b"))).toBe(true);
  });
});

describe("detectClaudeCode", () => {
  it("returns the first candidate that runs --version", async () => {
    const isExecutable = vi.fn(async (path: string) => path === "/custom/claude");
    const runVersion = vi.fn(async () => "1.5.0");

    const result = await detectClaudeCode({
      env: { CLAUDE_CODE_PATH: "/custom/claude", PATH: "" },
      isExecutable,
      runVersion,
    });

    expect(result).toEqual({ found: true, path: "/custom/claude", version: "1.5.0" });
    expect(runVersion).toHaveBeenCalledOnce();
  });

  it("reports not-found with an error when nothing is executable", async () => {
    const result = await detectClaudeCode({
      env: { PATH: "/usr/bin" },
      isExecutable: async () => false,
      runVersion: async () => "",
    });

    expect(result.found).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("keeps searching when a found binary fails to run", async () => {
    const isExecutable = vi.fn(async () => true);
    const runVersion = vi.fn(async (path: string) => {
      if (path === "/custom/claude") throw new Error("not runnable");
      return "3.0.0";
    });

    const result = await detectClaudeCode({
      env: { CLAUDE_CODE_PATH: "/custom/claude", PATH: "/usr/bin" },
      isExecutable,
      runVersion,
    });

    expect(result.found).toBe(true);
    expect(result.version).toBe("3.0.0");
  });
});
