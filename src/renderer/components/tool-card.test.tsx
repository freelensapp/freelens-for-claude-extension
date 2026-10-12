// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCard, type ToolPreparation } from "./tool-card";

const INPUT = { args: ["version"] };
const PROBLEM = "Failed to download kubectl v1.37.0 (timeout) - using the bundled v1.35.3";

function renderCard(preparation?: ToolPreparation, toolName = "freelens_kubectl", result?: string) {
  return render(<ToolCard toolName={toolName} input={INPUT} result={result} preparation={preparation} />);
}

/** The visible preparation line (icons as their names), without the screen reader's status. */
function line(container: HTMLElement): string {
  return container.querySelector('[class*="preparation"]')?.textContent ?? "";
}

describe("ToolCard preparation line", () => {
  it("shows no line and an empty status before anything is reported", () => {
    const { container } = renderCard();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(line(container)).toBe("");
  });

  it("shows the host's phase verbatim and announces it", () => {
    const { container } = renderCard({ callId: "c", state: "preparing", phase: "Verifying kubectl v1.37.0 ..." });
    expect(line(container)).toBe("Verifying kubectl v1.37.0 ...");
    expect(screen.getByRole("status").textContent).toBe("Verifying kubectl v1.37.0 ...");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows a download of a known size with the host's bar and a progressbar", () => {
    const { container } = renderCard({
      callId: "c",
      state: "preparing",
      transferred: 24.5 * 1024 * 1024,
      total: 57 * 1024 * 1024,
    });
    expect(line(container)).toBe("Downloading kubectl42% 24.5MiB / 57.0MiB");
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar.getAttribute("aria-valuenow")).toBe(String(24.5 * 1024 * 1024));
    expect(progressbar.getAttribute("aria-valuemax")).toBe(String(57 * 1024 * 1024));
    expect(progressbar.getAttribute("aria-valuetext")).toBe("42% 24.5MiB / 57.0MiB");
    expect(container.querySelector("[data-line-progress]")?.getAttribute("data-line-progress")).toBe(
      `${24.5 * 1024 * 1024}/${57 * 1024 * 1024}`,
    );
    // The counter is not announced at every tick.
    expect(screen.getByRole("status").textContent).toBe("Downloading kubectl");
  });

  it("shows only the counter for a download of an unknown size", () => {
    const { container } = renderCard({ callId: "c", state: "preparing", transferred: 3 * 1024 * 1024 });
    expect(line(container)).toBe("Downloading kubectl3.0MiB");
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar.hasAttribute("aria-valuenow")).toBe(false);
    expect(progressbar.getAttribute("aria-valuetext")).toBe("3.0MiB");
    expect(container.querySelector("[data-line-progress]")).toBeNull();
  });

  it("goes away when the preparation is done", () => {
    const { container } = renderCard({ callId: "c", state: "done" });
    expect(line(container)).toBe("");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("keeps a problem as a warning after the result, with the details in the expanded card", () => {
    const { container } = renderCard(
      { callId: "c", state: "done", problems: [PROBLEM] },
      "freelens_kubectl",
      `[Freelens: ${PROBLEM}]\n\nClient Version: v1.35.3\n\n[exit code 0]`,
    );
    expect(line(container)).toBe("warningProblem preparing kubectl");
    expect(screen.getByRole("status").textContent).toBe(`Problem preparing kubectl: ${PROBLEM}`);
    expect(screen.queryByText(PROBLEM)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(PROBLEM)).toBeTruthy();
  });

  it("shows a problem of a helm call live, next to the phase", () => {
    const { container } = renderCard(
      { callId: "c", state: "preparing", phase: "Verifying kubectl v1.37.0 ...", problems: [PROBLEM, "another"] },
      "freelens_helm",
    );
    expect(line(container)).toBe("Verifying kubectl v1.37.0 ...warning2 problems preparing kubectl");
  });

  it("keeps a failed preparation in the line", () => {
    const { container } = renderCard(
      { callId: "c", state: "failed", error: "The cluster is not connected" },
      "freelens_helm",
      "Tool error: The cluster is not connected",
    );
    expect(line(container)).toBe("error_outlinePreparing helm failed: The cluster is not connected");
    expect(screen.getByRole("status").textContent).toBe("Preparing helm failed: The cluster is not connected");
  });

  it("says Stopped when the turn was interrupted during the preparation", () => {
    const { container } = renderCard({ callId: "c", state: "stopped" });
    expect(line(container)).toBe("Stopped while preparing kubectl");
  });

  it("has no preparation line for the other tools", () => {
    renderCard(undefined, "freelens_resources");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
