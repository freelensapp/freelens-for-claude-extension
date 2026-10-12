// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionDialog } from "./permission-dialog";

import type { SessionEventMap } from "../../common/protocol";

const request: SessionEventMap["permission_request"] = {
  requestId: "r1",
  toolName: "freelens_kubectl",
  actionTitle: "RUN KUBECTL",
  input: { args: ["delete", "pod", "web"] },
  proposedYaml: "args:\n  - delete",
};

describe("PermissionDialog resolved", () => {
  function renderResolved(resolution: SessionEventMap["permission_resolved"]) {
    return render(<PermissionDialog request={request} resolution={resolution} onResolve={() => {}} />);
  }

  it("says Approved for an approved request", () => {
    renderResolved({ requestId: "r1", behavior: "allow" });
    expect(screen.getByText("Approved").className).toContain("approvedTag");
  });

  it("says Denied in red for a request the user denied", () => {
    renderResolved({ requestId: "r1", behavior: "deny" });
    expect(screen.getByText("Denied").className).toContain("deniedTag");
  });

  it("says Stopped, neutrally, for a request pending when the user stopped the turn", () => {
    renderResolved({ requestId: "r1", behavior: "deny", stopped: true });
    expect(screen.getByText("Stopped").className).toContain("stoppedTag");
    expect(screen.queryByText("Denied")).toBeNull();
    expect(screen.getByText("RUN KUBECTL")).toBeTruthy();
  });

  it("keeps the reason of a request denied by the end of the session", () => {
    renderResolved({ requestId: "r1", behavior: "deny", reason: "the session ended" });
    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.getByText("RUN KUBECTL (the session ended)")).toBeTruthy();
  });
});
