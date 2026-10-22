/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { isClusterFrameOrigin } from "./frame-origin";

describe("isClusterFrameOrigin", () => {
  it.each([
    "https://0123456789abcdef0123456789abcdef.renderer.freelens.app:40123",
    "https://cluster-a.renderer.freelens.app:9443",
    "https://cluster-a.renderer.freelens.app",
  ])("accepts the cluster frame %s", (origin) => {
    expect(isClusterFrameOrigin(origin)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "null",
    "https://renderer.freelens.app:9443",
    "http://cluster-a.renderer.freelens.app:9443",
    "https://a.b.renderer.freelens.app:9443",
    "https://cluster-a.renderer.freelens.app.evil.example",
    "https://cluster-a.renderer.freelens.app:9443/",
    "https://cluster-a.renderer-freelens.app:9443",
    "https://evil.example",
    "http://127.0.0.1:9443",
  ])("refuses %s", (origin) => {
    expect(isClusterFrameOrigin(origin)).toBe(false);
  });
});
