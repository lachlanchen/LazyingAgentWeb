# LazyingAgentWeb

`@lazyingart/agent-web` is the standalone cloud PWA and HTTP/BFF for
`llm.lazying.art`. It provides a usable browser chat surface while keeping
AgInTi, LocalLLM, and LazyEdge independently replaceable.

> **Current status:** this repository contains the implementation and its
> offline acceptance tests, but this release has **not been deployed** to
> `llm.lazying.art`. AgInTi Agent mode remains fail-closed and disabled until
> its native API, sandbox, replay/cancellation, resource-admission, tunnel, and
> live rollback gates all pass. Direct Chat and the static PWA do not imply that
> Agent mode is ready.

The ownership model, Chat/Agent data planes, recovery semantics, artifact
boundary, and replaceable-node contract are specified in
[docs/architecture.md](docs/architecture.md).

## Implemented surface

- A bright-by-default installable PWA with persistent theme preference,
  browser-password-manager integration, durable thread restoration, resumable
  streaming, explicit cancellation, Markdown, KaTeX math, and safe declarative
  plot/table/Markdown rendering.
- A root-only Node HTTP/BFF with exact routes, host/origin/fetch-metadata/CSRF
  enforcement, opaque remembered sessions, bounded request/stream/job
  admission, owner-safe response projections, and graceful job draining.
- `CloudIndexStore` for cloud accounts, digest-only browser sessions,
  presentation-only AgInTi thread indexes, delivery cursors, and closed
  idempotency receipts.
- `DirectChatStore` for cloud-owned Direct Chat threads and hash-linked message
  ledgers, atomic user-message/generation start, durable fenced dispatch leases,
  exact-once assistant finalization, replayable deltas, cancellation, bounded
  retention, and compaction snapshots.
- `DirectChatContextCoordinator` for bounded LocalLLM context assembly and
  provenance-bound chat compaction. The standalone service uses a deterministic
  local summarizer that performs no model or network call, so compaction cannot
  bypass the single-inference admission fence. Summaries are explicitly
  labeled untrusted conversation data and never gain system, developer,
  policy, tool, or Agent authority.
- `createLocalLlmConnector()` for a fixed set of LocalLLM model aliases over an
  exact authenticated `127.0.0.1` OpenAI-compatible `/v1` endpoint. It validates
  models and SSE frames, bounds input/output, rejects redirects and partial
  redispatch, and has no hosted-provider fallback.
- A fail-closed AgInTi BFF transport and cloud-owned stateless adapter. The
  browser can call only the frozen public protocol; the server derives
  identity/session context, validates exact requests and responses, and sends
  only `x-aginti-principal-id`, `x-aginti-browser-session-id`, and standard
  `Idempotency-Key` authority to AgInTi. LazyEdge remains an opaque transport;
  Agent state and decisions never move into this package.

## Component boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| LazyingAgentWeb | Cloud accounts and browser sessions; Direct Chat history, deltas, and chat-only context; AgInTi presentation pointers and delivery cursors; PWA and safe rendering | Agent plans, Agent messages/context/compaction, tools, execution, artifact authority, inference implementation, tunnels |
| AgInTi | Authoritative Agent threads, runs, plans, context, compaction, tools, event ledger, cancellation, and artifacts | Cloud login/session policy, LocalLLM inference implementation, LazyEdge transport |
| LocalLLM | Text, coding, embedding, and vision inference | Chat persistence, Agent orchestration, cloud accounts, edge transport |
| LazyEdge | Authenticated, replaceable transport between the cloud BFF and exact enrolled local services | Chat or Agent semantics, model behavior, cloud presentation state |

Direct Chat is deliberately cloud-owned because LocalLLM inference is
stateless. Agent mode is only another frontend for AgInTi: the cloud database
must not contain AgInTi messages, summaries, plans, tool calls/results,
commands, workspace paths, runtime policy, artifact bodies, or sandbox state.
Removing a cloud Agent index cannot delete its authoritative AgInTi thread.

## PWA releases and latest-version reload

`createStandaloneAssetMap()` builds and brands a complete release map. Its
immutable release ID is derived from the full shell content and pinned build
inputs, and every JavaScript module, CSS file, KaTeX module, and icon is placed
under `/assets/r/<release>/`. The server accepts only that verified branded map;
it cannot be paired with a caller-invented release ID.

The update authority is the stable `/sw.js` route, served with `no-store`,
`no-cache`, and `must-revalidate`. The browser registers it with
`updateViaCache: "none"` and checks at startup and on bounded foreground/online
transitions. A complete successor shell is verified by exact URL, MIME type,
security headers, byte length, and SHA-256 before it can wait for activation.
The UI offers **Update** and **Later**; Update reloads once only after the new
worker controls the tab. Activation retains the current and immediately
previous verified shell. An offline or failed update leaves the current app
usable.

