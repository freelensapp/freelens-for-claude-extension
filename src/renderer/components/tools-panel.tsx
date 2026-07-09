/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { useState } from "react";
import styles from "./tools-panel.module.scss";

import type { ClusterToolsResponse } from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";

interface ToolsPanelProps {
  clusterId: string;
  client: BridgeClient;
}

function ToolList({ tools }: { tools: { name: string; description?: string }[] }) {
  return (
    <>
      {tools.map((entry) => (
        <div key={entry.name} className={styles.tool}>
          <div className={styles.toolName}>{entry.name}</div>
          {entry.description ? <div className={styles.toolDescription}>{entry.description}</div> : null}
        </div>
      ))}
    </>
  );
}

/**
 * An informational popover listing the built-in tools (grouped read-only and
 * mutating) and any external MCP servers with their status and tools. Fetched
 * fresh each time the panel opens; there is no enable/disable here.
 */
export function ToolsPanel({ clusterId, client }: ToolsPanelProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ClusterToolsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setData(null);
      setError(null);
      client
        .getTools(clusterId)
        .then((tools) => setData(tools))
        .catch((reason) => setError(`Could not load tools: ${String(reason)}`));
    }
  };

  const readOnly = data?.builtin.filter((tool) => !tool.mutating) ?? [];
  const mutating = data?.builtin.filter((tool) => tool.mutating) ?? [];

  return (
    <div className={styles.container}>
      <button type="button" className={styles.toggleButton} onClick={toggle}>
        Tools
      </button>
      {open ? (
        <div className={styles.popover}>
          {error ? <div className={styles.error}>{error}</div> : null}
          {!error && !data ? <div className={styles.empty}>Loading...</div> : null}
          {data ? (
            <>
              <div className={styles.group}>
                <div className={styles.groupLabel}>Read-only tools</div>
                <ToolList tools={readOnly} />
              </div>
              <div className={styles.group}>
                <div className={styles.groupLabel}>Mutating tools</div>
                <ToolList tools={mutating} />
              </div>
              {data.mcp.length > 0 ? (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>MCP servers</div>
                  {data.mcp.map((server) => (
                    <div key={server.name} className={styles.server}>
                      <div className={styles.serverHeader}>
                        <span className={styles.serverName}>{server.name}</span>
                        <span
                          className={`${styles.serverStatus} ${
                            server.status === "connected" ? styles.statusConnected : styles.statusOther
                          }`}
                        >
                          {server.status}
                        </span>
                      </div>
                      {server.tools.length > 0 ? (
                        <ToolList tools={server.tools} />
                      ) : (
                        <div className={styles.empty}>No tools reported</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
