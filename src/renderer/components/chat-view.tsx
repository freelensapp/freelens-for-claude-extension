/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import styles from "./chat-view.module.scss";
import { Markdown } from "./markdown";

import type { KeyboardEvent } from "react";

import type { SessionErrorKind, SessionEvent } from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";

interface ChatViewProps {
  clusterId: string;
  client: BridgeClient;
}

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; toolName: string }
  | { kind: "tool_result"; toolName: string; summary: string };

interface ChatState {
  items: ChatItem[];
  draft: string;
  working: boolean;
  error?: { message: string; kind: SessionErrorKind };
}

const initialState: ChatState = { items: [], draft: "", working: false };

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
        {state.working ? <span className={styles.workingIndicator}>Working...</span> : <span />}
        <div className={styles.actions}>
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
          disabled={state.working}
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
