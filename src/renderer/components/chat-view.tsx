/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { PreferencesStore } from "../../common/preferences-store";
import { BUILTIN_PROMPT_SHORTCUTS, parsePromptShortcuts } from "../../common/prompt-shortcuts";
import { MODEL_CHOICES } from "../../common/protocol";
import { pendingPrompt } from "../api/pending-prompt";
import styles from "./chat-view.module.scss";
import { Markdown } from "./markdown";
import { PermissionDialog } from "./permission-dialog";
import { SlashMenu } from "./slash-menu";
import { ToolCard } from "./tool-card";
import { ToolsPanel } from "./tools-panel";

import type { ChangeEvent, KeyboardEvent } from "react";

import type {
  PermissionBehavior,
  PermissionMode,
  SessionErrorKind,
  SessionEvent,
  SessionEventMap,
} from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";
import type { ToolChild } from "./tool-card";

interface ChatViewProps {
  clusterId: string;
  client: BridgeClient;
}

type PermissionRequest = SessionEventMap["permission_request"];

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; callId: string; toolName: string; input: unknown; result?: string; children?: ToolChild[] }
  | { kind: "tool_call"; toolName: string }
  | { kind: "tool_result"; toolName: string; summary: string }
  | { kind: "notice"; text: string }
  | { kind: "local_command"; content: string }
  | { kind: "session_error"; message: string; errorKind: SessionErrorKind; canRetry: boolean }
  | {
      kind: "permission";
      requestId: string;
      request: PermissionRequest;
      resolution?: { behavior: PermissionBehavior; reason?: string };
    };

interface UsageTotals {
  input: number;
  cached: number;
  output: number;
}

interface ChatState {
  items: ChatItem[];
  draft: string;
  /** Live-only reasoning accumulated for the streaming answer; cleared each turn. */
  draftReasoning: string;
  working: boolean;
  mode: PermissionMode;
  resumed: boolean;
  model?: string;
  resolvedModel?: string;
  usage?: UsageTotals;
  error?: { message: string; kind: SessionErrorKind };
  slashCommands?: string[];
}

const initialState: ChatState = {
  items: [],
  draft: "",
  draftReasoning: "",
  working: false,
  mode: "approve",
  resumed: false,
};

type ChatAction = SessionEvent | { type: "reset" };

function reducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialState;
    case "status":
      return { ...state, working: action.data.state === "working" };
    case "user_message":
      // A new user turn clears any stale banner error.
      return {
        ...state,
        items: [...state.items, { kind: "user", text: action.data.text }],
        draft: "",
        draftReasoning: "",
        error: undefined,
      };
    case "assistant_delta":
      return { ...state, draft: state.draft + action.data.text };
    case "assistant_thinking":
      // Accumulate live reasoning for the streaming answer's collapsible fold.
      return { ...state, draftReasoning: state.draftReasoning + action.data.delta };
    case "assistant_message":
      return {
        ...state,
        items: [...state.items, { kind: "assistant", text: action.data.text }],
        draft: "",
        draftReasoning: "",
      };
    case "tool_call":
      if (action.data.callId) {
        const callId = action.data.callId;
        const child: ToolChild = { callId, toolName: action.data.toolName, input: action.data.input };
        // Subagent tool calls render indented under the matching Agent card.
        const parentId = action.data.parentCallId;
        if (parentId && state.items.some((item) => item.kind === "tool" && item.callId === parentId)) {
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === "tool" && item.callId === parentId
                ? { ...item, children: [...(item.children ?? []), child] }
                : item,
            ),
          };
        }
        // Top-level call, or an orphaned parented call with no matching card.
        return {
          ...state,
          items: [...state.items, { kind: "tool", callId, toolName: action.data.toolName, input: action.data.input }],
        };
      }
      // Replayed M1 transcript event: keep the one-line notice.
      return { ...state, items: [...state.items, { kind: "tool_call", toolName: action.data.toolName }] };
    case "tool_result": {
      if (action.data.callId) {
        const callId = action.data.callId;
        const summary = action.data.summary;
        const parentId = action.data.parentCallId;
        if (
          parentId &&
          state.items.some(
            (item) =>
              item.kind === "tool" &&
              item.callId === parentId &&
              (item.children ?? []).some((c) => c.callId === callId),
          )
        ) {
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === "tool" && item.callId === parentId
                ? {
                    ...item,
                    children: (item.children ?? []).map((c) => (c.callId === callId ? { ...c, result: summary } : c)),
                  }
                : item,
            ),
          };
        }
        return {
          ...state,
          items: state.items.map((item) =>
            item.kind === "tool" && item.callId === callId ? { ...item, result: summary } : item,
          ),
        };
      }
      return {
        ...state,
        items: [...state.items, { kind: "tool_result", toolName: action.data.toolName, summary: action.data.summary }],
      };
    }
    case "usage": {
      const usage: UsageTotals = state.usage ?? { input: 0, cached: 0, output: 0 };
      return {
        ...state,
        usage: {
          input: usage.input + action.data.inputTokens,
          cached: usage.cached + action.data.cachedInputTokens,
          output: usage.output + action.data.outputTokens,
        },
      };
    }
    case "compaction":
      return {
        ...state,
        items: [...state.items, { kind: "notice", text: "Conversation compacted to save context" }],
      };
    case "local_command_output":
      return {
        ...state,
        items: [...state.items, { kind: "local_command", content: action.data.content }],
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
      return {
        ...state,
        mode: action.data.permissionMode,
        resumed: action.data.resumed,
        model: action.data.model,
        resolvedModel: action.data.resolvedModel,
        // Keep previously-known commands when a later meta event omits them.
        slashCommands: action.data.slashCommands ?? state.slashCommands,
      };
    case "turn_complete": {
      const items = state.draft ? [...state.items, { kind: "assistant" as const, text: state.draft }] : state.items;
      return { ...state, items, draft: "", draftReasoning: "", working: false };
    }
    case "error":
      // Retryable errors become transcript items; others stay in the banner.
      if (action.data.canRetry) {
        return {
          ...state,
          items: [
            ...state.items,
            { kind: "session_error", message: action.data.message, errorKind: action.data.kind, canRetry: true },
          ],
          working: false,
        };
      }
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

/**
 * The live "Reasoning" fold shown above the streaming answer. It auto-opens
 * while reasoning is the only content and folds once answer text arrives; once
 * the user toggles it manually, their choice is respected.
 */
function ReasoningFold({ reasoning, hasAnswer }: { reasoning: string; hasAnswer: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !hasAnswer;
  const onToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    // Only a user-driven change (differing from the derived state) records a
    // manual override; our own programmatic open/close is a no-op here.
    const next = event.currentTarget.open;
    if (next !== open) setOverride(next);
  };
  return (
    <details className={styles.reasoning} open={open} onToggle={onToggle}>
      <summary className={styles.reasoningSummary}>Reasoning</summary>
      <div className={styles.reasoningBody}>{reasoning}</div>
    </details>
  );
}

function formatUsage(usage: UsageTotals): string {
  const n = (value: number) => value.toLocaleString("en-US");
  return `in:${n(usage.input)} (cached:${n(usage.cached)}) + out:${n(usage.output)}`;
}

export function ChatView({ clusterId, client }: ChatViewProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const workingRef = useRef(state.working);
  workingRef.current = state.working;

  // The slash-command autocomplete: active while the draft is a bare `/command`
  // (starts with `/`, no whitespace yet). Absent/empty command lists show nothing.
  const slashQuery = input.startsWith("/") && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const slashMatches =
    slashQuery !== null
      ? (state.slashCommands ?? [])
          .map((name) => name.replace(/^\//, ""))
          .filter((name) => name.toLowerCase().startsWith(slashQuery))
      : [];
  const menuOpen = slashQuery !== null && slashMatches.length > 0 && !menuDismissed;
  const menuSelected = slashMatches.length > 0 ? Math.min(menuIndex, slashMatches.length - 1) : 0;

  const changeInput = (value: string) => {
    setInput(value);
    setMenuDismissed(false);
    setMenuIndex(0);
  };

  const completeCommand = (name: string) => {
    setInput(`/${name}`);
    setMenuDismissed(true);
    setMenuIndex(0);
  };

  const sendText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || workingRef.current) return;
    try {
      await client.sendMessage(clusterId, trimmed);
    } catch (error) {
      dispatch({
        type: "error",
        data: { message: `Failed to send message: ${String(error)}`, kind: "other" },
      });
    }
  };

  useEffect(() => {
    dispatch({ type: "reset" });
    const close = client.streamEvents(clusterId, {
      onOpen: () => {
        dispatch({ type: "reset" });
        // Pick up an "Ask Claude" prompt handed off by a kube object menu entry.
        const prompt = pendingPrompt.consume();
        if (prompt) void sendText(prompt);
      },
      onEvent: (event) => dispatch(event),
    });
    return close;
  }, [clusterId, client, epoch]);

  // Stick-to-bottom: only follow new content when the user is already parked
  // near the bottom; otherwise leave their scroll position alone.
  useEffect(() => {
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.items, state.draft, state.draftReasoning, atBottom]);

  const onTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 80);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    setAtBottom(true);
  };

  const newChat = async () => {
    await client.disposeSession(clusterId);
    setInput("");
    setEpoch((value) => value + 1);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || state.working) return;
    // `/clear` resets the transcript and session id together via New chat.
    if (text === "/clear") {
      setInput("");
      await newChat();
      return;
    }
    setInput("");
    await sendText(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((index) => (index + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        completeCommand(slashMatches[menuSelected]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const stop = () => {
    void client.interrupt(clusterId);
  };

  const retry = () => {
    void client.retry(clusterId).catch((error) => {
      dispatch({
        type: "error",
        data: { message: `Failed to retry: ${String(error)}`, kind: "other" },
      });
    });
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

  const changeModel = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    void client.setModel(clusterId, value || null).catch((error) => {
      dispatch({
        type: "error",
        data: { message: `Failed to change model: ${String(error)}`, kind: "other" },
      });
    });
  };

  const lastIndex = state.items.length - 1;
  const defaultLabel = state.resolvedModel ? `Default (${state.resolvedModel})` : "Default";

  // Quick-prompt chips: the built-ins plus any user-defined entries. Shown only
  // when the input is empty and no turn is in flight.
  const shortcuts = [
    ...BUILTIN_PROMPT_SHORTCUTS,
    ...parsePromptShortcuts(PreferencesStore.getInstanceOrCreate<PreferencesStore>().promptShortcuts),
  ];
  const showShortcuts = input.trim().length === 0 && !state.working;

  return (
    <div className={styles.chatView}>
      <div className={styles.transcriptWrap}>
        <div className={styles.transcript} ref={scrollRef} onScroll={onTranscriptScroll}>
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
            if (item.kind === "tool") {
              return (
                <ToolCard
                  key={item.callId}
                  toolName={item.toolName}
                  input={item.input}
                  result={item.result}
                  childCalls={item.children}
                />
              );
            }
            if (item.kind === "tool_call") {
              return <ToolNotice key={key} label={`Calling ${item.toolName}...`} />;
            }
            if (item.kind === "notice") {
              return <ToolNotice key={key} label={item.text} />;
            }
            if (item.kind === "local_command") {
              return (
                <pre key={key} className={styles.localCommand}>
                  {item.content}
                </pre>
              );
            }
            if (item.kind === "session_error") {
              return (
                <div key={key} className={styles.errorItem}>
                  <div>{item.message}</div>
                  {item.errorKind === "auth" ? (
                    <div className={styles.errorHint}>
                      Run <code>claude</code> in a terminal to log in, then start a new chat.
                    </div>
                  ) : null}
                  {item.canRetry && index === lastIndex && !state.working ? (
                    <button type="button" className={styles.retryButton} onClick={retry}>
                      Retry
                    </button>
                  ) : null}
                </div>
              );
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

          {state.draft || state.draftReasoning ? (
            <div className={styles.assistantBubble}>
              {state.draftReasoning ? (
                <ReasoningFold reasoning={state.draftReasoning} hasAnswer={state.draft.length > 0} />
              ) : null}
              {state.draft ? <Markdown>{state.draft}</Markdown> : null}
            </div>
          ) : null}
        </div>
        {!atBottom ? (
          <button type="button" className={styles.jumpButton} onClick={jumpToLatest}>
            Jump to latest
          </button>
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
          {state.usage ? (
            <span
              className={styles.usage}
              title="Tokens used this session (input, cached input, output). Resets when the chat is cleared."
            >
              {formatUsage(state.usage)}
            </span>
          ) : null}
        </div>
        <div className={styles.actions}>
          <label className={styles.modeSelector}>
            Model:
            <select className={styles.modeSelect} value={state.model ?? ""} onChange={changeModel}>
              <option value="">{defaultLabel}</option>
              {MODEL_CHOICES.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
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
          <ToolsPanel clusterId={clusterId} client={client} />
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

      {showShortcuts ? (
        <div className={styles.shortcuts}>
          {shortcuts.map((shortcut, index) => (
            <button
              key={`${index}-${shortcut.title}`}
              type="button"
              className={styles.chip}
              onClick={() => void sendText(shortcut.prompt)}
            >
              {shortcut.title}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.inputRow}>
        <div className={styles.inputWrap}>
          {menuOpen ? <SlashMenu matches={slashMatches} selected={menuSelected} onSelect={completeCommand} /> : null}
          <textarea
            className={styles.input}
            value={input}
            placeholder="Ask about this cluster..."
            onChange={(event) => changeInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
          />
        </div>
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
