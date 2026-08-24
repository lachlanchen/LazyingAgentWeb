# LazyingAgentWeb

`@lazyingart/agent-web` is the standalone cloud PWA and HTTP/BFF for
`llm.lazying.art`. It provides a usable browser chat surface while keeping
AgInTi, LocalLLM, and LazyEdge independently replaceable.

> **Deployment status (v0.1.20 production):** production is promoted
> independently from repository commits, with immutable acceptance receipts and
> a verified rollback release. The current deployment enables AgInTi Agent only
> through the accepted native AgInTi capability proof; if that proof is absent
> or disabled, the BFF fails closed and Agent is unavailable. Direct Chat stays
> separate and does not enable or authorize Agent. Current accepted Agent
> requests can execute one exact fenced `python` block without model planning,
> retain public failure reasons across reload, and follow exact idempotent Resume
> successor runs with an optional corrected prompt. Direct Chat remembers the
> user's non-private workspace-mode preference across a full reload, while
> confirmed sign-out fences stale history reads.
> Accepted artifacts remain limited to declarative plot, table, and Markdown schemas; voice
> messages, web/deep research, and general artifact file upload/download remain
> unavailable.

The ownership model, Chat/Agent data planes, recovery semantics, artifact
boundary, and replaceable-node contract are specified in
[docs/architecture.md](docs/architecture.md).

## Implemented surface

- A bright-by-default installable PWA with persistent theme and workspace-mode preferences,
  browser-password-manager integration, durable thread restoration, resumable
  streaming, explicit cancellation, optional one-to-four-image Direct Chat input,
  Markdown, KaTeX math, and safe declarative plot/table/Markdown rendering.
- A root-only Node HTTP/BFF with exact routes, host/origin/fetch-metadata/CSRF
  enforcement, opaque remembered sessions, bounded request/stream/job
  admission, owner-safe response projections, and graceful job draining.
- `CloudIndexStore` for cloud accounts, digest-only browser sessions,
  presentation-only AgInTi thread indexes, delivery cursors, and closed
  idempotency receipts.
- `DirectChatStore` for cloud-owned Direct Chat threads and hash-linked message
  ledgers, atomic user-message/generation start, durable fenced dispatch leases,
  exact-once assistant finalization, replayable deltas, cancellation, bounded
  retention, compaction snapshots, private immutable vision attachments, and
  receipt-authorized Direct Chat thread deletion.
- `DirectChatContextCoordinator` for bounded LocalLLM context assembly and
  provenance-bound chat compaction. The standalone service uses a deterministic
  local summarizer that performs no model or network call, so compaction cannot
  bypass the single-inference admission fence. Summaries are explicitly
  labeled untrusted conversation data and never gain system, developer,
  policy, tool, or Agent authority.
- `createLocalLlmConnector()` for a fixed set of LocalLLM model aliases over an
  exact authenticated `127.0.0.1` OpenAI-compatible `/v1` endpoint. It validates
  models and SSE frames, bounds input/output, rejects redirects and partial
  redispatch, sends canonical images only through the fixed `localllm-vision`
  alias, and has no hosted-provider fallback.
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
`updateViaCache: "none"`. Controlled pages check at startup and on bounded
foreground/online transitions, while a fresh uncontrolled install skips a
redundant immediate update race. A complete successor shell is verified by
exact URL, MIME type, security headers, byte length, and SHA-256 before it can
wait for activation.
The page proves a waiting worker's release over a one-shot message channel and
suppresses the banner only when it exactly matches the loaded shell. The UI
offers **Update** and **Later** for a verified successor, conservatively falling
back to the same offer for an unresponsive legacy worker; Update reloads once
only after the new worker controls the tab. Activation retains the current and
immediately previous verified shell. An offline or failed update leaves the
current app usable.

If Update is confirmed while a definitively unsent Direct Chat prompt or
single image is still in the composer, the page stores one bounded AES-GCM
ciphertext in a dedicated IndexedDB store. Its random key exists only in the replacement
navigation fragment, which is scrubbed before asynchronous startup. The exact
account, scope, source/target releases, expiry, digest, and canonical image
contract are revalidated; the record is atomically consumed once and is never
auto-sent. Expired, malformed, and excess orphan records are pruned. Passwords,
active sends, generations, Agent runs, and ambiguous mutations cannot use this
handoff.

