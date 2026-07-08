/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { ChatSessionStore } from "./session-store";

describe("ChatSessionStore", () => {
  it("persists a session id and permission mode and round-trips through the model", () => {
    const store = new ChatSessionStore();
    store.writePermissionMode("c1", "readOnly");
    store.writeSessionId("c1", "sess-123");

    const entry = store.read("c1");
    expect(entry?.sessionId).toBe("sess-123");
    expect(entry?.permissionMode).toBe("readOnly");
    expect(entry?.updatedAt).toBeTypeOf("string");

    // toJSON -> fromStore restores the same state on the next launch.
    const restored = new ChatSessionStore();
    restored.fromStore(store.toJSON());
    expect(restored.read("c1")?.sessionId).toBe("sess-123");
    expect(restored.read("c1")?.permissionMode).toBe("readOnly");
  });

  it("never persists acceptAll", () => {
    const store = new ChatSessionStore();
    store.writePermissionMode("c1", "approve");
    store.writePermissionMode("c1", "acceptAll");
    // The acceptAll write is ignored; the last persisted mode stands.
    expect(store.read("c1")?.permissionMode).toBe("approve");
  });

  it("clearing the session id keeps the persisted permission mode", () => {
    const store = new ChatSessionStore();
    store.writePermissionMode("c1", "readOnly");
    store.writeSessionId("c1", "sess-123");

    store.writeSessionId("c1", undefined);
    const entry = store.read("c1");
    expect(entry?.sessionId).toBeUndefined();
    expect(entry?.permissionMode).toBe("readOnly");
  });

  it("clearing an unknown cluster does not create an entry", () => {
    const store = new ChatSessionStore();
    store.writeSessionId("ghost", undefined);
    expect(store.read("ghost")).toBeUndefined();
    expect(store.toJSON().sessions).toEqual({});
  });

  it("defaults the permission mode to approve when only a session id is written", () => {
    const store = new ChatSessionStore();
    store.writeSessionId("c1", "sess-123");
    expect(store.read("c1")?.permissionMode).toBe("approve");
  });
});
