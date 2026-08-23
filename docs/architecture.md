# LazyingAgentWeb architecture

This document describes the implemented standalone package boundary.
Production is promoted independently from repository commits, with immutable
acceptance receipts and a verified rollback release. AgInTi Agent remains
disabled until every native, sandbox, tunnel, resource, and live rollback
acceptance gate in the promotion rule passes.

## Product boundary

`llm.lazying.art` is one user experience over four independently useful
products. Integration does not transfer ownership between them.

| Product | Owns | Standalone surface | Never owns |
| --- | --- | --- | --- |
| LazyingAgentWeb | Cloud accounts, browser sessions, Direct Chat history/context/deltas, AgInTi presentation indexes, delivery cursors, safe rendering | PWA, cloud HTTP/BFF, SQLite stores, and Direct Chat context coordinator | Agent plans/messages/context, tools, Docker, Agent execution, inference implementation, tunnels |
| AgInTi | Agent threads, plans, context and compaction, tool/event ledger, execution, artifacts and cancellation | `aginti-cli`, Studio, native authenticated integration API | Cloud login, TLS ingress, LocalLLM implementation |
| LocalLLM | Text, coding, embedding and vision inference | OpenAI-compatible loopback API and its own local UI | Agent orchestration, cloud accounts, transport |
| LazyEdge | Exact authenticated transport between reviewed loopback services | CLI, manifests, doctor, render/apply/rollback operations | Chat or agent semantics, planning, inference, cloud persistence |

The PWA presents two explicit modes:

- **Chat** is a cloud-owned conversation product backed by stateless LocalLLM
  inference. Its messages and bounded chat-only context summaries may be stored
  by LazyingAgentWeb.
- **AgInTi Agent** is an alternate frontend for AgInTi. AgInTi remains the only
  authority for its messages, context, compaction, plans, tools, runs and
  artifacts. The cloud stores only presentation pointers and delivery cursors.

No code in LazyEdge implements either mode. It transports declared exact HTTP
contracts and can be replaced without migrating chat or agent state.

## Data planes

Direct chat:

```text
browser -> Caddy -> LazyingAgentWeb -> LazyEdge -> LocalLLM
```

Agent mode:

```text
browser -> Caddy -> LazyingAgentWeb -> LazyEdge -> AgInTi native API
                                                   |-> LocalLLM
                                                   `-> rootless sandbox