An unsent multi-image selection is intentionally ineligible for that handoff:
the current page stays open and refuses activation rather than copying up to
16 MiB of private image data into browser storage.

Only immutable public shell assets enter Cache Storage. Login/session, Direct
Chat, Agent, SSE, artifact, and upload traffic always bypasses it. Production
must stage the entire immutable namespace before atomically switching the root
HTML and stable worker response.

Authenticated history and original attachment bytes remain authoritative in
the cloud SQLite stores. The PWA may keep only a disposable, bounded per-tab
Blob LRU for viewport-near attachment previews; it is never written to browser
storage and is purged across authentication, account, and release boundaries.
Historical rendered previews have a separate four-image / 64 MiB estimated
decoded-pixel limit. Eviction revokes the object URL and leaves a tap-to-reload
placeholder, so scrolling through a long image thread cannot retain every
decoded surface. Up to four staged or just-sent composer images are transient
rather than part of this history cache and are revoked at their existing send, view, and
authentication boundaries.
The server similarly caches only successful integrity-audit state, bounded by
thread and invalidated by every local write or SQLite `data_version` change.
It does not duplicate or relax validation of private message data.

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
    "allowedModelAliases": ["localllm-deep", "localllm-vision"],
    "defaultModelAlias": "localllm-deep",
    "vision": { "enabled": false }
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
bearer values never appear in the JSON. Credential directories and files may
be systemd `LoadCredential` material owned by root (including its read-only
root-group delivery modes under `/run/credentials/<unit>/`) or owner-only
files owned by the service account;
symlinks, hard links, world access, and any non-owner write access remain
rejected. The preferred fixed-parameter scrypt verifier uses a 64-byte
derived key, while the canonical 32-byte verifier used by the current v0.2
login is accepted for a password-preserving migration. Set `aginti` to
`{ "enabled": false }`
and omit `credentials.agintiToken` when the Agent transport is intentionally
absent. Configuring the transport does not claim Agent readiness: capability
discovery stays fail-closed until AgInTi itself proves its native API, policy,
sandbox, and current resource admission.

Before switching an edge proxy to a candidate build, derive its exact,
secret-free static allowlist from that same installed package and config:

```sh
lazying-agent-web edge-routes --config /etc/lazying-agent-web/service.json
```

The JSON contract contains the candidate content-bound `releaseId`, the exact
`GET`/`HEAD` paths, and the query-bearing request targets used by the service
worker. Stage and validate the proxy from this output, switch the proxy and app
as one release, then verify every request target before retiring the previous
allowlist. Unknown or foreign release assets must continue to return 404.

Operators can inspect the deployed release and its decoupled runtime state
without adding a public HTTP endpoint:

```sh
lazying-agent-web health --config /etc/lazying-agent-web/service.json
```

The command opens `CloudIndexStore` and `DirectChatStore` state read-only and
reports them independently. LocalLLM and configured AgInTi probes are bounded;
their errors collapse to fixed reason codes. Paths, origins, account identity,
credentials, and raw upstream responses are never emitted. LazyEdge is always
reported as `not_probed` with `healthClaim: false`; use LazyEdge doctor for
transport health. A degraded or unavailable report exits nonzero. This is an
operator diagnostic, not a public liveness endpoint: `/health` and
`/api/health` remain default-deny 404s, and dependency health does not gate the
static shell.

Direct Chat vision remains fail-closed when `localLlm.vision` is absent or
disabled. Enabling it requires the fixed `localllm-vision` alias while keeping a
different default text alias. The PWA accepts one to four JPEG, PNG, HEIC, or
HEIF still images plus a non-empty prompt and accepts each source file up to
24 MiB. HEIC/HEIF support uses only a feature-detected native browser decoder;
AVIF, sequences, conflicting brands, and malformed ISO-BMFF framing fail closed.
The browser redraws and downscales every accepted source sequentially through a
canvas to remove source metadata, and only canonical JPEG/PNG bytes can cross
the wire or enter storage. Slow native decoding exposes a visible and accessible
`Preparing images…` state; timeout, cancellation, session changes, and PWA
controller changes fence late decoder completions. It enforces 4 MiB per
canonical image and 16 MiB per message. A separate preview is bounded to 512
pixels and 512 KiB so a visible
mobile gallery never retains the full upload surfaces.
The server independently validates MIME, framing, dimensions, metadata absence,
digest, ordering, unique attachment IDs, count, and aggregate bytes before
committing the user message, every private image, and the generation atomically.

