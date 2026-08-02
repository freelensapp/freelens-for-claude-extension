/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { formatDuration, formatPromptTimestamp, toLocalIso } from "./format-timestamp";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration (non-compact)", () => {
  it("renders sub-minute durations as seconds", () => {
    expect(formatDuration(5 * SECOND, false)).toBe("5s");
  });

  it("renders minutes and seconds", () => {
    expect(formatDuration(3 * MINUTE + 20 * SECOND, false)).toBe("3m 20s");
  });

  it("renders hours and minutes like the Created field", () => {
    expect(formatDuration(16 * HOUR + 37 * MINUTE, false)).toBe("16h 37m");
  });

  it("renders days, hours, and minutes", () => {
    expect(formatDuration(2 * DAY + 3 * HOUR + 4 * MINUTE, false)).toBe("2d 3h 4m");
  });

  it("never renders a negative duration", () => {
    expect(formatDuration(-1000, false)).toBe("0s");
  });
});

describe("toLocalIso", () => {
  it("formats a UTC instant with a Z offset when the machine is on UTC", () => {
    // CI runs on UTC, so the local offset collapses to "Z".
    const iso = toLocalIso(new Date("2026-08-02T02:05:06Z"));
    expect(iso).toMatch(/^2026-08-02T\d{2}:05:06(Z|[+-]\d{2}:\d{2})$/);
  });
});

describe("formatPromptTimestamp", () => {
  it("combines the age and the local ISO timestamp", () => {
    const iso = "2026-08-02T02:05:06Z";
    const now = new Date(iso).getTime() + 16 * HOUR + 37 * MINUTE;
    expect(formatPromptTimestamp(iso, now)).toBe(`16h 37m ago (${toLocalIso(new Date(iso))})`);
  });

  it("returns the raw input for an unparseable timestamp", () => {
    expect(formatPromptTimestamp("not-a-date", 0)).toBe("not-a-date");
  });
});
