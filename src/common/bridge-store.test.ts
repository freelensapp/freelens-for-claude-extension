/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, describe, expect, it } from "vitest";
import { BridgeStore } from "./bridge-store";

describe("BridgeStore", () => {
  afterEach(() => {
    BridgeStore.resetInstance();
  });

  it("saves the port and an empty token, which overwrites a token saved by an older version", () => {
    const store = BridgeStore.getInstanceOrCreate<BridgeStore>();
    store.fromStore({ port: 4242, token: "left-on-disk" });

    expect(store.port).toBe(4242);
    expect(store.toJSON()).toEqual({ port: 4242, token: "" });

    store.setPort(5353);
    expect(store.toJSON()).toEqual({ port: 5353, token: "" });
  });
});