```

LazyingAgentWeb owns the stateless adapter at the application boundary. It
derives `x-aginti-principal-id` and `x-aginti-browser-session-id` from the
authenticated cloud session and uses standard `Idempotency-Key` only for
mutations. LazyEdge treats these as opaque application headers while stripping
its own reserved `x-lazyedge-*` namespace. AgInTi alone interprets the identity,
idempotency, thread, run, context, tool, and artifact semantics.

The browser never receives a relay, LocalLLM, AgInTi-integration, SSH or
sandbox credential. Each arrow authenticates independently. Caddy exposes only
reviewed exact web routes; every internal listener remains loopback-only.

## Cloud HTTP/BFF boundary

The implemented cloud server is a root-only Node service intended to bind on
`127.0.0.1` behind Caddy. It serves a factory-branded PWA asset map and exact
login, session, Direct Chat, and AgInTi-transport routes. It enforces the
configured HTTPS public origin, Caddy-overwritten authority/client-address
headers, Fetch Metadata, CSRF, idempotency, exact request schemas, body/time
limits, bounded per-session and global stream admission, and graceful draining
of Direct Chat jobs.

All owner identity is derived from the verified browser session. Public JSON
and SSE responses are copied through allowlisted projections and never expose
the internal `accountId`. The BFF accepts a stateless AgInTi adapter interface;
it does not persist adapter credentials or acquire Agent authority. Missing,
malformed, or unaccepted AgInTi capabilities collapse to the frozen disabled
capability contract.

The HTTP server does not terminate public TLS, manage Caddy or LazyEdge, launch
LocalLLM, start AgInTi, or create a sandbox. Those remain independently operated
components.

## Persistence

Cloud-authoritative storage is divided so ownership is visible in the schema:

1. identity, browser sessions and CSRF bindings;
2. direct-chat threads, messages and chat-only context windows;
3. non-authoritative AgInTi thread presentation pointers;
4. non-authoritative event delivery sequence/hash cursors;
5. closed idempotency receipts and bounded retention metadata.

`CloudIndexStore` and `DirectChatStore` use separate SQLite application IDs and
migration chains. `CloudIndexStore` holds items 1, 3, 4, and their bounded
receipts. `DirectChatStore` holds item 2, a hash-linked immutable message ledger,
replayable generation deltas, terminal receipts, compaction snapshots, and
durable dispatch-lease metadata. When Direct Chat vision is enabled, it also
holds immutable canonical attachment bytes in an owner-private table; the
message ledger contains only the attachment MIME, size, dimensions, opaque ID,
and SHA-256 descriptor bound into its hash. The split makes it difficult for a future
presentation migration to silently acquire Direct Chat or Agent authority.

The attachment migration is an explicit expand/enable boundary. New and
existing v2 databases remain at v2 while vision is disabled. First enablement
advances the private Direct Chat database to v3 atomically. A v3-aware service
can subsequently run with vision disabled: it still serves authenticated
previews and exact retries of committed turns, but refuses new image turns and
follow-ups that would reuse stored images. An older binary that knows only v2
cannot reopen the migrated database; backup or a retained v3-aware rollback
release is required before first enablement.

The cloud database must never contain AgInTi plans, agent context or summaries,
tool calls/results, commands, workspace paths, runtime policy, raw artifacts or
Docker state. Losing the presentation index cannot destroy an AgInTi thread.

AgInTi persists an append-only, hash-linked typed event ledger and its own
authoritative snapshots. Compaction records the exact source range, ledger
head, policy/permission digests, preserved evidence and unresolved work; it
does not rewrite the source ledger. Tool side effects are idempotent in AgInTi,
not reconstructed by the cloud.

Direct Chat compaction is different and remains cloud-owned. The
`DirectChatContextCoordinator` independently revalidates every source message
and hash, preserves a bounded exact recent suffix, and may ask only an injected
local summarizer to compact completed history. A summary carries exact source
revision/hash provenance and is labeled as untrusted conversation data with no
system, developer, policy, tool, or instruction authority. The coordinator
prepares capacity before the atomic turn starts; it never rewrites history or
runs a summarizer while a generation is active.

The standalone service injects a deterministic, networkless summarizer by
default. It does not call LocalLLM or any hosted model, so proactive compaction
cannot create a second inference outside the durable global dispatch fence. A
future model-assisted summarizer would require the same cross-process
admission, lease, and recovery contract as normal Direct Chat generation.

## Streaming and recovery

Direct Chat:

- The PWA accepts exactly one JPEG or PNG and requires a text prompt. It checks
  source dimensions before decode, redraws through canvas to discard source
  metadata, and rejects canonical output above 4 MiB. No image is placed in
  Cache Storage, localStorage, or sessionStorage. A user-confirmed PWA update
  may place one encrypted, expiring, one-shot unsent-composer handoff in a
  dedicated IndexedDB store; it is never history, a send queue, or auto-sent.
- The BFF independently validates canonical base64, MIME/signature, structure,
  dimensions, metadata absence, and digest. It atomically commits the prompt,
  descriptor-bound ledger row, private BLOB, and pending generation. Public
  message records contain only the descriptor; authenticated preview bytes are
  same-origin `no-store` responses.
- The browser prepares stable thread/message/generation/idempotency identifiers.
  The store commits the user message and pending generation atomically, so an
  ambiguous retry returns the same turn without a second dispatch intent.
- Before calling LocalLLM, one cloud worker claims a durable lease with a
  monotonic fence and marks dispatch started. Append, finalize, failure, and
  renewal require that proof. A restarted or stale worker cannot continue after
  losing the lease, and a partially streamed stateless generation is never
  blindly redispatched.
- Each bounded text delta is persisted before it is exposed. Browser reconnect
  replays after its last sequence, then follows new SSE data. Finalization adds
  one assistant message to the same hash-linked ledger exactly once.
- Explicit Stop durably cancels the generation and invalidates its lease.
  Viewer disconnect only detaches the stream; server job limits and shutdown
  draining remain authoritative.

AgInTi Agent:

- A start mutation uses a caller-generated idempotency key. Ambiguous delivery
  is retried with the same key; AgInTi must return the original run instead of
  dispatching again.
- AgInTi persists an event before emitting it and assigns a strictly increasing
  sequence plus hash-chain fields. The cloud validates and reserializes only a
  bounded public envelope; it does not cache or regenerate the authoritative
  event.
- Browser reconnect supplies the last accepted sequence/hash. Reconnect only
  replays; it never starts or resumes work.
- Viewer disconnect detaches. Explicit Stop is an idempotent AgInTi
  cancellation. If the tunnel is offline, the UI says cancellation is pending
  until AgInTi confirms a terminal state; AgInTi's hard runtime limit remains
  the final bound.

## PWA release and update lifecycle

`createStandaloneAssetMap()` derives each immutable release identifier from the
complete shell content plus pinned generator, module-lexer, and KaTeX build
inputs. The branded map records a second digest over final descriptors. The
HTML metadata, service-worker cache name, manifest, exact security headers, and
complete browser module graph must all prove the same release. JavaScript, CSS,
KaTeX, and icons live below `/assets/r/<release>/`; relative module imports
therefore cannot mix files from two deployments.

`/sw.js` is deliberately stable and is always served with `no-store`,
`no-cache`, and `must-revalidate`. The browser registers that one URL with
`updateViaCache: "none"`. An already-controlled page checks it at startup and
on a bounded foreground or online transition; a fresh uncontrolled install
skips the redundant immediate check and joins the same periodic schedule. The
stable registration can therefore discover v1, v2, v3, and later releases
without another version endpoint. A successor installs a separate complete
shell cache but remains waiting. Before showing anything, the page asks that
specific worker to prove its immutable release over a one-shot message channel.
A positively verified worker matching the loaded HTML is silent; a verified
successor, or a legacy worker that cannot answer within the bounded proof
window, is offered through **Update** or **Later**:

- **Later** leaves the current worker and offline shell untouched.
- **Update** explicitly requests activation and reloads the page exactly once
  after `controllerchange`.
- A failed or offline update leaves the current app usable and retries after
  connectivity returns.

A confirmed Update can carry only a definitively unsent Direct Chat composer
across that reload. The page encrypts a bounded record with AES-GCM, keeps the
random key only in a URL fragment, scrubs the fragment synchronously, then
atomically takes and deletes the record before validating its account, scope,
source/target release, age, digest, and canonical image. Restoration never
dispatches a request. Passwords, active or ambiguous sends, generations, Agent
runs, and other browser-held workflows remain reload blockers. Malformed,
expired, and excess orphan ciphertexts are pruned.

Before caching, the service worker requires the exact same-origin URL, status,
MIME type, declared shell security headers, byte length, and SHA-256 for every
asset. Activation keeps only the current and immediately previous verified
shell for its normalized scope. The page performs at most one reload per tab
after a confirmed `controllerchange`.

Only the immutable public shell is cached. Login, session, Direct Chat, Agent,
SSE, artifact, upload, and all other API responses bypass Cache Storage. The
server must stage the complete release namespace before atomically switching
the root HTML and stable service-worker response.

## LocalLLM connector

The Direct Chat connector accepts only an unprivileged exact
`http://127.0.0.1:<port>/v1` authority, representing the reviewed local LazyEdge
service endpoint. A server-side provider supplies its bearer credential for
each request. The connector uses an allowlist of fixed `localllm-*` aliases,
checks `/models` readiness, sends bounded provenance-checked Direct Chat
context, and consumes only strict OpenAI-compatible SSE text deltas. A thread
uses its text alias until its first image; that turn and later turns use the
fixed `localllm-vision` alias and receive the latest private attachment as one
OpenAI-compatible `image_url` content part. Base64 is created only for that
bounded in-flight connector request and is never written to a ledger, log,
receipt, cache, or browser storage.

