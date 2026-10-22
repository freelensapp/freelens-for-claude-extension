/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, Main } from "@freelensapp/extensions";
import { BRIDGE_CONNECTION_CHANNEL, type BridgeConnection } from "../../common/bridge-store";
import { isClusterFrameOrigin } from "./frame-origin";

/**
 * The part of Electron's `IpcMainInvokeEvent` that the handler reads.
 * `senderFrame` is set by Electron, not by the page, so its origin is the
 * frame's own.
 */
interface InvokeEvent {
  readonly senderFrame: { readonly origin: string } | null;
}

/** The connection for the frame that asked: a cluster frame gets it, any other frame `null`. */
export function connectionForFrame(event: InvokeEvent, connection: BridgeConnection): BridgeConnection | null {
  const origin = event.senderFrame?.origin;
  if (!isClusterFrameOrigin(origin)) {
    Common.logger.warn(`[for-claude] refused the bridge connection to a frame of origin ${origin ?? "(none)"}`);
    return null;
  }
  return connection;
}

/**
 * Hands the bridge's port and token to the cluster frames, in memory, on
 * request. The host removes the handler when the extension is deactivated.
 */
export class BridgeIpc extends Main.Ipc {
  serveConnection(connection: BridgeConnection): void {
    this.handle(BRIDGE_CONNECTION_CHANNEL, (event: InvokeEvent) => connectionForFrame(event, connection));
  }
}
