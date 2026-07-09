/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { randomBytes } from "node:crypto";
import { Common, Main } from "@freelensapp/extensions";
import { BridgeStore } from "../common/bridge-store";
import { PreferencesStore } from "../common/preferences-store";
import { ChatSessionStore } from "../common/session-store";
import { BridgeServer } from "./bridge/server";
import { type DetectionResult, detectClaudeCode } from "./claude/detect";
import { SessionManager } from "./claude/session-manager";

import type { StatusResponse } from "../common/protocol";

export default class ForClaudeMain extends Main.LensExtension {
  private server?: BridgeServer;
  private sessionManager?: SessionManager;
  private preferences?: PreferencesStore;
  private detection: DetectionResult = { found: false };
  private ready = false;

  async onActivate(): Promise<void> {
    try {
      const store = BridgeStore.createInstance<BridgeStore>();
      store.loadExtension(this);

      const sessionStore = ChatSessionStore.createInstance<ChatSessionStore>();
      sessionStore.loadExtension(this);

      const preferences = PreferencesStore.createInstance<PreferencesStore>();
      preferences.loadExtension(this);
      this.preferences = preferences;

      const token = randomBytes(32).toString("hex");
      this.detection = await detectClaudeCode({}, preferences.claudeCodePath);

      const baseDir = await this.getExtensionFileFolder();
      this.sessionManager = new SessionManager(
        () => (this.detection.found ? this.detection.path : undefined),
        baseDir,
        sessionStore,
        preferences,
      );

      this.server = new BridgeServer({
        token,
        sessionManager: this.sessionManager,
        getStatus: (refresh) => this.buildStatus(refresh),
      });
      const port = await this.server.start();
      this.ready = true;
      store.set({ port, token });

      Common.logger.info(`[for-claude] bridge listening on 127.0.0.1:${port}`);
    } catch (error) {
      // Activation must not throw; GET /status reports the failure state.
      Common.logger.error(`[for-claude] activation failed: ${error}`);
    }
  }

  async onDeactivate(): Promise<void> {
    await this.sessionManager?.disposeAll();
    await this.server?.stop();
    this.ready = false;
  }

  private async buildStatus(refresh: boolean): Promise<StatusResponse> {
    if (refresh) {
      this.detection = await detectClaudeCode({}, this.preferences?.claudeCodePath);
    }
    return {
      ready: this.ready,
      claudeCode: {
        found: this.detection.found,
        path: this.detection.path,
        version: this.detection.version,
        error: this.detection.error,
      },
    };
  }
}
