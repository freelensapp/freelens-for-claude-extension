/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCliDeps, loadHostUserDataPath } from "./cli-exec";

// `electron` is the host's main-process module. Outside Electron it resolves to
// the npm package, so it is mocked here; `getPath` decides what the host
// reports, or throws as it would without an Electron app.
const getPath = vi.hoisted(() => vi.fn<(name: string) => string>());

vi.mock("electron", () => ({ app: { getPath } }));

describe("loadHostUserDataPath", () => {
  beforeEach(() => {
    getPath.mockReset();
  });

  it("gives the default deps Electron's userData directory", async () => {
    getPath.mockReturnValue("/home/user/.config/Freelens");

    await loadHostUserDataPath();

    expect(getPath).toHaveBeenCalledWith("userData");
    expect(defaultCliDeps().getUserDataPath()).toBe("/home/user/.config/Freelens");
  });

  it("leaves the directory unknown when Electron cannot report it", async () => {
    getPath.mockReturnValue("/home/user/.config/Freelens");
    await loadHostUserDataPath();
    getPath.mockImplementation(() => {
      throw new Error("no app");
    });

    await expect(loadHostUserDataPath()).resolves.toBeUndefined();

    expect(defaultCliDeps().getUserDataPath()).toBeUndefined();
  });
});