Only immutable public shell assets enter Cache Storage. Login/session, Direct
Chat, Agent, SSE, artifact, and upload traffic always bypasses it. Production
must stage the entire immutable namespace before atomically switching the root
HTML and stable worker response.

## Public package entry point

The package root exports the implemented server and storage primitives plus the
browser/PWA protocol:

```js
import {
  CloudIndexStore,
  DirectChatContextCoordinator,
  DirectChatStore,
  createAgintiAgentAdapter,
  createCloudServer,
  createLocalLlmConnector,
  createStandaloneAssetMap,
  failClosedCapabilities
} from '@lazyingart/agent-web';
```

The three runtime stores/coordinators are intentionally injected into
`createCloudServer()` rather than hidden behind globals. The LocalLLM connector
also receives its transport credential through a server-side provider; neither
that credential nor an AgInTi/LazyEdge credential is sent to the browser or
stored in this repository.

## Standalone service configuration

`lazying-agent-web serve` reads one owner-only JSON configuration and separate
owner-only `LoadCredential` files. A secret-free shape is:

```json
{
  "schema": "lazying-agent-service/v1",
  "listen": { "host": "127.0.0.1", "port": 18543 },
  "publicOrigin": "https://llm.lazying.art",
  "account": {
    "username": "lachlanchen",
    "principalId": "principal_account_one",
    "displayName": "Lachlan"
  },
  "state": {
    "cloudIndexDatabase": "/var/lib/lazying-agent-web/cloud/index.sqlite",
    "directChatDatabase": "/var/lib/lazying-agent-web/chat/chat.sqlite"
  },
  "pwa": {
    "versionLabel": "release",
    "title": "LazyingArt Agent",
    "name": "LazyingArt Agent",
    "shortName": "Lazying Agent"
  },
  "localLlm": {
    "baseUrl": "http://127.0.0.1:18008/v1",
    "allowedModelAliases": ["localllm-deep"],
    "defaultModelAlias": "localllm-deep"
  },
  "aginti": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:18009"
  },
  "credentials": {
    "passwordHash": "login-password-hash",
    "localLlmToken": "localllm-token",
    "agintiToken": "aginti-token"
  }
}
```

The filenames identify distinct credential files; raw password verifiers and
bearer values never appear in the JSON. Set `aginti` to `{ "enabled": false }`
and omit `credentials.agintiToken` when the Agent transport is intentionally
absent. Configuring the transport does not claim Agent readiness: capability
discovery stays fail-closed until AgInTi itself proves its native API, policy,
sandbox, and current resource admission.

A minimal storage-only probe is:

```js
import { CloudIndexStore, createCapabilityContract } from '@lazyingart/agent-web';

const store = new CloudIndexStore({
  databasePath: '/srv/lazying-agent-web/private/index.sqlite'
});

console.log(createCapabilityContract());
console.log(store.healthCheck());
store.close();
```

## Runtime

- Node.js 22.21.0 or newer, with the built-in `node:sqlite` module.
- Exact runtime dependencies `es-module-lexer@2.3.1` and `katex@0.16.47`.
- A local filesystem with normal POSIX ownership and locking semantics for the
  private SQLite directories.

`node:sqlite` emits an experimental warning on the tested Node 22.21.0 runtime.
No native SQLite addon or browser CDN is used. The pinned parser verifies the
complete immutable module graph, and the pinned KaTeX module provides local
math rendering under the release namespace.

## Storage and HTTP safety

Both SQLite stores require absolute on-disk paths. They create state directories
with mode `0700` and databases with mode `0600`, and reject symlinks, foreign
owners/application IDs, insecure permissions, hard-linked database files,
future schemas, migration checksum drift, integrity failures, and foreign-key
corruption. SQLite uses `DELETE` journaling, `FULL` synchronous writes, foreign
keys, `trusted_schema=OFF`, disabled extension loading, a bounded busy timeout,
and `BEGIN IMMEDIATE` mutations.

Raw browser session and CSRF tokens are never stored; `CloudIndexStore` retains
only SHA-256 digests. An HTTP adapter derives every `accountId` from the verified
browser session. Browser payloads and public JSON/SSE projections never choose
or expose that owner identifier.

Idempotency rows are bounded closed receipts rather than arbitrary response
caches. Direct Chat starts a user message and its pending generation in one
transaction. A durable owner digest plus monotonic fence prevents two cloud
workers from dispatching the same generation concurrently; a stale worker
cannot append or finalize after losing its lease.

The production server is designed to bind on loopback behind Caddy. It trusts
the configured public authority/client-address headers only from that local
proxy boundary. It does not terminate public TLS, manage a LazyEdge tunnel, or
launch LocalLLM/AgInTi/sandboxes itself.

## Checks

Run the offline checks with:

```sh
npm run check
npm test
```

These checks do not deploy the package or exercise the blocked live
Docker/model acceptance gate.