Redirects, compressed or malformed streams, oversized frames/output, unknown
aliases, and partial-generation redispatch fail closed. The connector has no
tool interface and no hosted-provider, model, node, or authority fallback.

## Artifacts and visualization

AgInTi registers artifacts by opaque ID and validates ownership, provenance,
size, type and digest. The cloud never accepts a model-supplied path or URL.
Initial inline rendering is limited to exact versioned declarative plot, table
and Markdown schemas. Plot data is finite, URL-free and expression-free; the
browser builds DOM/SVG with text nodes. Active HTML, SVG and PDF are never
served inline on the authenticated origin. File downloads, uploads and vision
inputs remain disabled until their independent byte, MIME, decompression,
ownership and sandbox acceptance matrices pass. Direct Chat's single-image
input is the narrow exception: it is descriptor-bound, owner-private,
metadata-stripped, independently revalidated, and has no Agent or artifact
authority.

## Replaceable nodes

Every enrolled compute node advertises a stable node identity plus independently
versioned contracts for AgInTi, LocalLLM and transport. A capability response is
truthful only when it includes the implementation version, instance identity,
policy digest, isolation digest, health/admission state and supported artifact
schemas. The cloud must not infer capability from a TCP connection or a
self-asserted boolean.

A Raspberry Pi, Jetson, Kria, workstation or robot may provide a subset of
services. Threads remain pinned to their AgInTi authority node until an explicit
AgInTi export/import or migration succeeds. There is no silent hosted-provider,
node or model fallback. Removing a node removes routing only after its owned
threads are migrated or intentionally left offline.

## Independent health and failure semantics

- LazyingAgentWeb's operator-only `health --config` contract reports
  `CloudIndexStore` and `DirectChatStore` independently, binds the result to the
  exact shell release, and gives LocalLLM and configured AgInTi separate bounded
  states. It emits only fixed projections and does not add a public health
  route.
- LazyEdge doctor proves transport policy, listeners and tunnel health, not
  application capability. LazyingAgentWeb therefore always reports LazyEdge as
  `not_probed` and makes no transport-health claim.
- AgInTi readiness proves native ownership, durable idempotency/event state,
  fixed runtime policy and current sandbox/resource admission.
- LocalLLM reports API/model availability without claiming agent readiness.
- Static PWA/login remains available during local outages. Chat and Agent show
  distinct dependency failures and never fall back to a hosted provider.

## Promotion rule

Agent mode remains disabled until automated adversarial tests prove ownership,
CSRF/schema enforcement, exact routes, event replay, idempotency, cancellation,
context durability, artifact isolation, resource admission, tunnel outage and
rollback. A live Docker/model acceptance run is additionally blocked whenever
the shared-workstation resource policy fails. Releases are immutable and retain
the current and immediately previous reproducible package with an executable
rollback. Passing offline package tests alone does not authorize deployment.
The current live PWA/Direct Chat deployment does not authorize or imply Agent
enablement.
