/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useCallback, useEffect, useState } from "react";
import { bridgeClient } from "../api/bridge-client";
import styles from "./chat-page.module.scss";
import { ChatView } from "./chat-view";
import { Onboarding } from "./onboarding";

import type { StatusResponse } from "../../common/protocol";

/** Top-level cluster page: onboarding gate or the chat view. */
export function ChatPage() {
  const client = bridgeClient();
  const [status, setStatus] = useState<StatusResponse | undefined>();
  const [failed, setFailed] = useState(false);

  const cluster = Renderer.Catalog.getActiveCluster();
  const clusterId = cluster?.id;

  const refresh = useCallback(
    async (refreshDetection: boolean) => {
      if (!client.isReady) {
        setFailed(true);
        return;
      }
      try {
        setStatus(await client.getStatus(refreshDetection));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  if (!clusterId) {
    return <div className={styles.notice}>Open this page from within a connected cluster.</div>;
  }

  if (failed || !client.isReady) {
    return (
      <div className={styles.notice}>
        The Claude bridge is not ready yet.
        <button type="button" className={styles.retry} onClick={() => void refresh(false)}>
          Retry
        </button>
      </div>
    );
  }

  if (!status) {
    return <div className={styles.notice}>Connecting to Claude...</div>;
  }

  if (!status.claudeCode.found) {
    return <Onboarding status={status} onRecheck={() => refresh(true)} />;
  }

  return <ChatView clusterId={clusterId} client={client} />;
}
