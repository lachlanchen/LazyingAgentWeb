# LazyingAgentWeb architecture

This document describes the implemented standalone package boundary.
Production is promoted independently from repository commits, with immutable
acceptance receipts and a verified rollback release. The historical Agent gate
is fail-closed. The v0.1.27 candidate remains compatible with current v0.1.25
production, preserving its capability-gated Search UI and enabling Agent only through the
accepted native AgInTi capability proof; without that proof, Agent remains
unavailable while Direct Chat continues as a separate LocalLLM data plane.
Voice messages and general artifact file upload/download remain unavailable.
Grounded search is a backward-compatible, default-disabled protocol extension:
the UI remains absent
unless AgInTi proves the exact Search capability, and current production makes
no claim that it does. The baseline Agent artifact surface is declarative plot,
table, and Markdown; the negotiated extension adds only bounded text/HTTPS
`sources` artifacts.
Exact requests containing one canonical fenced `python` block take a
deterministic bounded-execution path, bypass model planning, and preserve
failure and successor-run state for durable reload and exact idempotent Resume
behavior, including an optional corrected prompt. The PWA persists only the
non-private Chat/Agent workspace preference, never browser-owned chat history.
After a terminal Agent run, a later prompt resumes that exact predecessor as a
successor run instead of trying to start the thread again. Creation, start, and
resume mutations use immutable idempotency keys; one retry may resolve an
uncertain transport result without duplicating a run. A rejected prompt remains
editable and is not rendered as accepted history. Plot artifacts explicitly
occupy the workspace column and scale to the available message width, with
readable mobile ticks, non-scaling strokes, and wrapping legends.
Once a verified Agent thread has settled, selecting that same thread is an
idempotent view operation: it preserves the existing message and artifact DOM
instead of starting a redundant ledger replay. A failed or nonterminal replay
remains reopenable so recovery is never hidden by that optimization. An Agent
mutation with an unusable response enters the same fail-closed history fence:
the draft stays editable, but another mutation is rejected until reopening the
thread completes an authoritative read without redispatching the draft.
If the thread-creation response itself remains unavailable, the browser has no
thread identity to reopen; it instead retains the exact creation body and
idempotency key in memory. The next Send confirms that same creation before
starting one run, while thread navigation, mode changes, and PWA activation stay
fenced so they cannot discard or duplicate the ambiguous operation.
Numeric x-axis ticks use the shortest precision that still distinguishes every
displayed value. Their exact values remain in per-tick accessible labels and the
plot description, so responsive compaction does not discard analytical meaning.
When a failed or cancelled predecessor has no persisted assistant message, the
browser reserves that run's chronological assistant position before replaying
verified history, so a corrected successor's output and artifacts remain after
the earlier failure instead of being visually displaced by it.

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

Every browser API response carries the immutable current release identity. New
shells pin that identity on each request; an explicit mismatch is rejected
before body ingestion, while a missing request header remains a bounded
compatibility path for already-open predecessor tabs. Exact-origin iOS and PWA
requests may omit all or part of otherwise-valid Fetch Metadata: login remains
available, session/logout retain their normal CSRF rules, and Chat/Agent proceed
only after the browser session and CSRF mutation proof validate. Any present
wrong Fetch Metadata value still fails closed. Bounded outcome records contain only route/status
categories and these gate results—never prompts, identifiers, cookies, tokens,
or credentials.

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
5. closed idempotency receipts, immutable Direct Chat deletion receipts, and
   bounded retention metadata.

`CloudIndexStore` and `DirectChatStore` use separate SQLite application IDs and
migration chains. `CloudIndexStore` holds items 1, 3, 4, and their bounded
receipts. `DirectChatStore` holds item 2, a hash-linked immutable message ledger,
replayable generation deltas, terminal receipts, compaction snapshots, and
durable dispatch-lease metadata. When Direct Chat vision is enabled, it also
holds immutable canonical attachment bytes in an owner-private table; the
message ledger contains only the attachment MIME, size, dimensions, opaque ID,
and SHA-256 descriptor bound into its hash. The split makes it difficult for a future
presentation migration to silently acquire Direct Chat or Agent authority.

