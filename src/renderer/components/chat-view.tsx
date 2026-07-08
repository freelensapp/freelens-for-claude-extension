/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import styles from "./chat-view.module.scss";
import { Markdown } from "./markdown";
import { PermissionDialog } from "./permission-dialog";

import type { ChangeEvent, KeyboardEvent } from "react";

import type {
  PermissionBehavior,
  PermissionMode,
  SessionErrorKind,
  SessionEvent,
  SessionEventMap,
} from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";

interface ChatViewProps {
  clusterId: string;
  client: BridgeClient;
}

type PermissionRequest = SessionEventMap["permission_request"];

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; toolName: string }
  | { kind: "tool_result"; toolName: string; summary: string }
  | {
      kind: "permission";
      requestId: string;
      request: PermissionRequest;
      resolution?: { behavior: PermissionBehavior; reason?: string };
    };

interface ChatState {
  items: ChatItem[];
  draft: string;
  working: boolean;
  mode: PermissionMode;
  resumed: boolean;
  error?: { message: string; kind: SessionErrorKind };
}

const initialState: ChatState = { items: [], draft: "", working: false, mode: "approve", resumed: false };

type ChatAction = SessionEvent | { type: "reset" };

function reducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialState;
    case "status":
      return { ...state, working: action.data.state === "working" };
    case "user_message":
      return { ...state, items: [...state.items, { kind: "user", text: action.data.text }], draft: "" };
    case "assistant_delta":
      return { ...state, draft: state.draft + action.data.text };
    case "assistant_message":
      return { ...state, items: [...state.items, { kind: "assistant", text: action.data.text }], draft: "" };
    case "tool_call":
      return { ...state, items: [...state.items, { kind: "tool_call", toolName: action.data.toolName }] };
    case "tool_result":
      return {
        ...state,
        items: [...state.items, { kind: "tool_result", toolName: action.data.toolName, summary: action.data.summary }],
      };
    case "permission_request":
      return {
        ...state,
        items: [...state.items, { kind: "permission", requestId: action.data.requestId, request: action.data }],
      };
    case "permission_resolved":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "permission" && item.requestId === action.data.requestId
            ? { ...item, resolution: { behavior: action.data.behavior, reason: action.data.reason } }
            : item,
        ),
      };
    case "session_meta":
      return { ...state, mode: action.data.permissionMode, resumed: action.data.resumed };
    case "turn_complete": {
      const items = state.draft ? [...state.items, { kind: "assistant" as const, text: state.draft }] : state.items;
      return { ...state, items, draft: "", working: false };
    }
    case "error":
      return { ...state, error: { message: action.data.message, kind: action.data.kind }, working: false };
    default:
      return state;
  }
}

const MODE_LABELS: Record<PermissionMode, string> = {
  readOnly: "Read-only",
  approve: "Approve",
  acceptAll: "Accept all",
};

function ToolNotice({ label }: { label: string }) {
  return <div className={styles.toolNotice}>{label}</div>;
}

export function ChatView({ clusterId, client }: ChatViewProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const [epoch, setEpoch] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    const close = client.streamEvents(clusterId, {
      onOpen: () => dispatch({ type: "reset" }),
      onEvent: (event) => dispatch(event),
    });
    return close;
  }, [clusterId, client, epoch]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.items, state.draft]);

  const send = async () => {
    const text = input.trim();
    if (!text || state.working) return;
    setInput("");
    try {
      await client.sendMessage(clusterId, text);
    } catch (error) {
      dispatch({
        type: "error",
        data: { message: `Failed to send message: ${String(error)}`, kind: "other" },
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const stop = () => {
    void client.interrupt(clusterId);
  };

  const newChat = async () => {
    await client.disposeSession(clusterId);
    setInput("");
    setEpoch((value) => value + 1);
  };

  const resolvePermission = (requestId: string, behavior: PermissionBehavior) => {
    void client.resolvePermission(requestId, behavior).catch((error) => {
      dispatch({
        type: "error",
        data: { message: `Failed to resolve approval: ${String(error)}`, kind: "other" },
      });
    });
  };

  const changeMode = (event: ChangeEvent<HTMLSelectElement>) => {
    const mode = event.target.value as PermissionMode;
    void client.setPermissionMode(clusterId, mode).catch((error) => {
      dispatch({
        type: "error",
        data: { message: `Failed to change mode: ${String(error)}`, kind: "other" },
      });
    });
  };

  return (
    <div className={styles.chatView}>
      <div className={styles.transcript} ref={scrollRef}>
        {state.items.map((item, index) => {
          const key = `${index}-${item.kind}`;
          if (item.kind === "user") {
            return (
              <div key={key} className={styles.userBubble}>
                {item.text}
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={key} className={styles.assistantBubble}>
                <Markdown>{item.text}</Markdown>
              </div>
            );
          }
          if (item.kind === "tool_call") {
            return <ToolNotice key={key} label={`Calling ${item.toolName}...`} />;
          }
          if (item.kind === "permission") {
            return (
              <PermissionDialog
                key={item.requestId}
                request={item.request}
                resolution={item.resolution}
                onResolve={(behavior) => resolvePermission(item.requestId, behavior)}
              />
            );
          }
          return <ToolNotice key={key} label={`${item.toolName} returned`} />;
        })}

        {state.draft ? (
          <div className={styles.assistantBubble}>
            <Markdown>{state.draft}</Markdown>
          </div>
        ) : null}
      </div>

      {state.error ? (
        <div className={styles.errorBanner}>
          {state.error.message}
          {state.error.kind === "auth" ? (
            <div className={styles.errorHint}>
              Run <code>claude</code> in a terminal to log in, then start a new chat.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.statusStrip}>
        <div className={styles.statusLeft}>
          {state.working ? <span className={styles.workingIndicator}>Working...</span> : null}
          {state.resumed ? <span className={styles.resumedNotice}>conversation resumed</span> : null}
        </div>
        <div className={styles.actions}>
          <label className={styles.modeSelector}>
            Mode:
            <select
              className={state.mode === "acceptAll" ? `${styles.modeSelect} ${styles.modeWarning}` : styles.modeSelect}
              value={state.mode}
              onChange={changeMode}
            >
              {(Object.keys(MODE_LABELS) as PermissionMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          {state.working ? (
            <button type="button" className={styles.secondaryButton} onClick={stop}>
              Stop
            </button>
          ) : null}
          <button type="button" className={styles.secondaryButton} onClick={() => void newChat()}>
            New chat
          </button>
        </div>
      </div>

      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          value={input}
          placeholder="Ask about this cluster..."
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />
        <button
          type="button"
          className={styles.sendButton}
          onClick={() => void send()}
          disabled={state.working || input.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  );
}
