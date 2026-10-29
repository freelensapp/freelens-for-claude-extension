# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

> **Tip**: If you find yourself correcting the agent during interactive work, suggest adding a new rule to this file so the lesson is captured for future sessions.

## Project Overview

This repository is Freelens for Claude, a Freelens extension that embeds a
Claude-powered chat per cluster and drives the user's own Claude Code
installation with permission-gated Kubernetes tools. Its build, type-check and
test setup follows freelensapp/freelens-example-extension, the template for
Freelens extensions; this file describes that setup as it applies here, with
the reason for each rule, and what is specific to this extension (a bundled
Node stack in main, an HTTP bridge between the processes).

- **Language**: TypeScript 7.x
- **Runtime**: Freelens >= 2.0.0 (extension API v2)
- **Toolchain**: Node.js 24.x, yq 4.x and cosign 3.x (`mise.toml` with
  `mise.lock`; Node also in `.nvmrc`)
- **Package manager**: pnpm 12.x (`packageManager`, run through corepack)
- **License**: MIT

Library and tool versions follow the Freelens stack exactly: the catalog in
Freelens's `pnpm-workspace.yaml` for libraries (a library the extension uses
that is in the catalog, such as `zod`, takes the
catalog version), the root `package.json` scripts of Freelens for tools run
with `pnpm dlx` (Biome, knip, Trunk launcher), and Freelens's `mise.toml` and
`.nvmrc` for Node and the other mise tools. Renovate keeps them there: custom
datasources in `.renovaterc.json` read the versions from the same Freelens
files on `main`, so an update arrives only once Freelens has adopted it, at
that version, in one `Freelens dependencies` group PR together with a
release of `@freelensapp/extensions`. A dependency added to `package.json` follows
the Freelens catalog unless the catalog rule excludes it with `!`; one that
Freelens does not have must be excluded there, or its lookup fails on the
Dependency Dashboard. The bundled libraries that are not in the catalog
(`@anthropic-ai/claude-agent-sdk`, `diff`, `react-markdown`, `remark-gfm`,
`yaml`) are excluded and updated from the npm registry as usual.
pnpm is updated from the npm registry too, in a pull request of its own:
`packageManager` carries a Corepack hash, which Renovate updates only from the
digest of the new version, and a custom datasource has none. `mise.lock` pins a
checksum and a URL per tool for every platform; after changing `mise.toml`,
run `mise lock`. It is lockfile revision 3, which needs mise 2026.9.16 or
newer. `@freelensapp/extensions` is pinned to one exact version. The libraries the
host provides at runtime (`react`, `react-dom`, `mobx`, `mobx-react`,
`monaco-editor`) and their types are devDependencies only, for compiling and
testing; `electron` is a devDependency for its types only. `monaco-editor` is
declared although nothing imports it: `Renderer.Component.MonacoEditor` takes
its `options` type from it, and without it they are `any`. The libraries the
extension bundles (`@anthropic-ai/claude-agent-sdk`, `diff`, `react-markdown`,
`remark-gfm`, `yaml`, `zod`) are devDependencies too:
the host installs no dependencies of an extension, so they reach it only
through the bundle.

pnpm settings live in `pnpm-workspace.yaml`. A dependency runs its install
scripts only when `allowBuilds` sets it to `true`; a new dependency with
install scripts that is not listed there fails `pnpm install`, so add it with
`true` or `false` deliberately. pnpm refuses versions younger than its
`minimumReleaseAge` (1 day), with `@freelensapp/extensions` excluded because
a Freelens release is adopted on the day it is published, together with the
stack it was built with.
`strictPeerDependencies: true` makes `pnpm install` fail when the extension's
own copy of a library it shares with the host is outside the peer range that
`@freelensapp/extensions` declares for it (`react`, `react-dom`,
`@types/react`, `@types/react-dom`, `mobx`, `mobx-react`, `monaco-editor`,
`electron`).

## Common Commands

```bash
# Type checking
pnpm type:check                # All of the programs below, in this order
pnpm type:check:sources        # main and renderer, each with src/common/
pnpm type:check:tests          # Tests and test support
pnpm type:check:tooling        # Vite and Vitest configs, build plugins
pnpm type:check:integration    # Integration tests
pnpm type:check:environments   # Environment tests

# Linting & formatting
pnpm biome:check          # TypeScript/TSX, JS, JSON, CSS, SCSS, HTML, YAML, Markdown (biome)
pnpm biome:fix            # Auto-fix the formats above
pnpm trunk:check          # TOML, shell, workflows, yamllint, and Biome again (changed files)
pnpm trunk:fix            # Auto-fix TOML, shell, and the Biome formats
pnpm lint:check           # Alias for biome:check
pnpm lint:fix             # Alias for biome:fix
pnpm knip:check           # Unused files, unused and unlisted dependencies (knip)

# Tests
pnpm test:unit            # vitest
pnpm test:integration     # vitest, against Freelens dev with a kind cluster

# Build
pnpm build                # Both Vite runs, without the type check
pnpm dev                  # Both Vite runs in watch mode, for a directory install

# Pack for testing
pnpm pack:dev             # Bump prerelease version, build, and create .tgz for install in Freelens app

# Clean
pnpm clean                # Clean dist/
pnpm clean:dts            # Remove generated *.d.scss.ts files
pnpm clean:all            # Clean everything (dist, dts, node_modules, tgz)
```

## Architecture