Schema v5 gives Direct Chat hard deletion an explicit durable authority. The
exact `POST /api/chat/threads/delete` mutation binds the authenticated account,
thread ID, current revision/hash cursor, CSRF proof, and idempotency key. It
refuses a current generation, stale cursor, or trailing user message with
unresolved send acceptance. In one immediate transaction, an immutable,
content-free receipt retaining only identity, cursor metadata, and digests is
written before the messages, attachments, generation state, compactions,
mutation receipts, and owning thread are removed. Exact ambiguous retries
replay the raw-key-free receipt, and its account/thread uniqueness permanently
retires the thread identifier. This authority applies only to cloud-owned
Direct Chat threads; Agent presentation-index removal and authoritative AgInTi
thread deletion remain separate operations.

### Private data and cache placement

The browser does not persist ordinary threads, messages, generations, image
previews, session tokens, or retry state in Cache Storage, localStorage,
sessionStorage, or IndexedDB. Authenticated history remains authoritative in
the cloud SQLite stores. The selected composer images and rendered attachment
URLs are page-memory state and are revoked at view and authentication
boundaries. Historical attachments are fetched only as their messages approach
the viewport, with bounded concurrency and a 16 MiB per-tab Blob LRU.
Historical object URLs and decoded surfaces have their own four-preview / 64
MiB estimated decoded-pixel LRU. Evicting either tier revokes the affected URL
and restores a tap-to-reload placeholder; the compressed-Blob bound therefore
cannot be bypassed by a historical image element retaining an evicted Blob.
Both history tiers are disposable, account-scoped by lifecycle rather than
durable identity, and are purged on logout, authentication loss, account
transition, or release activation. Up to four staged or just-sent composer images
are separate transient page memory and are revoked at their send, view, and
authentication boundaries. The encrypted, expiring, one-shot confirmed-update
composer handoff described below is the only narrow IndexedDB exception and
accepts at most four images and 16 MiB of canonical bytes.

The server may reuse a completed per-thread integrity audit from a bounded
in-process LRU. Entries are keyed by account and thread, guarded by SQLite's
`data_version`, and cleared before and after every local write transaction.
An external connection commit changes that version and invalidates the entire
store-local audit cache before another result can be reused. Write
preconditions and postconditions always bypass the cache, and opening a store
still performs the full database audit. This cache stores only the fact that a
specific database snapshot passed validation; it is not a second message or
attachment store.

Remembered browser sessions are independently bounded per account. Admission
purges expired rows first; when an account is full, the same immediate
transaction removes exactly its oldest-issued active session and inserts the
new digest-only session. Existing-token collisions are rejected before any
eviction, and deterministic selection plus account-qualified deletion prevents
cross-account rotation.

Schema v5 is the common Direct Chat migration target because deletion safety
depends on its durable authority receipts. The ordered schema-v4 attachment
tables are therefore materialized even when vision is disabled; attachment use
remains gated at the application boundary. Existing v3 attachment rows migrate
to ordered position zero atomically. A v5-aware service running with vision
disabled still serves authenticated previews and exact retries of committed
turns, but refuses new image turns and follow-ups that would reuse stored images.

A pre-v5 binary cannot reopen the migrated database. The activation boundary
blocks every dynamic API, stops the service, verifies sidecar-free SQLite
`DELETE` journal state, takes an offline private database backup, and preflights
a copy with the candidate release. That snapshot is restorable only while all
dynamic APIs remain blocked and before any v5 write authority or deletion API
activation. After that boundary, every rollback preserves the live v5 database
and uses a v5-aware binary; an older snapshot could discard accepted messages
or deletion authority.

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

- The PWA accepts one to four JPEG, PNG, HEIC, or HEIF still images and requires
  a text prompt. It accepts source files up to 24 MiB. JPEG/PNG source geometry
  is checked before decode; HEIC/HEIF files pass a bounded, byte-authoritative
  ISO-BMFF `ftyp` classifier before a feature-detected native decode, then face
  the same decoded-pixel bound. AVIF, sequences, conflicting brands, and
  malformed boxes fail closed. Canvas redraw/downscaling discards source
  metadata, and only canonical JPEG/PNG output may cross the wire or enter
  storage. Native preparation has an abort signal, one bounded deadline, a
  visible `Preparing images…` state, and epoch fences for mode, session, logout,
  and service-worker controller changes. Canonical output is limited to 4 MiB
  per image and 16 MiB per message. Its visible composer/message preview is
  independently bounded to 512 pixels and 512 KiB per image. No image is placed in
  Cache Storage, localStorage, or sessionStorage. A user-confirmed PWA update
  may place one encrypted, expiring, one-shot multi-image unsent-composer handoff in a
  dedicated IndexedDB store; it is never history, a send queue, or auto-sent.
