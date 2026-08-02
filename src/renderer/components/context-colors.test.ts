/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { categoryColor } from "./context-colors";

describe("categoryColor", () => {
  it("prefers a usable SDK-provided color", () => {
    expect(categoryColor("Messages", "#9c1f1f", 0)).toBe("#9c1f1f");
    expect(categoryColor("Messages", "rgb(1, 2, 3)", 0)).toBe("rgb(1, 2, 3)");
  });

  it("falls back to the named palette when the SDK color is missing or invalid", () => {
    expect(categoryColor("System prompt", "", 0)).toBe("#d4a13a");
    expect(categoryColor("mcp tools", "not-a-color", 3)).toBe("#9b72cf");
  });

  it("cycles the fallback palette for unknown categories", () => {
    expect(categoryColor("Something new", "", 0)).toBe("#d4a13a");
    expect(categoryColor("Something new", "", 7)).toBe("#d4a13a");
    expect(categoryColor("Something new", "", 8)).toBe("#c9704b");
  });
});
