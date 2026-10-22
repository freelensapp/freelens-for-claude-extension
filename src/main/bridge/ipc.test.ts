/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, type Main } from "@freelensapp/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeIpc, connectionForFrame } from "./ipc";

const connection = { port: 4242, token: "secret" };
const frame = (origin: string) => ({ senderFrame: { origin } });

describe("connectionForFrame", () => {
  afterEach(() => {
    vi.mocked(Common.logger.warn).mockClear();
  });

  it("gives the connection to a cluster frame", () => {
    expect(connectionForFrame(frame("https://c1.renderer.freelens.app:9443"), connection)).toEqual(connection);
    expect(Common.logger.warn).not.toHaveBeenCalled();
  });

  it.each(["https://renderer.freelens.app:9443", "https://evil.example", "file://"])(
    "refuses the frame %s and logs it",
    (origin) => {
      expect(connectionForFrame(frame(origin), connection)).toBeNull();
      expect(Common.logger.warn).toHaveBeenCalledWith(expect.stringContaining(origin));
    },
  );

  it("refuses an event without a sender frame", () => {
    expect(connectionForFrame({ senderFrame: null }, connection)).toBeNull();
  });
});

describe("BridgeIpc", () => {
  afterEach(() => {
    BridgeIpc.resetInstance();
  });

  it("serves the connection on the bridge-connection channel", () => {
    const ipc = BridgeIpc.createInstance({} as Main.LensExtension);
    ipc.serveConnection(connection);

    const handle = vi.mocked(ipc.handle);
    expect(handle).toHaveBeenCalledWith("bridge-connection", expect.any(Function));
    const handler = handle.mock.calls[0][1];
    expect(handler(frame("https://c1.renderer.freelens.app:9443") as never)).toEqual(connection);
    expect(handler(frame("https://renderer.freelens.app:9443") as never)).toBeNull();
  });
});
