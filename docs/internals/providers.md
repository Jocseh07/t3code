# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).

## pi RPC transport

Fork-local driver. After merging upstream, follow
[pi-provider-maintenance.md](./pi-provider-maintenance.md).

The [driver](../../apps/server/src/provider/Drivers/PiDriver.ts) wraps the user's `pi` binary in
`--mode rpc`, one process per thread, speaking pi's LF-delimited JSONL through the
[client](../../apps/server/src/provider/pi/PiRpcClient.ts). The
[event mapper](../../apps/server/src/provider/pi/PiRuntimeEvents.ts) is pure; the adapter owns
`turn.started` and `turn.completed` around a `prompt` command and pi's `agent_settled`.

pi has no native permission prompt in RPC mode. T3 materializes a small
[extension](../../apps/server/src/provider/pi/piExtension.ts) into
`<stateDir>/providers/pi/extensions/t3-code.ts` and loads it with `-e`. Its `tool_call` handler
reads `T3_PI_RUNTIME_MODE` and, for tools the mode does not auto-approve, calls `ctx.ui.select`
with a `{ t3: "t3-approval", toolCallId, toolName, input }` envelope. pi turns that into an
`extension_ui_request`, which the adapter maps to `request.opened`; the decision returns as
`extension_ui_response`. `full-access` gates nothing, `auto-accept-edits` gates everything except
`edit`, `write`, and read-only tools, and `approval-required` and `auto` gate every non-read tool.
`acceptForSession` is remembered in the extension by tool name plus serialized input. `-e` is
additive: the user's global extensions, packages, skills, and `models.json` load as in the
terminal. Project-local `.pi/` resources follow pi's saved trust decision because
non-interactive modes never prompt.

User questions use the same dialog channel. An extension that wants a T3 question card calls
`ctx.ui.select` with a `{ t3: "t3-question", question, options }` title and the option labels plus
`__t3_other__`; the adapter emits `user-input.requested` with `allowCustomAnswer: true`. An
answer matching a label is returned as the select value. Any other text is held on the session and
the adapter replies `__t3_other__`; the extension then opens `ctx.ui.input` with a
`{ t3: "t3-question-custom", question }` title, which the adapter answers from the held text
without showing a second card. Dismiss, Stop, and session teardown reply `cancelled`. The
reference caller is the user's `ask_user` extension; pi itself raises no questions.

The same extension bridges T3's MCP server. When `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` are set
it runs `initialize` and `tools/list` against the Streamable HTTP endpoint and registers each tool
as `t3_<name>`, forwarding `tools/call`. Failure to reach the server is logged to stderr and pi
continues without the preview toolkit.

Model slugs are `provider/id` from pi's `get_available_models`, which lists only models with
working credentials. `pi-default` is a sentinel meaning "pi's own default" and is never sent to
`set_model`. Thinking levels are exposed as the `thinkingLevel` option; the adapter applies
`set_model` and `set_thinking_level` before each prompt, so `sessionModelSwitch` is `in-session`.
Native conversation rollback is unsupported.

The resume cursor is `{ schemaVersion: 1, sessionFile }` from `get_state`; a restart passes
`--session <file>` so pi reloads its own history, and the thread stays visible to `pi -r`. The
health check runs `pi --version` and one ephemeral `--no-session` RPC session for `get_state`,
`get_available_models`, and `get_commands`; an empty model list reports `unauthenticated`. Text
generation uses `pi -p --no-tools --no-extensions --no-session --no-approve`. Neither opens a
persistent session, in keeping with the health-check rule above.
