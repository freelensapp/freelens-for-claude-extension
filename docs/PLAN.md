# Implementation Plan: Freelens for Claude

Status: **approved** — all open questions were resolved by the maintainer in
issue [#7](https://github.com/freelensapp/freelens-for-claude-extension/issues/7);
see [Resolved questions](#resolved-questions) at the end of this document.
**M0, M1 and M2 are delivered** and confirmed working by the maintainer.
Next step: implement **M3** as specified in [M3.md](./M3.md).

Process note: planning and analysis run on issues (Fable model);
implementation runs on pull requests (Opus model).

## Goal

A Freelens extension that embeds a Claude-powered chat directly in the
Freelens UI (comparable to the Claude Code extension for VS Code), with a
feature set close to
[freelens-ai-extension](https://github.com/freelensapp/freelens-ai-extension):

- chat presented inside Freelens, one conversation context per cluster,
- Kubernetes tools the model can call, executed through Freelens/cluster APIs,
- human-in-the-loop approval before mutating operations,
- persistent transcripts across restarts.

The single deliberate difference from the original AI extension: this tool is
dedicated to the **Claude Code subscription** model. There is no provider
selection, no API key management, no pay-as-you-go cost machinery. The
extension is a frontend to the user's own Claude Code installation.

This document collects the technical decisions for approval, following the
analysis in
[freelens-ai-extension#262](https://github.com/freelensapp/freelens-ai-extension/issues/262)
(Option B: a new, dedicated extension).

## Technical decisions

### D1. Agent runtime: Claude Agent SDK driving the user's Claude Code

Use [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/typescript)
(TypeScript) in the extension **main process**. The SDK spawns Claude Code as
a subprocess and speaks its headless streaming-JSON protocol, exposing exactly
the primitives this extension needs: streaming input/output, a `canUseTool`
permission callback, in-process MCP tool servers, `resume` for session
persistence, `model` selection, `settingSources` isolation, and
`allowedTools`/`disallowedTools`.

Point `pathToClaudeCodeExecutable` at the **user's own Claude Code
installation** (detected on PATH and in well-known install locations), not at
any copy shipped with the extension. The extension therefore:

- never touches, stores, or proxies credentials — authentication is whatever
  the user configured in their own Claude Code (subscription login or API
  key),
- inherits the user's Claude Code version and entitlements,
- degrades to a clear onboarding screen when Claude Code is missing or not
  logged in.

Rejected alternatives:

- **LangChain/LangGraph or Vercel AI SDK calling a model API** — the
  architecture of the original extension. Per the analysis in issue #262,
  neither unlocks subscription billing, and both require owning the whole
  agent loop (supervisor, interrupts, checkpointing, compaction) that Claude
  Code already provides.
- **opencode (multi-provider OAuth runtimes)** — a good fit for evolving the
  original AI extension, but out of scope here: this extension is Claude-only
  by design.
- **Extracting OAuth tokens from Claude Code and calling the Anthropic API
  directly** — non-compliant and fragile; explicitly avoided.

### D2. Authentication and terms-of-service posture (approved)

The extension performs **no authentication at all**. Requirements at runtime:
Claude Code installed and logged in by the user. An onboarding panel detects
the binary and reports auth status, directing the user to run `claude` in a
terminal otherwise.

Candid risk statement: Anthropic's Agent SDK documentation says third-party
developers may not "offer claude.ai login or rate limits for their products"
without prior approval, and directs SDK users to API-key authentication
([overview](https://code.claude.com/docs/en/agent-sdk/overview)). This
extension's design mitigates that concern — it never offers a login, never
handles tokens, and only fronts the user's own genuine Claude Code install
(the same posture as terminal multiplexers or editors that shell out to
`claude`) — but it remains a gray zone. Proposed handling:

1. Build it as designed (frontend to the user's Claude Code).
2. The same code path works unchanged when the user's Claude Code is
   authenticated with an API key (`ANTHROPIC_API_KEY`), Bedrock, or Vertex,
   so nothing about the extension is subscription-*locked* — it is merely
   subscription-*friendly*.
3. Contact Anthropic before announcing/publishing to the marketplace to
   confirm the posture is acceptable.

Maintainer decision: approved. The usage is legitimate — the extension uses
the official SDK as intended and does not abuse it. This is a
proof-of-concept project that will not be announced until finished, legal
review included.

### D3. Process placement and transport: local HTTP server with SSE

The agent runtime lives in the extension **main process** (Node.js). The
renderer chat UI communicates with it over a **local HTTP server**, not
Electron IPC — the same pattern as `ai-proxy-server.ts` in the original
extension, and the stated preference in issue #7:

- plain `node:http`, no web framework, bound to `127.0.0.1` on an ephemeral
  port,
- a per-launch random bearer token required on every request,
- CORS restricted by reflecting the renderer origin (as in the original),
- **SSE** (`text/event-stream`) for streaming session events to the UI;
  plain JSON `POST` for commands.

Port and token are handed to the renderer through an `ExtensionStore`
(Freelens syncs store state between main and renderer automatically) — again
the original extension's mechanism (`PreferencesStore.aiProxyPort/aiProxyToken`).

Endpoint sketch:

| Endpoint | Purpose |
| --- | --- |
| `GET /status` | Claude Code detected? version? authenticated? |
| `GET /clusters/:id/events` (SSE) | assistant deltas, tool calls/results, permission requests, usage, errors |
| `POST /clusters/:id/messages` | send a user message (starts or continues the session) |
| `POST /clusters/:id/interrupt` | stop the current turn |
| `POST /permissions/:requestId` | resolve a permission request (allow / deny / allow with edited input) |
| `DELETE /clusters/:id/session` | new conversation for the cluster |

### D4. Kubernetes tools: in-process MCP server in the main process

Reimplement the original extension's Kubernetes tool set as an **in-process
SDK MCP server** (`createSdkMcpServer` + `tool()` with zod schemas). The MCP
server is registered where the Claude Agent SDK `query()` runs — the
extension main process — and is the integration point regardless of where a
tool's Kubernetes work is ultimately performed.

Cluster access — two viable paths, both retained as legitimate designs:

1. **Main-process client from kubeconfig.** Build `@kubernetes/client-node`
   clients from the target cluster's `kubeconfigPath` + `kubeconfigContext`,
   available on the `KubernetesCluster` catalog entity in the main process.
   This keeps tools working independent of renderer page lifecycle and gives
   per-cluster isolation for free (one MCP server instance bound per cluster
   session). It is the simplest path for M0's read-only tools.
2. **Bridge to the renderer's `Renderer.K8sApi`.** A tool call in the main
   process delegates to the renderer, which executes it through
   `Renderer.K8sApi` (the original extension's approach). This is **not
   rejected** — it is a natural way to expose Freelens' own cluster context
   to the extension: requests flow through Freelens' kube-proxy and cluster
   connection management, inheriting exec-plugin auth, port-forward/proxy
   handling, resource stores, and watch caches that a raw client rebuilt
   from a kubeconfig path would have to reimplement. Its cost is coupling to
   an open cluster frame and an extra main<->renderer round-trip.

The two are not exclusive: the MCP server can resolve each tool against
either backend. M0 uses path 1 for its three read-only tools (no dependence
on an open page); path 2 is the preferred way to reach Freelens context
where that context matters (e.g. respecting the user's active proxy settings
or reusing already-watched resource stores), and is expected to carry tools
introduced in later milestones. The choice is per-tool, decided by whether a
tool needs Freelens' connection context or must survive page navigation.

Tool parity target (mirrors the original 12):

- list / get / create / update / patch / delete any resource (built-in kinds
  and CRDs), with `metadata.managedFields` stripped by default and JSONPath
  field selectors for focused output,
- pod log snapshots with regex filtering,
- scale (replicas) and rollout restart,
- graceful eviction respecting PodDisruptionBudgets, force delete, clear
  finalizers,
- cluster version, warning-events analysis.

Claude Code built-in tools policy (safety default):

- `disallowedTools` for filesystem and shell tools (`Bash`, `Edit`, `Write`,
  ...) — the model acts on the cluster only through our typed MCP tools,
- `settingSources: []` so the user's global `CLAUDE.md`, hooks, and MCP
  config do not leak into cluster chats,
- `cwd` pinned to a per-cluster scratch directory under the extension's data
  path (this also namespaces Claude Code's own session transcripts per
  cluster).

Instead of ever enabling the built-in `Bash` tool, a later milestone adds a
dedicated **Kubectl tool** that runs `kubectl` through Freelens' own terminal
(visible to the user, using the cluster's kubeconfig). Maintainer decision:
built-in `Bash`/filesystem tools stay disallowed; the Kubectl-via-Freelens-
terminal tool is deferred (skipped for now).

### D5. Sessions and persistence: one Claude Code session per cluster

- One session per cluster, keyed by cluster id; the per-cluster `cwd` (D4)
  keeps Claude Code transcripts separated on disk.
- Session ids are persisted and passed as `resume` after an app restart, so
  conversation context survives restarts natively — this replaces the
  original's `PersistentMemorySaver`/checkpoint serialization entirely.
- A `ChatSessionStore` (ExtensionStore, persisted by the main process) keeps
  the rendered transcript per cluster for instant UI restore, plus the
  cluster-to-session-id mapping.
- Context compaction: **native** Claude Code auto-compaction; the original's
  custom session-compaction service is dropped.

### D6. Human-in-the-loop approvals

The SDK `canUseTool` callback is the single approval gate:

- main process emits a `permission_request` SSE event (tool name, input
  rendered as YAML, and a diff for update/patch operations),
- renderer shows the approval dialog (parity with the original's interrupt
  UI), user allows / denies / edits,
- response resolves the callback (`updatedInput` supported).

Read-only tools are auto-allowed; mutating tools always prompt (later: a
per-cluster "always allow" list). `permissionMode` (default / plan /
acceptEdits) is exposed in preferences; the PoC ships with read-only tools
only, so approvals arrive in the first parity milestone.

### D7. UI: per-cluster chat page in the renderer

- Registered via `clusterPages` + `clusterPageMenus` ("Freelens for Claude"
  entry with icon), which gives a page instance per cluster frame — matching
  the per-cluster context model. The name "Freelens for Claude" is the
  maintainer's decision: the "for Claude" form uses the trademark
  nominatively without implying an official Anthropic tool.
- Components (largely mirroring the original's component set): chat view,
  message bubbles, markdown viewer (`react-markdown` + `remark-gfm`), code
  blocks with copy action (no Monaco initially, to keep the bundle small),
  tool-call cards (collapsed input/output), permission dialog, status strip
  (model, token usage, working indicator, stop button), onboarding panel
  (Claude Code missing / not logged in), new-chat and retry actions.
- React 17 + MobX from host globals, SCSS modules — the stack this repo
  already builds.
- Later parity item: an "Ask Claude" context action on Kubernetes resources
  that opens the chat pre-filled with the selected object (the original's
  `ai-analysis-service`).

### D8. Model selection and usage display

- Model picker limited to Claude Code aliases (default, sonnet, opus, haiku)
  via the SDK `model` option.
- Show per-turn token usage from result messages.
- Deliberately **no USD cost display**: cost estimation, the LiteLLM price
  list, and the token-price machinery of the original are meaningless under
  subscription billing and are dropped.

### D9. Tech stack

Keep this repository's existing scaffolding: TypeScript 5.9, electron-vite,
pnpm 10, Biome + Trunk, Vitest, `@freelensapp/extensions` with host-provided
globals (React 17, MobX).

New bundled runtime dependencies:

| Dependency | Purpose |
| --- | --- |
| `@anthropic-ai/claude-agent-sdk` | agent runtime (spawns user's Claude Code) |
| `zod` | MCP tool input schemas |
| `@kubernetes/client-node` | cluster access for tools (main process) |
| `react-markdown`, `remark-gfm` | chat markdown rendering |

Not used: LangChain, LangGraph, Vercel AI SDK, OpenAI SDK.

### D10. Original features intentionally dropped

| Original feature | Why dropped |
| --- | --- |
| Provider/model/API-key preferences | single runtime, auth owned by Claude Code |
| Local AI proxy with key injection | no keys to inject; HTTP server remains but serves the chat bridge instead |
| LiteLLM price list, cost display | subscription billing |
| Token estimation, offline tiktoken patch | usage comes from SDK result messages |
| DeepSeek DSML recovery heuristics | Claude-only |
| LangGraph supervisor and sub-agents | Claude Code's own agent loop (and, later, its subagents feature) |
| Custom compaction service | native auto-compaction |

## Feature parity matrix

| freelens-ai-extension feature | This extension |
| --- | --- |
| Chat in Freelens, markdown + code blocks | Yes (D7) |
| Per-cluster conversation context | Yes — session per cluster (D5) |
| Persistent transcripts across restarts | Yes — `resume` + ChatSessionStore (D5) |
| Kubernetes tools (12 ops) | Yes — in-process MCP tools (D4) |
| Approval gate before mutations, YAML preview | Yes — `canUseTool` (D6) |
| Automatic context compaction | Yes — native (D5) |
| Token counter | Yes; cost display dropped (D8) |
| Retry on failure | Yes (D7) |
| Explain/analyze resource from context menu | Later milestone (D7) |
| MCP servers configured by the user | M3 — opt-in passthrough |
| Multiple AI providers / API keys | Intentionally out of scope |

## Milestones

**M0 — proof of concept (delivered).** Claude Code detection + onboarding panel; HTTP/SSE
bridge; minimal chat page for the active cluster; three read-only MCP tools
(list/get resources, pod logs, warning events); built-in tools disallowed.
Success criterion: with a subscription-authenticated Claude Code, ask "what
pods are failing in this cluster and why?" and get an answer grounded in tool
calls. Detailed implementation specification: [M0.md](./M0.md).

**M1 — tool and safety parity (delivered).** Full 12-tool set, approval
dialog with YAML diff, permission modes, session persistence and resume,
per-cluster session management (new chat, stop — delivered in M0). Detailed
implementation specification: [M1.md](./M1.md).

**M2 — UX parity (delivered).** Usage display, retry, model picker,
tool-call cards, "Ask Claude" on resources, preferences page. Detailed
implementation specification: [M2.md](./M2.md).

**M3 — beyond parity.** User MCP-server passthrough, Claude Code subagents
for analysis workflows, prompt shortcuts/slash commands, Kubectl tool running
through Freelens' terminal (D4), plus the Available Tools panel and reasoning
fold deferred from M2. Detailed implementation specification:
[M3.md](./M3.md).

## Resolved questions

All four open questions were answered by the maintainer in issue #7:

1. **D2 posture** — approved. The usage is legitimate (official SDK, used as
   intended, not abused). This is a proof-of-concept project that will not be
   announced until finished, including legal review.
2. **D4 safety default** — approved. Built-in `Bash`/filesystem tools stay
   disallowed. Instead of `Bash`, a dedicated Kubectl tool using Freelens'
   terminal will be provided in a later milestone; skipped for now.
3. **M0 scope** — approved. Read-only tools only for the PoC; any action that
   would require prompts/approvals is skipped in M0.
4. **Naming** — "Freelens for Claude", to avoid trademark issues: the
   "for Claude" form uses the trademark without implying an official
   Anthropic tool.
5. **D4 tool execution** — clarified. Bridging tool calls to the renderer's
   `Renderer.K8sApi` is **not** rejected; it is a natural way to expose
   Freelens' cluster context to the extension and is retained as a
   first-class option alongside the main-process kubeconfig client. M0 keeps
   the main-process client for its read-only tools; the renderer bridge is
   preferred where Freelens connection context matters and is expected in
   later milestones.