A minimal in-process storage-only probe is:

```js
import { CloudIndexStore, createCapabilityContract } from '@lazyingart/agent-web';

const store = new CloudIndexStore({
  databasePath: '/srv/lazying-agent-web/private/index.sqlite'
});

console.log(createCapabilityContract());
console.log(store.healthCheck()); // DirectChatStore exposes the same safe shape.
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

Browser-session admission first removes expired rows. At the per-account cap,
a successful new login atomically rotates only that account's oldest-issued
session, with a deterministic digest tie-break; token collisions fail before
eviction. This keeps sign-in available without deleting another account's
session or temporarily exceeding the cap.

Idempotency rows are bounded closed receipts rather than arbitrary response
caches. Direct Chat starts a user message and its pending generation in one
transaction. A durable owner digest plus monotonic fence prevents two cloud
workers from dispatching the same generation concurrently; a stale worker
cannot append or finalize after losing its lease.

Direct Chat deletion is a distinct exact mutation:
`POST /api/chat/threads/delete` requires the authenticated browser session,
CSRF proof, a caller-generated idempotency key, and the exact current
revision/hash cursor. The store refuses an active generation, a stale cursor,
or a trailing user message whose send acceptance is unresolved. On success it
atomically writes a content-free schema-v5 deletion receipt containing only
identity, cursor metadata, and digests before removing the thread and its
private descendants. The receipt is immutable, supports an exact retry without
retaining the raw key or deleted content, and permanently retires that
account/thread identifier. This route deletes only cloud-owned
Direct Chat state; deleting an Agent presentation index or an authoritative
AgInTi thread remains a separate contract.

Canonical attachment bytes are durable only in the owner-private Direct Chat
database. The message ledger and browser API expose a size/dimension/MIME/SHA-256
descriptor, never the bytes or base64. Authenticated previews are `no-store`
responses, and image data never enters Cache Storage, localStorage, or
sessionStorage. IndexedDB is used only for the encrypted, expiring, one-shot
confirmed-update handoff described above; it is not chat history or a retry
queue. Base64 exists only transiently in the browser's exact in-memory retry
ticket and the bounded browser-to-BFF and BFF-to-LocalLLM request bodies. The
browser serializes a prepared image request once before entering the network
ambiguity boundary, reuses those exact bytes only when a status probe proves
the generation absent, and releases the raw images and serialized ticket as
soon as the server accepts the durable turn.

Ordered attachment responses use an explicit message-list schema request. A
previous PWA that omits it receives the first descriptor in the legacy singular
shape, so a stale open tab keeps its text/history protocol valid until the
content-versioned PWA refresh takes control.

Schema v5 adds the durable authority receipts required for safe Direct Chat
thread deletion. It is now the common Direct Chat schema whether vision is
enabled or disabled, so the ordered v4 attachment tables are materialized on
upgrade while image use remains fail-closed at the application boundary.
Existing v3 single-image rows still migrate to ordered position zero. A v5-aware
build running with vision disabled can serve authenticated previews and exact
retries of previously committed image turns, but refuses new image turns and
follow-ups that would reuse stored images.

A pre-v5 binary cannot reopen the migrated database. Before activation, block
every dynamic API, stop the service, verify sidecar-free SQLite `DELETE`
journal state, take an offline private database backup, and preflight a copy of
that backup with the candidate release. The snapshot may be restored only
while all dynamic APIs remain blocked and before any v5 write authority or the
v5 deletion API is activated. After that boundary, preserve the live v5
database and use only a v5-aware rollback release; restoring the older snapshot
could discard accepted messages or deletion authority.

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
