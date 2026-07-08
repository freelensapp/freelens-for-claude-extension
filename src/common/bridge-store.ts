/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

// The local bridge server's connection details. The main process writes them
// on activation; Freelens syncs the store to the renderer, which reads them to
// reach the HTTP bridge. Mirrors the original AI extension's
// `PreferencesStore.aiProxyPort/aiProxyToken` pattern.
export interface BridgeStoreModel {
  port: number;
  token: string;
}

export class BridgeStore extends Common.Store.ExtensionStore<BridgeStoreModel> {
  port = 0;
  token = "";

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
      token: observable,
    });
  }

  set({ port, token }: BridgeStoreModel): void {
    this.port = port;
    this.token = token;
  }

  fromStore({ port, token }: Partial<BridgeStoreModel>): void {
    this.port = port ?? 0;
    this.token = token ?? "";
  }

  toJSON(): BridgeStoreModel {
    return {
      port: this.port,
      token: this.token,
    };
  }
}
