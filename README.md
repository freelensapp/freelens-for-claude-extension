# @freelensapp/for-claude-extension

<!-- markdownlint-disable MD013 -->

[![Home](https://img.shields.io/badge/%F0%9F%8F%A0-freelens.app-02a7a0)](https://freelens.app)
[![GitHub](https://img.shields.io/github/stars/freelensapp/freelens?style=flat&label=GitHub%20%E2%AD%90)](https://github.com/freelensapp/freelens)

<!-- markdownlint-enable MD013 -->

## Overview

Freelens for Claude embeds a Claude-powered chat directly in Freelens, with
one conversation per cluster. Claude answers questions about the selected
cluster and can act on it — but only through a set of typed,
permission-gated Kubernetes tools, never through an unrestricted shell.

Unlike
[freelens-ai-extension](https://github.com/freelensapp/freelens-ai-extension),
this extension is a frontend to **your own Claude Code installation**. There
is no provider selection and no API key to store: the extension spawns the
Claude Code binary already installed on your machine and inherits whatever
authentication it uses. Billing is whatever your Claude Code uses — a Claude
subscription or API usage — and the extension never sees your credentials.

This is a community project, not an official Anthropic product. The name
"Freelens for Claude" uses the "Claude" trademark nominatively to describe
what the extension works with; it does not imply endorsement by or
affiliation with Anthropic.

## Requirements

- **Freelens >= 1.10.0.** The extension is developed against
  `@freelensapp/extensions` 1.10.x and its continuous integration installs
  and smoke-tests it against Freelens 1.10.0. Older releases are not
  verified to provide every host API the extension uses.
- **Claude Code installed and logged in.** The extension drives the Claude
  Code binary found on your `PATH` (or at a path you set in preferences).
  Install it and run `claude` once in a terminal to authenticate.
- Every Claude Code authentication method is inherited unchanged —
  subscription login, `ANTHROPIC_API_KEY`, Amazon Bedrock, or Google
  Vertex. The extension never handles or stores credentials.
- **Node.js** is required only when building the extension from source (see
  [Build from the source](#build-from-the-source)); it is not needed to run
  the extension.

## Installation

Once published, install from the Freelens **Extensions** page by npm name:

```text
@freelensapp/for-claude-extension
```

Alternatively, download the `.tgz` from the
[GitHub releases](https://github.com/freelensapp/freelens-for-claude-extension/releases)
page and drag it into the Freelens window, or provide its path on the
Extensions page.

You can also build and pack the extension yourself — see
[Build from the source](#build-from-the-source).

## Getting started

1. Open a cluster in Freelens.
2. Choose **Freelens for Claude** in the cluster's side menu.
3. If Claude Code is not detected, an onboarding panel explains what is
   missing. Install Claude Code and log in, or point the extension at the
   binary with the **Claude Code path** preference, then reopen the page.
4. Send your first message — either a quick-prompt chip (for example
   "Cluster health") or free text.
5. From any resource list you can also right-click a Pod, Deployment,
   DaemonSet, StatefulSet, Service, Node, or Event and choose **Ask
   Claude** to open the chat pre-filled with a prompt about that object.

<!-- TODO(maintainer): add a screenshot of the chat page here (needs a
     running Freelens with a live cluster and an authenticated Claude Code). -->

## Features

### Chat

- Streamed markdown answers with syntax-highlighted code blocks.
- A live **Reasoning** fold that shows Claude's thinking as it streams.
- **Stop** the current turn and **Retry** the last one.
- Per-cluster transcripts that survive restarts, backed by Claude Code
  session resume.
- A token-usage counter (input, cached input, output) for the session.
- Automatic native context compaction, with a notice in the transcript when
  it happens.
- A **model** picker over the Claude Code aliases (`sonnet`, `opus`,
  `haiku`, or the Claude Code default).

### Built-in tools

Claude acts on the cluster only through these typed tools. Read-only tools
run automatically; mutating tools always require your approval.

<!-- markdownlint-disable MD013 -->

| Tool | Type | Purpose |
| --- | --- | --- |
| `freelens_resources` | read-only | List or get resources of any kind (built-in or CRD), YAML with `managedFields` stripped |
| `freelens_pod_logs` | read-only | Fetch a snapshot of a pod's logs, optionally regex-filtered |
| `freelens_warning_events` | read-only | List Warning-type events, most recent first |
| `freelens_cluster_version` | read-only | Report the Kubernetes API server version |
| `freelens_create_resource` | mutating | Create a resource from a full manifest |
| `freelens_update_resource` | mutating | Replace a resource with a full manifest (backup + diff) |
| `freelens_patch_resource` | mutating | Patch a resource, or scale via the `scale` subresource |
| `freelens_delete_resource` | mutating | Delete a resource (normal, force, or finalizer-clearing) |
| `freelens_delete_pod` | mutating | Evict or delete a pod (evict, force, or clear finalizers) |
| `freelens_rollout_restart` | mutating | Roll-restart a Deployment, DaemonSet, or StatefulSet |
| `freelens_kubectl` | mutating | Run `kubectl` against this cluster (argv only, no shell) |
| `freelens_helm` | mutating | Run `helm` against this cluster (argv only, no shell) |

<!-- markdownlint-enable MD013 -->

`freelens_kubectl` and `freelens_helm` receive an argv array only — there is
no shell — and are always pinned to the current cluster's kubeconfig and
context. They are a fallback for actions the dedicated tools do not cover.

### Permissions and safety

- Three per-cluster **modes**, selectable in the chat status strip:
  **Read-only** (mutating tools are refused), **Approve** (the default —
  each mutating call prompts), and **Accept all** (mutations run without a
  prompt). The mode is never persisted; every new session starts from the
  default.
- The approval card shows the proposed manifest as YAML, a backup of the
  current resource, and a diff for updates and patches.
- A preference requires your consent before Claude reads pod logs.
- Claude Code's own shell and filesystem tools (`Bash`, `Edit`, `Write`, …)
  are disabled — the cluster is reachable only through the typed tools
  above.

### Slash commands and shortcuts

- `/` autocomplete over your Claude Code commands, with local command output
  shown in the transcript. `/clear` maps to starting a new chat.
- Quick-prompt chips above the input: built-in shortcuts plus any you define
  in preferences.

### Cluster analyzer subagent

For broad investigations Claude can delegate to a read-only
`cluster-analyzer` subagent. Its nested tool calls are visible in the
transcript and remain permission-gated. The subagent can be turned off in
preferences.

### User MCP servers

Opt in to your own MCP servers with Claude-Desktop-style JSON. They are
additive to the built-in tools, and every external tool call requires
approval. The **Available Tools** panel lists everything currently
connected — built-in tools and each MCP server.

## Preferences reference

All settings live on the **Freelens for Claude** preferences page. Except
where noted, changes apply to the next new chat.

<!-- markdownlint-disable MD013 -->

| Preference | Default | Meaning |
| --- | --- | --- |
| Require approval to read pod logs | on | Prompt before `freelens_pod_logs` runs |
| Pod logs tail lines | 1000 | Lines read from the end of a log when Claude does not request an amount |
| Custom agent rules | empty | Extra rules appended to the system prompt of every new session |
| Claude Code path | empty (auto-detect) | Absolute path to the `claude` binary |
| Default model | empty (Claude Code default) | Model alias for clusters that have not picked one |
| Enable MCP servers | off | Start your MCP servers alongside the built-in tools |
| MCP configuration | empty `mcpServers` | Claude-Desktop-style JSON, applied at the next new session |
| Analysis subagent | on | Allow delegation to the read-only `cluster-analyzer` subagent |
| Prompt shortcuts | `[]` | JSON array of `{ "title", "prompt" }` rendered as quick-prompt chips |

<!-- markdownlint-enable MD013 -->

## Security model

- The bridge between the renderer and the agent runtime binds to
  `127.0.0.1` only and requires a per-launch random bearer token on every
  request.
- The extension stores no credentials and never talks to Anthropic itself —
  all model traffic goes through your own Claude Code session.
- `settingSources: []` and `strictMcpConfig` keep your global Claude Code
  configuration (global `CLAUDE.md`, hooks, MCP config) out of cluster
  chats.
- The permission broker is the single gate for every mutating,
  consent-gated, and external tool call.
- `kubectl`/`helm` argv is validated: `--kubeconfig`, `--context`, and
  `--kube-context` are rejected, and cluster targeting is injected by the
  extension so those tools cannot be pointed at another cluster.

## Privacy

Whatever the tools return — resource YAML, pod logs, warning events —
becomes part of the conversation sent to Anthropic through your own Claude
Code session, under your own plan and Anthropic's terms. Treat the chat like
pasting `kubectl` output into Claude: do not share anything you would not
otherwise send.

## Troubleshooting

- **Claude Code not detected.** Ensure the `claude` binary is on the `PATH`
  Freelens sees, or set an absolute path in the **Claude Code path**
  preference, then reopen the chat page.
- **Not logged in.** Run `claude` in a terminal and complete
  authentication; the extension inherits that session.
- **Where transcripts live.** Each cluster gets its own scratch directory
  under the extension's data path; Claude Code session transcripts are kept
  there, namespaced per cluster.
- **Where errors appear.** Main-process errors print to the terminal that
  launched Freelens; renderer errors appear in the Freelens DevTools
  console.

## Build from the source

You can build the extension from this repository.

### Prerequisites

Use [NVM](https://github.com/nvm-sh/nvm),
[mise-en-place](https://mise.jdx.dev/), or
[windows-nvm](https://github.com/coreybutler/nvm-windows) to install the
required Node.js version.

From the root of this repository:

```sh
nvm install
# or
mise install
```

Install pnpm:

```sh
corepack install
# or
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

### Build extension

```sh
pnpm i
pnpm build
pnpm pack
```

One script to build and pack the extension for testing:

```sh
pnpm pack:dev
```

### Install built extension

The tarball will be placed in the current directory. In Freelens, navigate
to the Extensions page and provide the path to the tarball, or drag and
drop the `.tgz` file into the Freelens window.

### Check code statically

```sh
pnpm lint:check
```

or

```sh
pnpm trunk:check
```

and

```sh
pnpm build
pnpm knip:check
```

## License

Copyright (c) 2025-2026 Freelens Authors.

[MIT License](https://opensource.org/licenses/MIT)
