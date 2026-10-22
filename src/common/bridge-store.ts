/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

/**
 * The IPC channel on which a cluster frame asks main for the bridge's
 * {@link BridgeConnection}. Main answers a cluster frame only, and `null`
 * to any other frame.
 */
export const BRIDGE_CONNECTION_CHANNEL = "bridge-connection";

/** What a client needs to reach the bridge. */
export interface BridgeConnection {
  port: number;
  token: string;
}

// The local bridge server's port. The main process writes it once the bridge
// listens; Freelens syncs the store to every frame, where a new port tells the
// chat that a new bridge is up. The bearer token is not in the store: Freelens
// writes the store to disk and every frame can read it, so a cluster frame
// asks main for the token over IPC (BRIDGE_CONNECTION_CHANNEL) instead.
export interface BridgeStoreModel {
  port: number;
  /**
   * Always empty. Kept in the model only so that the token an older version
   * saved in `bridge-store.json` is overwritten: the host saves each key of
   * the model and never deletes a key it no longer gets.
   */
  token: string;
}

export class BridgeStore extends Common.Store.ExtensionStore<BridgeStoreModel> {
  port = 0;

  constructor() {
    super({
      configName: "bridge-store",
      defaults: {
        port: 0,
        token: "",
      },
    });
    makeObservable(this, {
      port: observable,
    });
  }

  setPort(port: number): void {
    this.port = port;
  }

  fromStore({ port }: Partial<BridgeStoreModel>): void {
    this.port = port ?? 0;
  }

  toJSON(): BridgeStoreModel {
    return {
      port: this.port,
      token: "",
    };
  }
}
