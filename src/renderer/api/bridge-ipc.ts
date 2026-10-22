/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { BRIDGE_CONNECTION_CHANNEL, type BridgeConnection } from "../../common/bridge-store";

/** The renderer side of the bridge connection handoff (see `src/main/bridge/ipc.ts`). */
export class BridgeIpc extends Renderer.Ipc {
  /** The bridge's port and token, or `null` when main refuses this frame. */
  async requestConnection(): Promise<BridgeConnection | null> {
    return ((await this.invoke(BRIDGE_CONNECTION_CHANNEL)) as BridgeConnection | null | undefined) ?? null;
  }
}