- The BFF independently validates canonical base64, MIME/signature, structure,
  dimensions, metadata absence, digest, order, unique identifiers, count, and
  aggregate bytes. It atomically commits the prompt, descriptor-bound ledger
  row, all private BLOBs, and pending generation. Public message records contain
  only descriptors; authenticated preview bytes are
  same-origin `no-store` responses.
- The browser prepares stable thread/message/generation/idempotency identifiers.
  The store commits the user message and pending generation atomically, so an
  ambiguous retry returns the same turn without a second dispatch intent. Image
  JSON is serialized once before dispatch. On a lost response the browser first
  probes the stable generation ID; it re-uploads only when an authoritative 404
  proves absence. Once accepted, raw composer bytes and the serialized retry
  ticket are released before generation finishes.
- Direct Chat thread deletion is a separate cursor-bound, idempotent POST. The
  browser disables it during history restoration, finalization, an active
  generation, or ambiguous send acceptance; it clears the selected presentation
  only after authoritative success. A transport ambiguity retries the identical
  prepared ticket. The server's durable receipt permits exact replay while
  permanently preventing reuse of the deleted thread ID.
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
  draining remain authoritative. Upload reading has a bounded four-minute
  ceiling for the largest valid request; accepted text generation remains
  bounded to two minutes and accepted vision generation has a separate
  ten-minute ceiling.

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

A confirmed Update or explicit API release mismatch can carry only a definitively unsent composer
across that reload. The page encrypts a bounded record with AES-GCM, keeps the
random key only in a URL fragment, scrubs the fragment synchronously, then
atomically takes and deletes the record before validating its account, scope,
source/target release, age, digest, and up to four canonical images. Restoration never
dispatches a request. Passwords, active or ambiguous sends, generations, Agent
runs, and other browser-held workflows remain reload blockers. Malformed,
expired, and excess orphan ciphertexts are pruned.

`pageshow` and visible-state resume revalidate the server session. A revoked
session returns to sign-in while keeping unsent composer work in page memory;
an exact newer release uses a version-addressed navigation and the encrypted
handoff rather than discarding that work.

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
fixed `localllm-vision` alias and receive the latest image-bearing message's
complete ordered attachment set as one `image_url` content part per image,
followed by the text part. Base64 is created only for that
bounded in-flight connector request and is never written to a ledger, log,
receipt, cache, or browser storage.

Redirects, compressed or malformed streams, oversized frames/output, unknown
aliases, and partial-generation redispatch fail closed. The connector has no
tool interface and no hosted-provider, model, node, or authority fallback.

## Artifacts and visualization

AgInTi registers artifacts by opaque ID and validates ownership, provenance,
size, type and digest. The cloud never accepts a model-supplied path or URL.
Initial inline rendering is limited to exact versioned declarative plot, table
and Markdown schemas. A separately negotiated Search capability adds a
`sources` schema of at most 20 entries and 48 KiB total. Each entry has an exact
one-based index, literal title/snippet/provider metadata, `web` or `paper` kind,
nullable canonical publication date and DOI, and a credential-free HTTPS URL.
Source cards create text nodes and `noopener noreferrer` anchors only; they do
not issue fetches, previews, preloads, or image requests. Plot data is finite,
URL-free and expression-free; the browser builds DOM/SVG with text nodes.
Active HTML, SVG and PDF are never
served inline on the authenticated origin. File downloads, uploads and vision
inputs remain disabled until their independent byte, MIME, decompression,
ownership and sandbox acceptance matrices pass. Direct Chat's bounded multi-image
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

Agent mode is fail-closed: promotion requires automated adversarial tests to
prove ownership, CSRF/schema enforcement, exact routes, event replay,
idempotency, cancellation, context durability, artifact isolation, resource
admission, tunnel outage and rollback. A live Docker/model acceptance run is
additionally blocked whenever the shared-workstation resource policy fails.
Releases are immutable and retain the current and immediately previous
reproducible package with an executable rollback. Passing offline package tests
alone does not authorize deployment. Current v0.1.25 production exposes Agent
only while AgInTi returns the accepted native capability proof; removing or
invalidating that proof disables Agent. A live PWA or Direct Chat deployment
alone neither authorizes nor implies Agent enablement, and Direct Chat remains a
separate LocalLLM path. Search-bearing Agent start/resume requests are
preflighted against AgInTi's current capability before the mutation is
forwarded; there is no Web-to-LocalLLM search route. Voice messages and general
artifact file upload/download remain outside the accepted capability.
