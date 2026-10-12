/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPersistedToolProgress, PROGRESS_EVENT_INTERVAL_MS, PreparationProgress } from "./preparation-progress";

import type { SessionEvent, SessionEventMap } from "../../common/protocol";

type ToolProgress = SessionEventMap["tool_progress"];

function setup() {
  const events: ToolProgress[] = [];
  const progress = new PreparationProgress((event: SessionEvent) => {
    if (event.type === "tool_progress") events.push(event.data);
  });
  return { events, progress };
}

describe("PreparationProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends nothing for a preparation that reports nothing", () => {
    const { events, progress } = setup();
    progress.begin("toolu_1").done();
    expect(events).toEqual([]);
  });

  it("sends each phase once, and done at the end", () => {
    const { events, progress } = setup();
    const report = progress.begin("toolu_1");
    report.phase("Verifying kubectl v1.37.0 ...");
    report.phase("Verifying kubectl v1.37.0 ...");
    report.done();
    expect(events).toEqual([
      { callId: "toolu_1", state: "preparing", phase: "Verifying kubectl v1.37.0 ..." },
      { callId: "toolu_1", state: "done" },
    ]);
  });

  it("sends the download progress at most every 250 ms, the latest value last", () => {
    const { events, progress } = setup();
    const report = progress.begin("toolu_1");
    report.progress({ transferred: 100, total: 1000 });
    // The second caller of the same download reports the same chunk.
    report.progress({ transferred: 100, total: 1000 });
    report.progress({ transferred: 200, total: 1000 });
    report.progress({ transferred: 300, total: 1000 });
    expect(events).toEqual([{ callId: "toolu_1", state: "preparing", transferred: 100, total: 1000 }]);
    vi.advanceTimersByTime(PROGRESS_EVENT_INTERVAL_MS);
    expect(events.at(-1)).toEqual({ callId: "toolu_1", state: "preparing", transferred: 300, total: 1000 });
    expect(events).toHaveLength(2);
  });

  it("sends a complete download at once", () => {
    const { events, progress } = setup();
    const report = progress.begin("toolu_1");
    report.progress({ transferred: 100, total: 1000 });
    report.progress({ transferred: 1000, total: 1000 });
    expect(events.at(-1)).toEqual({ callId: "toolu_1", state: "preparing", transferred: 1000, total: 1000 });
    vi.advanceTimersByTime(PROGRESS_EVENT_INTERVAL_MS);
    expect(events).toHaveLength(2);
  });

  it("sends progress without a size as it is", () => {
    const { events, progress } = setup();
    progress.begin("toolu_1").progress({ transferred: 5000 });
    expect(events).toEqual([{ callId: "toolu_1", state: "preparing", transferred: 5000 }]);
  });

  it("drops the pending progress when a phase comes, as the terminal does", () => {
    const { events, progress } = setup();
    const report = progress.begin("toolu_1");
    report.progress({ transferred: 100, total: 1000 });
    report.progress({ transferred: 900, total: 1000 });
    report.phase("Verifying kubectl v1.37.0 ...");
    vi.advanceTimersByTime(PROGRESS_EVENT_INTERVAL_MS);
    expect(events).toEqual([
      { callId: "toolu_1", state: "preparing", transferred: 100, total: 1000 },
      { callId: "toolu_1", state: "preparing", phase: "Verifying kubectl v1.37.0 ..." },
    ]);
  });

  it("sends each problem once, and keeps the problems in the event that ends the preparation", () => {
    const { events, progress } = setup();
    const report = progress.begin("toolu_1");
    report.problem("first");
    report.problem("first");
    report.problem("second");
    report.done();
    expect(events).toEqual([
      { callId: "toolu_1", state: "preparing", problems: ["first"] },
      { callId: "toolu_1", state: "preparing", problems: ["first", "second"] },
      { callId: "toolu_1", state: "done", problems: ["first", "second"] },
    ]);
  });

  it("ends a failed preparation with its error, even when it showed nothing before", () => {
    const { events, progress } = setup();
    progress.begin("toolu_1").failed("The cluster is not connected");
    expect(events).toEqual([{ callId: "toolu_1", state: "failed", error: "The cluster is not connected" }]);
  });

  it("stops every shown preparation and drops what is reported for it afterwards", () => {
    const { events, progress } = setup();
    const shown = progress.begin("toolu_1");
    const silent = progress.begin("toolu_2");
    shown.progress({ transferred: 100, total: 1000 });
    shown.progress({ transferred: 200, total: 1000 });
    progress.stopAll();
    shown.progress({ transferred: 300, total: 1000 });
    shown.done();
    silent.done();
    vi.advanceTimersByTime(PROGRESS_EVENT_INTERVAL_MS);
    expect(events).toEqual([
      { callId: "toolu_1", state: "preparing", transferred: 100, total: 1000 },
      { callId: "toolu_1", state: "stopped" },
    ]);
  });

  it("gives the latest state of every shown preparation still running", () => {
    const { progress } = setup();
    const report = progress.begin("toolu_1");
    progress.begin("toolu_2");
    report.progress({ transferred: 100, total: 1000 });
    report.progress({ transferred: 200, total: 1000 });
    expect(progress.current()).toEqual([
      { type: "tool_progress", data: { callId: "toolu_1", state: "preparing", transferred: 200, total: 1000 } },
    ]);
    report.done();
    expect(progress.current()).toEqual([]);
  });

  it("clears without an event", () => {
    const { events, progress } = setup();
    const report = progress.begin("toolu_1");
    report.progress({ transferred: 100, total: 1000 });
    report.progress({ transferred: 200, total: 1000 });
    progress.clear();
    vi.advanceTimersByTime(PROGRESS_EVENT_INTERVAL_MS);
    report.done();
    expect(events).toHaveLength(1);
    expect(progress.current()).toEqual([]);
  });
});

describe("isPersistedToolProgress", () => {
  it("keeps the end of a preparation that the card keeps showing", () => {
    expect(isPersistedToolProgress({ callId: "a", state: "preparing", phase: "x" })).toBe(false);
    expect(isPersistedToolProgress({ callId: "a", state: "done" })).toBe(false);
    expect(isPersistedToolProgress({ callId: "a", state: "done", problems: ["p"] })).toBe(true);
    expect(isPersistedToolProgress({ callId: "a", state: "failed", error: "e" })).toBe(true);
    expect(isPersistedToolProgress({ callId: "a", state: "stopped" })).toBe(true);
  });
});