The extension embeds a Claude-powered chat in Freelens. The main process runs
the Claude Agent SDK (which spawns the user's own Claude Code) and exposes a
local HTTP/SSE bridge; the renderer is a per-cluster chat page.

```text
src/
  common/
    bridge-store.ts        # ExtensionStore: bridge port synced main -> renderer (token always empty); IPC channel + BridgeConnection type
    session-store.ts       # ChatSessionStore: per-cluster sessionId + permission mode + model
    preferences-store.ts   # PreferencesStore: pod logs, agent rules, path override, default model, MCP config, subagents, prompt shortcuts
    prompt-shortcuts.ts    # built-in quick-prompt chips + parser for the promptShortcuts preference (renderer-free)
    protocol.ts            # shared request/response and SSE event types (usage, context, compaction, model, retry, thinking, local command output, tool_progress, tool result outcome, turn_stopped, parentCallId, mcp/slash meta); ClusterUsageResponse (/usage dialog data), ClusterContextResponse (/context donut data)
  main/
    index.ts               # onActivate: start bridge + stores (incl. preferences); onDeactivate: stop it
    claude/
      detect.ts            # locate Claude Code binary (or validate an explicit path override), read version
      session-manager.ts   # session lifecycle (one shared start for concurrent callers), resume, transcript, usage/context/compaction, model, retry, pod-logs gating, user MCP + subagent wiring, thinking + local-command + nested tool events, tool result outcome (denied by toolUseID, interrupted by open calls at Stop), turn_stopped for a turn the user stopped
      context.ts           # buildContextResponse: shape SDK getContextUsage() into ClusterContextResponse (drops free-space category)
      permission-broker.ts # permission modes + approval request/resolve (mutating + consent-required reads + external MCP tools); pending approvals resolved as stopped on Stop
      preparation-progress.ts # kubectl preparation of a kubectl/helm call -> tool_progress events (250 ms throttle, stop on interrupt, replay)
      mcp-config.ts        # parse/validate Claude-Desktop-style user MCP JSON into SDK server configs (never throws)
      subagents.ts         # cluster-analyzer definition: read-only investigator subagent
      usage.ts             # buildUsageResponse: shape SDK accountInfo + /usage data into ClusterUsageResponse
      user-settings.ts     # read the user's Claude Code settings.json ($CLAUDE_CONFIG_DIR or ~/.claude) at each session start: provider/auth keys for the SDK settings option, model default (never throws, never logs values)
    bridge/
      server.ts            # node:http server, routing, bearer auth (constant time), Host check, CORS for cluster frames, SSE, permission/model/retry/usage/context routes
      frame-origin.ts      # isClusterFrameOrigin: the origins the bridge serves
      ipc.ts               # BridgeIpc (Main.Ipc): hands port + token to cluster frames only, by senderFrame.origin
    tools/
      kube-client.ts       # requests through Main.K8sApi.KubeJsonApi.forCluster (Freelens proxy): discovery, timeout, Error conversion, connected check
      kube-format.ts       # YAML, managedFields stripping, truncation, selectFields, toDiff
      mcp-server.ts        # createSdkMcpServer; read-only vs mutating tool name sets (freelens_ prefix, incl. kubectl/helm); pod-logs tail-lines getter; tool_use id from the request's _meta; guard flags a thrown error isError
      approval.ts          # describeApproval: action title + backup target (incl. READ POD LOGS, RUN KUBECTL, RUN HELM, USE MCP TOOL)
      cli-exec.ts          # shared spawn helper: kubectl/helm and their environment from Main.Shell for the cluster (download progress to the log and the call's preparation report, problems to the result), timeout after preparation, non-tty capture, process registry
      resources.ts         # freelens_resources tool (field selection, managedFields opt-in)
      pod-logs.ts          # freelens_pod_logs tool (previous, timestamps, configurable tail-lines default)
      warning-events.ts    # freelens_warning_events tool
      cluster-version.ts   # freelens_cluster_version tool
      create-resource.ts   # freelens_create_resource tool
      update-resource.ts   # freelens_update_resource tool (backup + diff)
      patch-resource.ts    # freelens_patch_resource tool (incl. scale subresource)
      delete-resource.ts   # freelens_delete_resource tool (delete / force / finalize)
      delete-pod.ts        # freelens_delete_pod tool (evict / force / finalizers)
      rollout-restart.ts   # freelens_rollout_restart tool (Deployment/DaemonSet/StatefulSet)
      kubectl.ts           # freelens_kubectl tool (argv contract, the cluster terminal's kubectl, spawned via cli-exec)
      helm.ts              # freelens_helm tool (argv contract, the cluster terminal's helm, spawned via cli-exec)
  renderer/
    index.tsx              # clusterPages, clusterPageMenus, appPreferences, kubeObjectMenuItems (menuItemFor)
    api/
      bridge-client.ts     # fetch wrapper + SSE reader; token from BridgeIpc once per port, in memory; resolvePermission, setPermissionMode, setModel, retry, getUsage, getContext
      bridge-ipc.ts        # BridgeIpc (Renderer.Ipc): asks main for the bridge connection
      pending-prompt.ts    # module-scoped handoff between "Ask Claude" menu entries and the chat page
    components/
      chat-page.tsx        # page (observer of BridgeStore): onboarding gate or chat view
      chat-view.tsx        # observer of PreferencesStore: transcript + input + status strip (context donut / token counter, model + mode selectors, model catalog fetched again while missing, retry, Stopped line, slash popup, shortcut chips, reasoning fold, nested tool cards, command menu)
      context-donut.tsx    # composer status-strip ring showing context-window usage %; tooltip = token counts, click opens the details modal
      context-dialog.tsx   # Context usage modal (/context): model, occupancy bar, per-category token breakdown
      context-colors.ts    # categoryColor: color of a context category (SDK color, name palette, per-index fallback)
      model-dialog.tsx     # "Switch model" modal: Default row, live model catalog, custom model id
      effort-dialog.tsx    # "Effort" modal: Default row and the reasoning-effort levels
      tool-card.tsx        # collapsible tool call/result card; outcome icon (red card for an error, neutral denied/stopped, text fallback for old transcripts); kubectl preparation line of kubectl/helm calls (LineProgress, bytesToUnits)
      permission-dialog.tsx # inline approval card (proposed YAML, backup, diff; Approved / Denied / neutral Stopped)
      code-viewer.tsx      # read-only code block in the host's MonacoEditor, with language label and copy button
      menu-entry.tsx       # "Ask Claude" kube object menu item, generic over the host's model class
      preferences.tsx      # preferences page body + hint (incl. MCP switch/textarea, subagent toggle, shortcuts textarea)
      markdown.tsx         # react-markdown wrapper (code blocks, links)
      onboarding.tsx       # Claude Code missing / not detected panel
      slash-menu.tsx       # slash-command autocomplete popup shown above the input
      command-menu.tsx     # "[/]" composer widget popover (Context group + Slash Commands list)
      usage-dialog.tsx     # Account & Usage modal (/usage): account, plan rate-limit windows, contributing breakdown
      *.module.scss        # component styles (SCSS modules)
    icons/
      claude-icon.tsx      # cluster page menu icon
```

Outside `src/`:

```text
build/                      # Vite plugins: host modules, standard decorators, CSS module declarations, bundled package list
environment-tests/          # probes that prove each program has only its runtime's APIs ("Environment tests")
test/freelens-extensions.ts # runtime stub of @freelensapp/extensions for the unit tests ("Tests and tooling")
integration/__tests__/      # integration tests, run against Freelens dev over CDP, and their shared module
integration/fixtures/       # test objects of the integration tests: a namespace, a Deployment and a Service
docs/RELEASE.md             # how a release is cut
```

Build output goes to `dist/`: `main.js`, `renderer.js` and `renderer.css`,
with source maps. `main` and `renderer` in `package.json` point at the two
entries. The Agent SDK is bundled but must only be imported from
`src/main/**` (never the renderer).

The Kubernetes tools send their requests through
`Main.K8sApi.KubeJsonApi.forCluster(clusterId)` (`kube-client.ts`), so they go
through the Freelens proxy and the cluster's `freelens-k8s-proxy`, with the
kubeconfig's authentication and the cluster's proxy setting, as the rest of
Freelens does; a cluster that is not connected in Freelens is refused.
`freelens_kubectl` and `freelens_helm` spawn the kubectl and helm the cluster
terminal runs, from `Main.Shell.getKubectlPath` and `getHelmPath`, in the
environment of `Main.Shell.getEnvironment`, whose `KUBECONFIG` reaches the
cluster through the Freelens proxy too, so they pass no `--kubeconfig` or
`--context`. They refuse a disconnected cluster with the message of the other
tools (`KubeClient.ensureConnected`) before they ask the host.

Every session starts with `settingSources: []`, the SDK's isolation mode:
Claude Code loads no settings file, so the user's `permissions` (an allow
rule for `mcp__freelens-kube__*` would bypass the approval gate), hooks,
plugins and MCP servers stay out of the chat. That also drops the keys that
select the API provider and authenticate to it, and a user on Bedrock,
Vertex, Claude Platform on AWS, Foundry or a gateway, who has no claude.ai
login, would get "Not logged in". `user-settings.ts` reads the user settings
file of Claude Code (`settings.json` in `$CLAUDE_CONFIG_DIR`, else
`~/.claude`) at each session start and passes back only `env`,
`modelOverrides` and the credential helpers (`apiKeyHelper`,
`awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
`proxyAuthHelper`) through the SDK's `settings` option; its `model` is the
model of a chat with none selected, after the chat's selector and the
default model preference. Do not switch to `settingSources: ["user"]`, and
add a key to the allowlist only when it concerns nothing but the provider
and its authentication. A missing file gives nothing; an unreadable or
invalid one gives nothing and logs one warning. Never log the file's values:
`env` carries tokens and keys, and the JSON parser's message quotes the
text around the error.

The extension presents no custom resource, so `customResources` of the
renderer extension stays empty, and it defines no KubeObject model of its own:
the "Ask Claude" items use the host's model classes.

The renderer talks to main over HTTP: `bridge-client.ts` calls
`http://127.0.0.1:<port>` with plain `fetch`, a random bearer token in every
request, and reads the event stream as SSE. IPC carries short
request/response exchanges only, such as the connection handoff below; the
chat traffic stays on HTTP and SSE. The extension API has no send to a single
frame: `Ipc.broadcast` reaches every frame of every window, so a session's
events would reach the frames of other clusters, while an HTTP request gives
each frame a stream of its own. Main writes only the bridge's
port to `BridgeStore`, which the host syncs to every frame and also saves to
`bridge-store.json`; a new port tells the chat that a new bridge is up. The
token is never in a store: the client asks main for the port and the token
over IPC (`BRIDGE_CONNECTION_CHANNEL`, `bridge/ipc.ts` and
`api/bridge-ipc.ts`), once per port, and keeps them in the client object.
Main answers only a frame whose `senderFrame.origin` is a cluster frame, and
`null` to the root frame and any other. That keeps the token out of the
frames that never call the bridge; it is not a boundary between extensions.
Freelens runs every frame with Node integration, so any code in a cluster
frame can ask over the same channel, and any extension can reach the cluster
without the bridge. The guards of the bridge are aimed at what runs outside
Freelens: web pages in a browser, and the store file on disk. The store's
model keeps a `token` key that is always empty: the
host saves each key of the model and never deletes one, so the empty value
is what overwrites the token an older version saved. Do not drop the key.

The host's Content Security Policy has no `connect-src`, and the bridge
allows CORS for the origin of a cluster frame
(`https://<clusterId>.renderer.freelens.app:<port>`, `frame-origin.ts`) and
for no other: a request with another `Origin`, the root frame's included,
and a preflight without one get a 403, as does a request whose `Host` is
not `127.0.0.1:<port>` (DNS rebinding). A request without `Origin` is not
from a page and still needs the token, which is compared in constant time.
Main stops the bridge in `onDeactivate`, and the host removes the IPC
handler, so a reload of the extension starts a new bridge with a new port
and token. The host removes the handler only once `onDeactivate` returns, and
the next activation fails to register it until then, so deactivation must
not wait on anything that can stay open: the bridge drops its open
connections (an open chat's event stream never ends on its own), and
`disposeAll` waits for the sessions at most `DISPOSE_ALL_TIMEOUT_MS`. The client asks for the token again when the port in
`BridgeStore` changes, after a failed IPC call and after a 401, so the next
request goes to the new bridge.

## Renderer Components

- A component that reads a store while it renders is an `observer` from `mobx-react`, which the build maps to the
  host's copy. The host syncs the stores between main, the root frame and each cluster frame, possibly after the
  component has rendered: `ChatPage` reads the bridge port from `BridgeStore` and asks for the status again once it
  arrives, and `ChatView` reads the prompt shortcuts from `PreferencesStore`. A component that is not an
  observer keeps what it read first until something else renders it again.
- The one cluster page is registered as `Page: () => <ChatPage />`; the host renders a cluster page with `params`
  only, and `ChatPage` takes the cluster from `Renderer.Catalog.getActiveCluster()`.
- The host renders under `React.StrictMode`, so in Freelens dev every effect runs, is cleaned up and runs again on
  mount. An effect that starts a request or a stream cleans it up, or drops its answer, so that the second run is the
  one that counts; do not try to skip the second run.
- The "Ask Claude" items in `kubeObjectMenuItems` are made by `Renderer.K8sApi.menuItemFor(Pod, { MenuItem })` with the
  host's model classes (`KubeEvent`, `Pod`, `Deployment`, `DaemonSet`, `StatefulSet`, `Service`, `Node`), not written
  out with `kind` and `apiVersions`. The helper takes both from the class and types the item's props from it, so
  `createAskClaudeMenuItem` gets the concrete object (`KubeEvent#message` without a cast). A menu item's props are
  `Common.Types.KubeObjectMenuItemProps<K>`: `object` and `toolbar`, which is all the host passes; not
  `Renderer.Component.KubeObjectMenuProps`, the props of the host's whole menu.
- Components import their CSS module for the class names only, with no `?inline` import and no `<style>` tag; the rules
  reach the page through `renderer.css` (see "CSS").
- SCSS modules get TypeScript declarations (`*.module.d.scss.ts`), written during the renderer build (see
  "CSS module declarations"). They are committed; commit the regenerated file with a change to its SCSS module.
  `pnpm clean:dts` removes them.
- `appPreferences` registers `Input: () => <PreferencesInput />` and `Hint: () => <PreferencesHint />`; the host renders
  both with no props. The preferences page copies the store into React state once and writes every change back to
  `PreferencesStore`: it is the only writer of the preferences, so nothing can change them under it while it is open.
  Main and the chat read the store when they use a value, so a change applies without a restart.

## Rules That Fail Silently

Each of these compiles when it is broken, and breaks the extension at runtime
or not visibly at all. The sections named in parentheses explain the
mechanism; this is the list to check a change against.

- **The host's React and mobx, one copy each.** Import `react`, `react-dom`,
  `mobx` and `mobx-react` by their bare module ids, in the extension and in
  every library it bundles. A second React throws `invalid hook call`; a second
  mobx throws nothing, and the host never reacts to its observables, so the
  stores stop syncing between main and the frames. The build fails on the ways
  a second copy gets in ("Modules provided by the host").
- **Observable store fields through `makeObservable`.** The stores keep plain
  fields and annotate them in the constructor with
  `makeObservable(this, { field: observable })`. A field decorator without
  `accessor` (`@observable field`) type-checks and builds; mobx's development
  build throws when the class is defined, and its production build leaves the
  field unobservable. A decorated field is `@observable accessor` and its class
  does not call `makeObservable(this)` ("Decorators").
- **A store's `toJSON()` returns plain data.** The host saves the model to
  disk as JSON, which takes a mobx proxy, and sends it to every frame through
  IPC, which does not: Electron's structured clone refuses the proxy of a
  deeply observable object or array, and main logs `Error sending from
  webContents: Error: Failed to serialize arguments` on stderr, outside its
  logger, at every change. Return a copy (`toJS`) of such a field.
  `session-store.test.ts` sends the model through `structuredClone`.
- **A component that reads a store while it renders is an `observer`.** The
  host syncs a store into a frame after the component may have rendered;
  without `observer` the chat page stays on "not ready" and the chips keep the
  old shortcuts. `chat-page.test.tsx` and `chat-view.test.tsx` fail without it
  ("Renderer Components").
- **A memo over a store's items is keyed on something that changes with
  them.** The host keeps one observable array per store and updates it in
  place, with `replace` and `splice`, so `store.items` stays the same array
  while the objects in it change. A `useMemo` keyed on it, or on a prop that
  holds it, is computed once, and an open view keeps the objects it was opened
  with. An `observer` that reads the items while it renders follows them; a
  memo needs a key such as the ids and `resourceVersion`s of the objects. It
  shows only on a cluster whose objects change while the view is open.
- **An effect creates what its cleanup aborts or releases.** Freelens dev
  renders in `React.StrictMode`, which runs an effect, cleans it up and runs
  it again on the same instance. An `AbortController` kept in a `useRef` is
  aborted by the first cleanup, and every request of the second run with it: a
  bridge request or the event stream that takes an abort for no failure ends
  quietly, so the chat shows nothing and logs nothing. Create the controller,
  and whatever else the cleanup releases, inside the effect. The production
  build has no `StrictMode`, so only Freelens dev shows it ("Renderer
  Components").
- **No Node or Electron in renderer and common code.** They are `undefined` in
  the renderer. The build fails on an import, `pnpm type:check` on a global
  ("Process-specific settings").
- **Main is ESM, built for the `node` platform.** No `require()`,
  `__dirname` or `__filename` in main code. A bundled CommonJS package that
  `require()`s a builtin (the Node build of `yaml`) builds on the `browser`
  platform too, and the bundle then throws when the
  host evaluates it. Only loading `dist/main.js` shows it ("Process-specific
  settings").
- **A bundled CommonJS package loads in the ESM main.** Main is built for
  Rolldown's `node` platform, which gives it a `require`, and defines
  `__dirname` and `__filename`. Without either, the package throws when
  Freelens evaluates `dist/main.js`, and the extension does not activate;
  `pnpm build` and `pnpm type:check` pass ("Process-specific settings").
- **One CSS asset, `dist/renderer.css`.** Any other name, or a second asset,
  leaves the extension unstyled, dialogs and popovers included. Nothing checks
  it; look at `dist/` after a change to the CSS setup ("CSS").
- **One tsconfig per environment.** Each program has only its runtime's `lib`
  and `types`, and no declaration may load Node into the renderer or the DOM
  into main; otherwise a wrong API type-checks and is `undefined` at runtime.
  The environment tests fail on a leak ("TypeScript").
- **The Agent SDK gets `pathToClaudeCodeExecutable`.** Without it the bundled
  SDK looks for its own binary next to `dist/main.js`, where there is none
  ("Process-specific settings").
- **A cluster page gets `params` only.** The type check rejects a page that
  requires another prop, but not one that declares it optional; that prop is
  `undefined` ("Renderer Components").
- **An ESM `main`, and the entries in `package.json` unchanged while
  `pnpm dev` runs.** The host refuses to reload a CommonJS main and logs why,
  and it watches only the entries it started with, so a manifest change needs
  Freelens restarted.

Neither `pnpm build` nor `pnpm dev` runs the type check, so a Node global in
renderer code passes them; `pnpm type:check` and `type-check.yaml` catch it.

## Build

`vite.config.mjs` builds one entry point per run, in library mode, as ESM:
`vite build` builds the renderer and empties `dist/`, and `vite build --mode
main` builds main next to it. The two runs share no chunk; each bundle carries
its own copy of the `src/common/` code it imports. Nothing is minified.

`pnpm dev` runs the same two builds in watch mode, side by side, for a
directory install: the host reloads the extension when either entry is
rewritten. Its renderer run passes `--no-emptyOutDir`. In watch mode Vite
empties the output directory again before every rebuild, so a renderer rebuild
would delete `dist/main.js`, and the host would have no main entry to reload.

### Modules provided by the host

The host publishes its singletons on `globalThis.FreelensExtensionApi`, and
each process publishes only the ones it has. This is contract C3 of the
Freelens extension API (`docs/extensions/api.md`):

| Module id           | Global            | Published in |
| ------------------- | ----------------- | ------------ |
| `react`             | `React`           | renderer     |
| `react-dom`         | `ReactDom`        | renderer     |
| `react/jsx-runtime` | `ReactJsxRuntime` | renderer     |
| `mobx`              | `Mobx`            | both         |
| `mobx-react`        | `MobxReact`       | renderer     |
| `monaco-editor`     | `MonacoEditor`    | renderer     |

`build/vite-plugin-host-modules.mjs` replaces a bare import of one of these
with a module that reads the global, in the extension's code and in every
library it bundles (`react-markdown` included). Its named exports are the
members of the copy installed as a devDependency, which is pinned to the
host's version, so an import of a name the host's version lacks fails the
build. The plugin also fails the build on an import of a host module that the
process does not publish (`react` in main), and on a subpath of a host package
that the host does not publish (`react-dom/client`). Both would otherwise
either read `undefined` at runtime or bundle a second copy. A second React
throws `invalid hook call`; a second mobx throws nothing, and the host simply
never reacts to its observables.

Everything else is bundled. That includes `@freelensapp/extensions`, a shim of
three lines that reads `Common`, `Main` and `Renderer` off the same global; it
must not be mapped. The host installs no dependencies of an extension, so
whatever the code needs at runtime and the host does not provide has to be in
the bundle.

### Process-specific settings

- **Renderer**: nothing is external. Renderer code gets no Node or Electron, and
  an import of a Node builtin or of `electron` fails the build (Vite would
  otherwise replace it with an empty module and only warn).
  `process.env.NODE_ENV` is replaced at build time, because library mode
  leaves it for a consumer's bundler and the page has no `process`.
- **Main**: Node builtins (`node:*` and bare) and `electron` stay external.
  Bundled packages resolve with Vite's server conditions, so main gets their
  Node builds rather than their browser builds. Rolldown builds main for the
  `node` platform: a bundled CommonJS package (the Node build of `yaml`, which
  `kube-format.ts` imports) `require()`s the builtins, and in an ES module
  there is no `require`. For the browser platform Rolldown turns
  such a call into a shim that throws when the module is evaluated, so the
  extension would fail to load; for the `node` platform it creates `require`
  with `createRequire(import.meta.url)`. `__dirname` and `__filename` are the
  other half: Node passes them to a CommonJS module, Rolldown leaves them as
  they are on either platform, and the ES module throws `ReferenceError:
  __dirname is not defined in ES module scope`. Main defines them (`define`)
  as `import.meta.dirname` and `import.meta.filename`, the directory and file
  of `dist/main.js`, not of the package: a library that loads a file next to
  itself, such as a `.wasm`, finds it only when the build puts it in `dist/`.
- **Main code** uses ESM only: no `require()`, `__dirname` or `__filename`. A
  host module that a test cannot load is imported on demand with `await
  import(...)` in a function that catches the failure, not at the top of a
  module. `electron` is one: under Vitest it resolves to the npm package,
  whose entry throws (or starts downloading the binary) outside Electron.
  Main code does not import it: what the extension needs of the host, its
  kubectl, helm and their environment included, comes from the extension API
  (`Main.Shell`), not from Electron or the host's file layout.
- The Agent SDK is bundled and always gets `pathToClaudeCodeExecutable`, the
  user's Claude Code. Without it the SDK looks for its own native binary next
  to `import.meta.url`, which in the bundle is `dist/main.js`.

### Decorators

MobX 7 supports standard decorators only, and Oxc, which transpiles TypeScript
for Vite, passes them through unlowered, while neither Node nor Chromium runs
them yet. `build/vite-plugin-standard-decorators.mjs`, copied from Freelens,
hands every module with a decorator to esbuild first, which lowers the
decorators and their `accessor` fields. The stores in `src/common/` use no
decorators: their fields stay plain and are annotated in the constructor with
`makeObservable(this, { field: observable })`, so the plugin has nothing to
lower today.

### CSS

The host links the stylesheet named after the renderer entry, `renderer.css`
next to `renderer.js`. Library mode extracts the CSS of the whole bundle into
that one file (`build.lib.cssFileName`). A build that emits more than one CSS
asset, or a differently named one, leaves the extension unstyled. A component
imports its CSS module for the class names only and renders no `<style>` tag;
the rules reach the page, and every dialog and popover in it, through
`renderer.css`. CSS modules use `camelCaseOnly` class names.

### CSS module declarations

`build/vite-plugin-css-module-declarations.mjs`, copied unchanged from the
template, writes `x.module.d.scss.ts` next to every `x.module.scss` the
renderer build imports, in `vite build` and in watch mode. It takes the class
names from Vite's own `preprocessCSS`, with the build's resolved config, so
they are the names the bundle exports, after `localsConvention` (keyframe
names included). It awaits its work, writes a declaration only when its
content changed, and writes through a temporary file and a rename, so a failed
or interrupted build cannot leave a committed declaration empty.

### Bundled package list

`build/vite-plugin-prod-packages.mjs` writes `prod-packages.json`, the npm
packages inlined into `dist/` with their pnpm store paths. The security scans
(`main-scan.yaml`, `release-scan.yaml`) and the release assets use it as the
runtime closure of the extension. The two runs are separate processes, so the
list is their union, kept in the file: the run that empties `dist/` (the
renderer run) starts it, and the main run adds to it.

## TypeScript

Main code runs in Node, renderer code in a browser page, and common code in
both. Each is type-checked in a program of its own, so that an API the runtime
does not have fails `pnpm type:check` rather than the extension:

| Config                       | lib                       | types                             | Files                                                                                              |
| ---------------------------- | ------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/main/tsconfig.json`     | ES2024                    | `node`                            | `src/main/`, `src/common/`                                                                         |
| `src/renderer/tsconfig.json` | ES2024, DOM, DOM.Iterable | `vite/client`                     | `src/renderer/`, `src/common/`                                                                     |
| `src/common/tsconfig.json`   | ES2024, WebWorker         | none                              | `src/common/`                                                                                      |
| `src/tsconfig.json`          | ES2024, DOM, DOM.Iterable | `node`, `vite/client`             | `*.test.ts(x)` under `src/`, and `test/`                                                           |
| `integration/tsconfig.json`  | ES2024, DOM, DOM.Iterable | `node`, `@freelensapp/extensions` | `integration/`                                                                                     |
| `tsconfig.json`              | ES2024                    | `node`                            | `vite.config.mjs`, `vitest.config.ts`, `vitest.integration.config.ts`, `svgo.config.mjs`, `build/` |

All of them extend `tsconfig.base.json`, which has the compiler options of
Freelens's fixture extension: `strict`, `moduleResolution: Bundler`,
`useDefineForClassFields`, `noUncheckedSideEffectImports` and `skipLibCheck`
among them. `skipLibCheck` is required: `extension-api.d.ts` is one declaration
for both processes and names DOM types and the `Electron` namespace, which no
single program has. Write `types` in every config; it decides which `@types`
packages a program sees.

### Main, renderer and common

The main and renderer configs both include `src/common/`. Compiled as main,
common code fails on the DOM; compiled as renderer, it fails on Node. What
passes both is valid in both, and that is the check that decides. Common code
uses only what both runtimes have: `globalThis.crypto`, `TextEncoder` and
`TextDecoder`, `URL` and `URLSearchParams`, `AbortController`,
`structuredClone`, and the timers, with the timer handle kept opaque.

`src/common/tsconfig.json` is for the editor, which gives a file to one config
only. Its `WebWorker` lib is the closest single match and an approximation:
`self` and `postMessage` compile there and fail in the main program. It is not
compiled on its own: `environment-tests/tsconfig.json` extends it and keeps its
`include`, so `tsc -p environment-tests` compiles `src/common/` with the common
settings, together with the probes.

The split does not cover the API namespaces: `Main` and `Renderer` compile in
every program, and the one the process does not have is `undefined` at runtime.
Common code uses `Common`.

### Asset imports

The renderer program has `vite/client`, which declares `*?raw`, `*?inline` and
the CSS modules and brings no Node into the program. With
`allowArbitraryExtensions`, `import styles from "./x.module.scss"` resolves to
the generated `x.module.d.scss.ts`, so a class name that the stylesheet lacks
fails the check.

### Environment tests

`types` and `lib` alone do not keep an environment pure. A declaration file
with `/// <reference types="node" />` loads all of `@types/node` into any
program that reaches it, whatever `types` says, and one with
`/// <reference lib="dom" />` loads the DOM. `environment-tests/` proves the
split holds:

| File             | Compiled with          | Must                      |
| ---------------- | ---------------------- | ------------------------- |
| `node-apis.ts`   | renderer, common       | fail on every marked line |
| `dom-apis.ts`    | main, common           | fail on every marked line |
| `worker-apis.ts` | main                   | fail on every marked line |
| `shared-apis.ts` | main, renderer, common | pass                      |

Each line that must fail carries `// @ts-expect-error`, so a program that
starts accepting it fails with an unused directive. The configs there extend
the source configs and keep their `include`, so the probes are compiled
together with the sources and every declaration the sources reach (the Agent
SDK, `react-markdown` and the rest). Compiled alone,
they would not see a declaration that a dependency of the sources brings in.

When a declaration leaks, the environment tests fail; keep the leak out rather
than relax a probe. For Node in the renderer, point `typeRoots` of the renderer
config at a directory with an empty `node` package, which a reference
directive resolves to first. For the DOM in main, remove the directive from the
declaration with `pnpm patch`.

### Tests and tooling

Tests are not in the environment programs. Vitest runs them in Node, with
jsdom for files that ask for it, so `src/tsconfig.json` gives them the DOM and
Node. It sits in `src/` so that an editor finds it for a test file: the
environment config next to the test excludes it, and the editor goes on to the
next `tsconfig.json` up the tree. Tests compile against the real
`@freelensapp/extensions` declaration, while Vitest replaces the package with
`test/freelens-extensions.ts` at runtime.

No config declares the Vitest globals. TypeScript has no per-file globals, so
declaring `describe` or `vi` for tests would declare them for every file in the
program. Test and test-support files import what they use:

```ts
import { describe, expect, it, vi } from "vitest";
```

The module resolves from every program, so Biome keeps it out of the
extension's code: `style/noRestrictedImports` rejects an import of `vitest`
outside `src/**/*.test.*`, `test/` and `integration/`. The same rule rejects
there the testing helpers of React: the `act` named import of `react`,
`react-dom/test-utils` and `@testing-library/*`. They type-check, build and
pass the unit tests, which run the development build of React, but `act`
delegates to `React.act`, which the production build that Freelens runs leaves
out, so the call throws only in the host. `globals: true` stays on
in `vitest.config.ts` at runtime only, because React Testing Library registers
its automatic cleanup only when `afterEach` is a global.

`@freelensapp/extensions` is stubbed because the real package cannot run in a
test: it is a shim that reads `Common`, `Main` and `Renderer` off
`globalThis.FreelensExtensionApi`, which only the host sets, and it ships no
mocks. The `alias` in `vitest.config.ts` points the import at
`test/freelens-extensions.ts`, for the tests and for the extension code they
import. The stub covers only what the tests use (the `ExtensionStore` base
class, `Common.logger`, `Common.Clusters`, `Common.Util.bytesToUnits`,
`Main.Catalog.getClusterById`, `Main.K8sApi.KubeJsonApi.forCluster`,
`Main.Shell`, `Renderer.Catalog`, the `Main.Ipc` and `Renderer.Ipc` base
classes, whose `handle` and `invoke` are mocks, and stand-ins for `Icon`, for
`LineProgress` and for `MonacoEditor`, which renders a `<textarea>`), at
runtime only; the type check still uses the real declaration. As in the host, a
store is a singleton per class, so a test that renders a component reading a
store sets the same instance the component reads, and drops it afterwards with
`resetInstance()`. So a test that reaches a member the stub lacks compiles and
fails on `undefined`: add the member to the stub, as small as the test needs.
The other host modules are not stubbed: `react`, `mobx` and `mobx-react`
resolve to the devDependencies, the host's versions. `vitest.config.ts` also
runs the standard-decorators plugin, as the build does.

The root `tsconfig.json` checks the tooling files. It has `checkJs`, so the
Vite config and the build plugins are type-checked too; give their function
parameters and object literals JSDoc types where inference is too wide.

## Lint and CI

### Biome

`biome.jsonc` has the formatter, import groups and rules of Freelens. Two
overrides are specific to how the extension is laid out:

- `style/noRestrictedImports` keeps `vitest` and the testing helpers of React
  out of the extension's code (see "Tests and tooling").
- `correctness/noNodejsModules` rejects a Node builtin import in
  `src/renderer/` and `src/common/`, tests left out. It flags the import in the
  editor, before `pnpm type:check` does; it does not see Node globals such as
  `Buffer` or `process`, which only the type check catches.

Every path in an override starts with `**/`. Trunk runs Biome from a sandbox
outside the repository, with `--config-path` pointing back at `biome.jsonc`,
and there a path anchored at the repository root matches no file, so the
override silently does nothing. A plain `biome check` matches both forms, so
only `trunk check` shows the difference.

In that sandbox, Biome also cannot apply `vcs.useIgnoreFile`: it matches every
target against the repository's `.gitignore` and panics on a path outside the
repository root. The Biome commands in `.trunk/trunk.yaml` pass
`--vcs-use-ignore-file=false`, because Trunk applies `.gitignore` itself before
it picks the targets; `biome.jsonc` keeps the setting on for `pnpm biome` and
editors.

Renovate updates Biome, in the `biome` script and in `.trunk/trunk.yaml`, but
cannot run `biome migrate`. `biome-migrate.yaml` runs it on the Renovate
branch and commits the migrated `biome.jsonc` there, so that the update and its
migration are one pull request. The commit is by `github-actions[bot]`, which
`gitIgnoredAuthors` in `.renovaterc.json` lists, so that Renovate does not take
it for a manual edit and stop updating the branch.

Biome formats SCSS, YAML and Markdown too, as in Freelens, so Trunk runs no
Prettier, markdownlint or yamlfmt; yamllint still checks YAML. `biome.jsonc`
leaves out `pnpm-lock.yaml` and `pnpm-workspace.yaml`, which pnpm writes, and
`.trunk/`, whose `trunk.yaml` `trunk upgrade` rewrites. The Markdown rules are
in `nursery`. Trunk takes actionlint from the maintained fork of kjanat, which
continues the releases of rhysd/actionlint with the same file names.

### Knip

`pnpm knip:check` runs knip twice, for unused files and for dependencies: a
development pass over everything, and a `--production --strict` pass over the
code that reaches the bundles, which are the entries marked with `!` in
`knip.jsonc`. In the production pass only `dependencies` count. This extension
declares every library as a devDependency, because the host installs none of
them, so `knip.jsonc` ignores the host-provided modules, `electron` and the
bundled libraries by name; a new bundled library goes on that list.

A file is unused when no entry reaches it: a leftover module, a barrel that
nothing imports. The production pass starts from the `!` entries only, so it
also reports a module that only tests import. The fix is to remove the file,
not to ignore it.

`knip.jsonc` lists the entries knip cannot find: the two source entries, the
Vitest alias target `test/freelens-extensions.ts` and the probes in
`environment-tests/`. Its Vite plugin is off: it adds the renderer entry of
`vite.config.mjs` as a development entry, which displaces
`src/renderer/index.tsx!`, and the production pass then skips the renderer.
`--no-config-hints` is set because one config serves both passes, and an entry
that only the production pass needs is reported as redundant by the other.
`project` leaves out the CSS module declarations with `!src/**/*.d.scss.ts`:
TypeScript reaches them through `allowArbitraryExtensions`, while knip resolves
`import styles from "./x.module.scss"` to the stylesheet, so nothing would
import them. The SVGO plugin is on (`"svgo": true`), so that `svgo.config.mjs`
is an entry: Trunk runs SVGO, and no dependency turns the plugin on.

### Workflows

| Workflow                 | Runs                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `type-check.yaml`        | `pnpm type:check`                                                             |
| `check.yaml`             | `pnpm build`, `pnpm lint:check`, `pnpm knip:check`                            |
| `unit-tests.yaml`        | `pnpm test:unit`                                                              |
| `trunk-check.yaml`       | `trunk check --all`                                                           |
| `integration-tests.yaml` | the integration tests in `integration/`, against Freelens dev                 |
| `mise-lock-check.yaml`   | on a change to `mise.lock`: no checksum changed for an unchanged tool version |
| `main-scan.yaml`         | Grype over the packages in `prod-packages.json` of a `main` build             |
| `release-scan.yaml`      | Grype over the `prod-packages.json` assets of the last release                |

The other workflows automate releases, maintenance and the CI agent:

| Workflow             | Does                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `npm-version.yaml`   | bumps the version in a pull request, on demand and after each release (`docs/RELEASE.md`) |
| `tag.yaml`           | tags `vX.Y.Z` when the version pull request of a stable version is merged                 |
| `release.yaml`       | on a `v*` tag: builds, packs, publishes to npm and creates the GitHub release             |
| `biome-migrate.yaml` | runs `biome migrate` on the Renovate branch of a Biome update and commits the result      |
| `trunk-upgrade.yaml` | upgrades the Trunk plugins and linters in a pull request                                  |
| `npm-audit.yaml`     | `pnpm audit fix` in a pull request                                                        |
| `npm-dedupe.yaml`    | `pnpm dedupe` in a pull request                                                           |
| `claude.yaml`        | the CI agent, started by a mention in an issue or pull request (see below)                |
| `claude-task.yaml`   | the CI agent on a task given when the workflow is started by hand                         |

The type check has a workflow of its own, on pull requests and on pushes to
`main`, as in Freelens. It runs every program, tests, tooling and environment
tests included, which no build reaches, and a type error shows as its own
failed check rather than as a failed build. `check.yaml` builds without the
type check for the same reason, so it does not run twice.

The integration tests follow the pattern of freelensapp/freelens-example-extension.
They run in this repository, under its own Vitest
(`vitest.integration.config.ts`, `pnpm test:integration`), against Freelens
started with `pnpm dev` from a freelensapp/freelens checkout. They attach to
it with Playwright's `chromium.connectOverCDP` on the port that script opens
(see "Checking the Extension in Freelens Dev"), so they need no package of
Freelens and no file of its checkout; Freelens dev is the only dependency, and
it is not in `package.json`. `playwright` is a devDependency at the version of
Freelens's catalog. The workflow builds the extension, checks out Freelens at
each release tag of its matrix (`v2.0.0`), starts `pnpm dev` there in the
background under `xvfb-run`, with its output in a file and a fresh profile in
`FREELENS_INTEGRATION_TESTING_DIR`, waits until the CDP endpoint answers, and
runs `pnpm test:integration` here. A profile of Freelens dev syncs no
kubeconfig by default, so the workflow seeds the fresh one with a single sync
entry, a file with the kind cluster alone, and the catalog lists that cluster
and nothing else. Every test file is a session of its own on the one app, and
fails on any error logged by either process:

- `extensions.tests.ts` uninstalls whatever installation of the extension the
  app has, installs this checkout in place from the Extensions page and opens
  its preferences page, without changing a preference: the extension's tab in
  the "Extensions" tab group shows the title of its `appPreferences` entry and
  the label of its first input. It needs no cluster.
- `chat.tests.ts` opens the kind cluster with the test objects of
  `integration/fixtures/` (the namespace `integration-tests`, and a Deployment
  and a Service named `integration-tests-object` in it). The chat page,
  opened by its route, renders its composer, which it does only once the
  bridge answers and Claude Code is found. "Clear conversation" starts a new
  chat, and one prompt, which asks for a single word and no tool, gets that
  word in Claude's answer. The rows of the test objects on the host's
  Deployments, Pods and Services pages, and of an event about one of them on
  the Events page, list "Ask Claude" in their menu, which is not clicked.
  They do not check what the item does, a tool call, an approval, or the
  dialogs of the composer.

The prompt starts a real Claude Code session and costs one turn. Claude Code
inherits the environment of the main process of Freelens dev, so it finds the
credentials there, or in the developer's own login when run locally. In CI the
extension's `pnpm install` brings the native Claude Code that the Agent SDK
installs as an optional dependency for the platform, at the version the SDK
was released with, and the workflow points `CLAUDE_CODE_PATH` at it; nothing
is downloaded. The workflow passes `CLAUDE_CODE_OAUTH_TOKEN`, the secret of
the Claude workflows, and `ANTHROPIC_MODEL` of the smallest model, to
`pnpm dev` on a push to `main` and a manual run only. A pull request runs the
code of its branch, and of the dependencies a branch of Renovate updates, in
the job, so it gets no token, and the workflow sets `TEST_SKIP_CLAUDE_PROMPT`,
which skips the prompt; the composer is checked all the same, as it needs
Claude Code but no credentials. `pnpm dev` of Freelens runs turbo, which in
its strict mode passes a task only the variables that Freelens's `turbo.json`
lists, so the workflow sets `TURBO_ENV_MODE=loose` for it. Without it none of
these variables reach Electron: Claude Code is not found, unless it is on the
`PATH`, which turbo always passes, and the chat page shows the onboarding
panel instead of the composer. Locally the developer's `claude` is usually on
the `PATH` and logged in, so a run there does not show it.

The tests are deterministic, so nothing retries them: the config sets no
`retry`, and the workflow runs the step once, under `timeout 600`. A retry
repeats the same failure, and every view of a session waits its full timeout
before it fails.

The sessions reach the app through its renderer only; the main process, and
with it the application menu, is out of reach of CDP. They navigate the root
frame, and the cluster frame to a page of the host or to the chat, with
`Renderer.Navigation.navigate` of the extension API: the sidebar groups of the
host's kinds are collapsed. They find the kind cluster with
`Renderer.Catalog.catalogEntities` by its name, `kind-<name>`, connect it by
navigating to `/cluster/<id>` and disconnect it with the entity's
`disconnect()`. `browser.close()` of a browser connected over CDP closes only
the connection, so a session ends with it and the app keeps running. The
renderer's console carries the errors of the root frame and of every cluster
frame; the main log is read from the file that `FREELENS_MAIN_LOG` names, from
its size when the session started, and every line that starts with `error:`
counts, also after a task prefix that turbo may add, such as `freelens:dev:`,
and so does `Error sending from webContents:` or `webFrameMain:`, which
Electron writes to stderr, outside the logger, for a message that IPC cannot
send, such as a store's model with a mobx proxy; `lens.log` does not have
those, only the output of `pnpm dev`. The exception is `proxy_server.go:… Error while proxying request: context canceled`,
which the Kubernetes proxy of Freelens logs for a request that the renderer
aborts. Freelens dev renders in `React.StrictMode`, which mounts every view
twice and aborts the requests of the first mount, so the line comes and goes
with the timing of a run; it names no request and says nothing about the
extension. Without the variable only the renderer is checked. A renderer error
carries its location, line and column included, and the worker that logged it.
Its text is the preview of its arguments, which is empty for some objects and
only the class name for others, such as `ErrorEvent`; such an error is
described from its arguments, read from the page, and an empty one without
arguments, which the browser itself logs, gets its time, to find it in the
main log. The one renderer error left out is a "Failed to load resource" with
a 404 or a 503 for `/api-kube/apis/metrics.k8s.io/`: a cluster frame opens on
the host's Cluster Overview, which asks for the metrics of the nodes, as the
Pods page asks for those of the pods, and kind serves no `metrics.k8s.io`;
whether the Overview gets to ask before the session navigates away depends on
the timing of a run. The workflow sets `TURBO_LOG_ORDER=stream` for
`pnpm dev`: in GitHub Actions turbo otherwise groups the output of a task
until it ends, and the persistent `dev` task never ends, so the log would stay
empty.

Vitest runs the files one at a time (`fileParallelism: false`), in no set
order, and none depends on another having run. The cluster session
disconnects the kind cluster, so that its frame, and the chat page in it, load
anew, removes the leftovers of an earlier run (the namespace
`integration-tests`), applies `integration/fixtures/`, and only then connects
the cluster. The frame opens on the host's Cluster Overview, and the chat is
the first view the session opens, so that it loads its status, its events and
the model catalog itself, under `React.StrictMode`, as a user's first visit
does. The list pages come after it; the first selects `integration-tests` in
the namespace filter, unless the filter already shows it, and the app keeps
the selection for every namespaced list of the cluster. A session's teardown
stops collecting the errors first, then disconnects the cluster, so that no
view watches the test objects while they are deleted, then deletes them with
`--wait`, also when a test failed, and then checks the errors. The app
refreshes the cluster's permissions while it disconnects it, and when the
refresh loses the race, its requests fail on its own proxy
(`[AUTHORIZATION-REVIEW]`, `[AUTHORIZATION-NAMESPACE-REVIEW]`,
`[FREELENS-PROXY]` with `Cluster <id> is not connected` or `The client is
destroyed`); those errors come and go with the timing of a run and say
nothing about the extension, and the session no longer collects them.

The code the sessions share is in `integration/__tests__/extension-helpers.ts`:
connecting to the app with the error collector, installing the extension,
connecting and disconnecting the kind cluster, kubectl, the chat, and the
selectors. Its name does not match `*.tests.ts`, so Vitest does not collect
it. Its common part, up to the preferences, is the example extension's, and
is kept in step with it. The chat's transcript items are found by the class
names that CSS modules give them in the bundle (`_assistantBubble_`,
`_errorItem_`, `_errorBanner_`), and an error item or banner fails the prompt
with its text. `integration/tsconfig.json` compiles the directory with Node
and the DOM, because the callbacks of `page.evaluate` run in the page, and
with the types of `@freelensapp/extensions`, which declare
`globalThis.FreelensExtensionApi` for them.

Four variables configure the sessions. `FREELENS_CDP_URL` is the CDP endpoint
(`http://127.0.0.1:9223` by default), `FREELENS_MAIN_LOG` the main log,
`TEST_KIND_CLUSTER_NAME` names the kind cluster (`kind` by default, `freelens`
in the workflow), and `TEST_SKIP_CLAUDE_PROMPT`, when set, skips the prompt.
Every kubectl call names its context, `kind-<name>`, so a run never acts on
the current context. The checkout to install, and the fixtures, are found from
the location of the helpers. Outside CI a session skips with a warning when
Freelens dev does not answer or the cluster is not reachable; in CI (`CI`
set) the run fails instead, so that a mistake in the workflow does not turn
into a silent skip.

Run locally, the tests act on the profile of Freelens dev, `FreelensDev`,
which is apart from that of an installed Freelens: they navigate its window,
leave this checkout installed in place, uninstalling another installation of
the extension, clear the chat of the kind cluster, and leave the kind cluster
disconnected, with the namespace filter set to `integration-tests`. They touch
no other cluster of the catalog. The profile lists the kind cluster only once
its kubeconfig is in "Kubeconfig Syncs" (see "Checking the Extension in
Freelens Dev"); without it the cluster session fails on the timeout of finding
the cluster. A run deletes the namespace `integration-tests`: run it only
against a kind cluster with nothing worth keeping there.

## Checking the Extension in Freelens Dev

The functional checks of a change run against Freelens started with
`pnpm dev` from a freelensapp/freelens checkout, with a cluster to point the
chat at. That script starts Electron with `--remoteDebuggingPort 9223`, so an
agent can drive the app over the Chrome DevTools Protocol: with Playwright MCP
attached as Freelens's `DEVELOPMENT.md` describes ("Inspecting the running dev
app from an AI agent"), or with a `playwright-core` script that calls
`chromium.connectOverCDP("http://127.0.0.1:9223")`. End such a script by
exiting the process; do not close the browser, which belongs to Freelens.
Playwright MCP writes its snapshots to `.playwright-mcp/`, which is
git-ignored.

A profile of Freelens dev syncs no kubeconfig until one is added in
"Kubeconfig Syncs" of the Kubernetes preferences, so its catalog lists none of
the developer's clusters; `KUBECONFIG` does not change that. For the checks,
add a kubeconfig with the test cluster alone, such as the output of
`kubectl config view --minify --flatten --context kind-kind`. A fresh profile,
in a `FREELENS_INTEGRATION_TESTING_DIR` under the system's temporary
directory, can start with it already in place, as in the workflow of the
integration tests: seed
`FreelensDev/lens-user-store.json` there with
`preferences.syncKubeconfigEntries`, whose `filePath` is absolute ("Kubeconfig
syncs of the dev profile" in Freelens's `DEVELOPMENT.md`).

### Installing the checkout

1. `pnpm install`, then `pnpm build`. After a branch switch, `node_modules`
   can still hold another stack, and Freelens loads the extension from
   `dist/`.
2. On the Extensions page, enter the checkout's directory and press
   "Install". Freelens then asks whether to load the extension in place;
   confirm that too. The table lists the extension as "in place, unverified"
   and enabled.
3. A rebuild, by `pnpm build` or by `pnpm dev` of the extension, reloads it
   once in the root frame and once in each cluster frame, and reloads main.
   Each main reload stops the bridge and logs
   `[for-claude] bridge listening on 127.0.0.1:<port>` for the new one.

### Driving the UI

- Every cluster renders in a cross-origin `<clusterId>.renderer.freelens.app`
  iframe. The chat page, the "Ask Claude" items and every dialog and popover
  of the chat live in that frame, not in the main page; the preferences page
  lives in the main page.
- The chat page has the URL `/extension/freelensapp--for-claude-extension/chat`
  inside the cluster frame. The "Freelens for Claude" sidebar entry navigates
  in `onClick`; its `href` is not the page URL.
- Playwright's actionability checks can fail on the hotbar, where
  `#ScrollSpyRoot` intercepts pointer events; a DOM `click()` on the element
  works.
- The chat page connects once `BridgeStore` has synced into the frame, and an
  answer streams in over seconds. Wait for the expected content, not a fixed
  time.
- Freelens renders under `React.StrictMode`, which in its development build
  runs every effect twice on mount, with the cleanup in between. So the
  network log of Freelens dev shows two `/status`, two `/events` (the first
  aborted) and two `/models` when the chat page opens; that is not a remount,
  and a production build sends one of each. The bridge answers concurrent
  requests for one cluster from one session start.
- In the default "Approve" mode, a mutating tool (`freelens_kubectl` and
  `freelens_helm` included), a pod log read (unless its preference is off)
  and every external MCP tool stop at an approval card; approve or deny it to
  let the turn go on.
- `freelens_kubectl` and `freelens_helm` run the kubectl and helm of the
  cluster terminal, under Freelens dev too: `freelens_kubectl` with
  `["version"]` reports the client that `kubectl version` reports in the
  cluster's terminal. The first call on a cluster whose Kubernetes version has
  no kubectl downloaded yet waits for the download, before its timeout starts.
  The card shows it in a line under its header, from `tool_progress` events
  tied to the call by the `claudecode/toolUseId` of the MCP request's `_meta`;
  the progress is in the main log too (`[for-claude] kubectl: ...`). A problem
  with it, such as a fallback to the bundled kubectl, stays in the card as a
  warning and heads the result of `freelens_kubectl`. To see a download, take a
  cluster whose Kubernetes version is not the bundled kubectl's and remove
  that version from the download directory.

### Reading the console

The renderer console also carries the output of Freelens's terminal dock
(`%cMESSAGE` lines), which can include the user's shell prompt, account names
and paths. Keep only warnings, errors, page errors and the extension's own
lines (`[for-claude]`), and never paste the full console into a PR, an issue
or a report. A transcript holds cluster data too; quote only what a report
needs. React reports key problems as console errors ("Each child in a list
should have a unique key", "Encountered two children with the same key");
they count as failures of the "no error in DevTools" check.

The renderer's requests, to Kubernetes and to the bridge, go through Chromium,
which logs every response that is not a success as a console error,
`Failed to load resource: the server responded with a status of N`, also one
that the code that sent it handles. The text names no URL; the location of the
message does. Leave out such an error by its status and URL only where the
response is expected, not every "Failed to load resource".

The main process logs to the terminal running Freelens, and to a file. On
macOS it is `~/Library/Logs/Freelens/lens.log`, with the renderer's
`lens-renderer-*.log` next to it; when the terminal is not at hand, it shows
the extension's activation, its reloads, the bridge's port and its own
`[for-claude]` lines. Filter it as the console.

## Code Style

- **Biome** formats **TypeScript/TSX, JS, JSON, CSS, SCSS, HTML, YAML, Markdown**: double quotes, semicolons, trailing commas, 2-space indent, 120 char line width — use `pnpm biome:fix`
- **Trunk** formats **TOML and shell scripts**, and runs the linters for formats not covered by Biome (yamllint, actionlint, shellcheck) — use `pnpm trunk:fix`
- Import order (enforced by biome organizeImports): built-in modules → `@freelensapp/**` → packages → relative paths
- React 19; JSX compiles to `react/jsx-runtime` imports, which the build maps to the host's React. `JSX` is not a
  global namespace: write `React.JSX.Element`, or import the type from `react`
- **No emoji** in Markdown files (`.md`), comments, or any source code

## Security

Never read, display, reference, or include the contents of the following files in any response or context, even if they are open in the editor:

- `.env`
- `.env.*`
- `.envrc`
- `.npmrc`
- `*.jks`
- `*.keystore`
- `*.p12`
- `*.pfx`
- `*.pem`
- `*.key`

The same list is git-ignored in `.gitignore` and enforced for Claude Code by
the `permissions.deny` rules in `.claude/settings.json`, which block reading
and editing these files. Change all three together. The rules are native
permissions rather than a hook on purpose: a hook runs a process in the
working tree, which may be an untrusted pull request, and an interpreter such
as `python3 -c` imports modules from that tree before the hook's own code.

## Electron Multi-Process

Extensions run in the same multi-process model as the Freelens host:

- **Main process** (`src/main/`) — Node.js environment, extension lifecycle, cluster connectivity
- **Renderer process** (`src/renderer/`) — Chromium browser, UI components

Code in `src/common/` is shared between both processes.

## Troubleshooting

### Changes Not Appearing

1. Check that files are not in ignored output directories (`dist/`, `node_modules/`)
2. Full clean and rebuild: `pnpm clean:all && pnpm install && pnpm build`
3. With a directory install and `pnpm dev` running, look for a refused reload in the Freelens log, and restart
   Freelens after a change to `main` or `renderer` in `package.json`; reinstall an extension installed from a tarball

### Build Failures

1. Check for TypeScript errors: `pnpm type:check`
2. Check for linting errors: `pnpm lint:check`
3. Verify dependencies: `pnpm install`
4. Check Node.js version matches the `engines` field in `package.json`

### Runtime Errors

1. Open Freelens DevTools and check the Console tab for renderer errors
2. Check the terminal where Freelens was launched for main process errors
3. Look for stack traces with file:line numbers; main-process lines of the extension start with `[for-claude]`
4. Validate both with `pnpm type:check` **and** `pnpm build` — runtime failures can appear only in bundled `dist/` code
5. Check the list in "Rules That Fail Silently"

## Best Practices

1. **Use semantic search** to find examples and patterns in the codebase
2. **Follow existing patterns** — grep for similar implementations before creating new ones
3. **Test changes** before committing
4. **Run validation before committing:** `pnpm lint:fix && pnpm type:check && pnpm test:unit`
5. **For TypeScript/TSX, JS, JSON, CSS, SCSS, HTML, YAML and Markdown files:** run `pnpm biome:fix` (or `biome check` directly if `biome` is installed locally)
6. **For other formats:** run `pnpm trunk:fix` (or `trunk check` directly if `trunk` is installed locally)
7. **Full build** when in doubt about cached state: `pnpm clean:all && pnpm install && pnpm build`
8. **Do not use Anthropic Fable for coding tasks** — Fable may be used only for planning,
   analysis, and thinking through problems. When writing or editing code,
   use standard editing tools instead.

## GitHub Actions (Claude Code Action) Rules

This project has a Claude Code workflow (`.github/workflows/claude.yaml`) triggered
via `@claude` comments on issues, PR comments, and reviews. When operating via that
workflow, follow these rules:

### Code Review

When reviewing code and proposing fixes:

1. **Show the diff first** — present every proposed change as a unified diff
   block using the `diff` language tag:

   ```diff
   --- a/path/to/file.ts
   +++ b/path/to/file.ts
   @@ -10,7 +10,7 @@
    const oldLine = "before";
   -const changedLine = "after";
   +const changedLine = "the fix";
    const unchangedLine = "same";
   ```

   You can generate this from the terminal with:

   ```bash
   git diff -u -- path/to/file
   ```

   If the change spans multiple files, group them under a single commit
   subject and show each file's diff sequentially.

2. **Propose a commit subject first** — before any code change, output a
   single line with the proposed commit subject:

   ```text
   **Proposed commit:** <short description>
   ```

   Do **not** use Conventional Commits prefixes (e.g. `fix:`, `feat:`,
   `chore:`, `refactor:`, `docs:`, `test:`, `ci:`). This project prefers
   plain, descriptive commit messages and PR titles without any prefix.

   Wait for the user to confirm (or adjust) the subject before applying the
   change.

3. **Comment style:**
   - Keep review comments concise and actionable
   - Reference specific lines (file + line number) when pointing out issues
   - Offer a concrete fix suggestion rather than just flagging a problem
   - Do **not** use emoji in any Markdown, comments, commit messages, or
     PR descriptions. The only exception is emoji that already appears
     inside code strings (e.g. application logs, user-facing messages).
   - Use GitHub's `suggestion` block for small targeted fixes so the PR
     author can accept the change with a single click:

     ```suggestion
     <same unified-diff format as shown above>
     ```

   - For larger multi-file changes, use `diff -u` blocks in a regular
     comment instead, with the proposed commit subject shown first

### Making Changes to a PR

When asked to implement a change on a PR:

1. Propose the commit subject (as above)
2. Describe what will change and why
3. After confirmation, apply the changes with commits on the PR branch
4. **One commit per fix** — when a review surfaces more than one issue or
   the plan includes more than one fix, apply and commit each fix
   separately. Do not batch multiple independent fixes into a single
   commit. This keeps the history bisectable and makes each change easy
   to revert individually.
5. **Push after every commit** — run a `git push` immediately after each
   commit, never batch several commits into a single push at the end. The
   workflow has a timeout and a turn limit (`timeout-minutes` and
   `--max-turns` in `claude.yaml`); a long task can be interrupted mid-run.
   Pushing each commit as it lands means a later
   `@claude resume after timeout` run picks up from the last pushed commit
   with no lost work. Unpushed commits are lost when the session times out.

### Force-Pushing a Rewritten Branch

When you are asked to rebase a pull request branch, or to rewrite its
history in another way (amend, squash, drop a commit), push the result with:

```bash
git push --force-with-lease origin HEAD
```

The push wrapper the action names in its instructions, `git-push.sh`, accepts
no flags, so it cannot do this; `git` itself is allowed in this workflow.
Do not fall back to merging `main` into the branch instead: a merge commit is
not what was asked for.

Force-push only the pull request branch the run was invoked on, and only when
the request calls for a rewrite. Never force-push `main` or any other branch,
and never rewrite a history you were not asked to.

### Modifying GitHub Actions Workflows

Claude cannot push changes to files under `.github/workflows/` directly,
because the GitHub token used by the action lacks the `workflows` permission.
Any patch to a workflow file MUST therefore be delivered as a new, complete
file under the `github-workflow-fix/` directory in the repository root instead
of editing the file in place:

1. Write the full, final contents of the workflow to
   `github-workflow-fix/<workflow-file-name>`, with the same file name as in
   `.github/workflows/` (e.g. `github-workflow-fix/check.yaml`). Do **not**
   edit the original file under `.github/workflows/`.
2. Make it a **complete** file — the entire workflow as it should look after
   the change, not just a diff or fragment — so it can be copied verbatim.
3. Commit it with the change that needs it, and list it in the report. In the
   PR description, note it as a proposed workflow change that a maintainer
   must move from `github-workflow-fix/` to `.github/workflows/`.

A maintainer moves the file into `.github/workflows/` in a separate commit and
removes `github-workflow-fix/`, so the directory exists only on a branch with
a proposed change that has not been moved yet. Pull before continuing on the
branch, as it may have gained such a commit.

Until the move, the checks of the pull request run the workflows under
`.github/workflows/`, not the proposed ones. A check that the change itself
breaks for the old workflow (a renamed script, a moved output directory) fails
until then; say so in the report. knip reads `.github/workflows/` too, so a
binary or script that only the old workflow names shows in
`pnpm knip:check` until the move.

### Branch Naming Conventions

When creating a branch from an issue, use a human-readable name that includes
the issue number and a short slug derived from the issue title:

```text
claude/issue-<number>-<short-slug>
```

- `<number>` is the GitHub issue number
- `<short-slug>` is a kebab-case summary of the issue title, kept short
  (3–6 words maximum, omit articles and filler words)

Do **not** use auto-generated timestamp suffixes (e.g.
`claude/issue-1957-20260612-2108`) — these are not human-readable and make
branch lists hard to scan.

### Fork PRs: Review Only

A PR from a fork (different owner than `freelensapp`) gets a review and
nothing else: no commits, no pushes, no branches. Its code is untrusted, and
the head of a fork PR can change between the moment a maintainer looks at it
and the moment the workflow checks it out, so nothing taken from the checkout
may reach `freelensapp/freelens-for-claude-extension`.

When a fork PR needs changes, a maintainer first copies the exact commit they
reviewed to a branch in this repository. From then on it is a
same-repository PR, which gets the full setup and the normal workflow. The
copy is made either locally (`gh pr checkout <N>`, then push the branch) or
by the Claude Task workflow, following "Copying a Fork PR" below.

### Copying a Fork PR

This applies to a Claude Task run whose prompt asks to copy a fork PR and
names the PR number and the full commit SHA to copy. It is a git-only task:
do not check out, read, build or run any of the PR's files, and do not
describe its changes, because they are untrusted input.

1. `git fetch origin refs/pull/<N>/head`.
2. Verify that `FETCH_HEAD` equals the given SHA. If it does not, or no full
   SHA was given, stop and report the actual head without pushing anything.
3. `git push origin <sha>:refs/heads/claude/pr-<N>`.
4. Open a PR from `claude/pr-<N>` to `main`. It MUST use the **exact same
   title** as the original PR, copied verbatim with no prefix, and its body
   is `Copy of #<N> at <sha>.` followed by the usual footer.
5. Comment on the original PR with a link to the new one.
