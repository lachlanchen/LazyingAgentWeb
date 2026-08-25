import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGINTI_RPC_PATHS,
  AGINTI_SEARCH_MODES,
  AgintiProtocolError,
  FAIL_CLOSED_AGENT_CAPABILITIES,
  canonicalJson,
  failClosedCapabilities,
  initialEventCursor,
  validateAgentCapabilities,
  validateAgentRequest,
  validateAgentSearch,
  validateAgentResponse,
  validateArtifact,
  validateEventEnvelope,
  verifyAgentEvent,
} from "../src/web/aginti-protocol.js";
import {
  AgintiBrowserClient,
  AgintiTransportError,
  selectDefaultMode,
} from "../src/web/aginti-client.js";
import { createRunPresentation } from "../src/web/presentation-state.js";

const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";
const RUN_ID = "run_12345678-1234-4123-8123-123456789abc";
const SECOND_RUN_ID = "run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_ID = `art_${"a".repeat(64)}`;
const NOW = "2026-08-20T08:00:00.000Z";
const ZERO_HASH = "0".repeat(64);
const RELEASE = `release-${"a".repeat(64)}`;
const NEXT_RELEASE = `release-${"b".repeat(64)}`;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function capabilities(overrides = {}) {
  return {
    schemaVersion: "1",
    enabled: false,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: false, resume: false, retry: false },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
    ...overrides,
  };
}

function publicThread(overrides = {}) {
  return {
    id: THREAD_ID,
    title: "Plot the values",
    status: "idle",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastRunId: null,
    authority: {
      kind: "aginti",
      mapped: false,
      runtimeRevision: null,
      contextDigest: null,
      lastCompaction: null,
    },
    replay: { prunedMessageCount: 0, anchorDigest: ZERO_HASH },
    messages: [],
    ...overrides,
  };
}

function publicRun(overrides = {}) {
  return {
    id: RUN_ID,
    threadId: THREAD_ID,
    previousRunId: null,
    status: "starting",
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    output: "",
    error: null,
    authority: { kind: "aginti", snapshotHash: null, runtimeRevision: null, contextDigest: null },
    eventCursor: { firstSeq: 1, lastSeq: 0, lastHash: ZERO_HASH, prunedThroughSeq: 0 },
    ...overrides,
  };
}

function artifact() {
  return {
    id: ARTIFACT_ID,
    title: "Result plot",
    kind: "plot",
    spec: {
      schemaVersion: "1",
      type: "line",
      labels: ["A", "B"],
      series: [{ name: "Value", data: [1, 2] }],
    },
  };
}

function sourceArtifact(overrides = {}) {
  return {
    id: ARTIFACT_ID,
    title: "Grounded sources",
    kind: "sources",
    spec: {
      schemaVersion: "1",
      sources: [{
        index: 1,
        title: "Primary source",
        url: "https://example.test/research",
        snippet: "A bounded evidence summary.",
        providers: ["provider-one"],
        kind: "web",
        publishedDate: "2026-08-20",
        doi: null,
      }],
    },
    ...overrides,
  };
}

function event({ seq, type, payload, previousHash, runId = RUN_ID, threadId = THREAD_ID, extra = {} }) {
  const envelope = {
    schemaVersion: "1",
    id: `${runId}.${seq}`,
    seq,
    type,
    threadId,
    runId,
    createdAt: NOW,
    payload,
    previousHash,
  };
  return { ...envelope, hash: digest(canonicalJson(envelope)), ...extra };
}

function jsonResponse(value, { status = 200, releaseId = RELEASE } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-lazying-agent-release": releaseId,
    },
  });
}

function sseResponse(events) {
  const body = events.map((entry) => `id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("AgInTi protocol keeps every native path exact and rejects browser agent configuration", () => {
  assert.equal(new Set(Object.values(AGINTI_RPC_PATHS)).size, 13);
  for (const path of Object.values(AGINTI_RPC_PATHS)) assert.match(path, /^\/agent\/v1\//u);
  assert.deepEqual(validateAgentRequest(AGINTI_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "Plot this" },
  }), { threadId: THREAD_ID, input: { text: "Plot this" } });
  assert.deepEqual(validateAgentRequest(AGINTI_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "Find evidence", search: { mode: "both", limit: 12 } },
  }), { threadId: THREAD_ID, input: { text: "Find evidence", search: { mode: "both", limit: 12 } } });
  assert.deepEqual(validateAgentSearch({ mode: "papers", limit: 1 }), { mode: "papers", limit: 1 });
  for (const search of [
    { mode: "auto", limit: 5 },
    { mode: "web", limit: 0 },
    { mode: "papers", limit: 21 },
    { mode: "both", limit: 5, query: "browser override" },
  ]) assert.throws(() => validateAgentSearch(search));
  const accessorSearch = {};
  Object.defineProperty(accessorSearch, "mode", { enumerable: true, get() { return "web"; } });
  Object.defineProperty(accessorSearch, "limit", { enumerable: true, value: 5 });
  assert.throws(() => validateAgentSearch(accessorSearch), /data properties/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "x\ud800" },
  }), /malformed Unicode/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "界".repeat(11_000) },
  }), /UTF-8 byte limit/u);
  for (const field of ["model", "provider", "tools", "cwd", "sandboxMode", "runtime", "context", "compaction"]) {
    assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsStart, {
      threadId: THREAD_ID,
      input: { text: "Plot this" },
      [field]: "browser-controlled",
    }), /unsupported field/u);
  }
  assert.deepEqual(validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
    runId: RUN_ID,
    afterSeq: 0,
    afterHash: ZERO_HASH,
  }), { runId: RUN_ID, afterSeq: 0, afterHash: ZERO_HASH });
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
    runId: RUN_ID,
    afterSeq: 0,
  }), /afterHash is required/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
    runId: RUN_ID,
    afterSeq: 0,
    afterHash: "f".repeat(64),
  }), /zero hash/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
    runId: RUN_ID,
    afterSeq: 1,
    afterHash: "F".repeat(64),
  }), /lowercase SHA-256/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
    runId: RUN_ID,
    afterSeq: 1,
    afterHash: ZERO_HASH,
  }), /must not be the zero hash/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
    runId: RUN_ID,
    afterSeq: 0,
    afterHash: ZERO_HASH,
    lastEventHash: ZERO_HASH,
  }), /unsupported field/u);
});

test("capabilities default to Chat and enable Agent only for exact AgInTi + LocalLLM proof", () => {
  assert.equal(selectDefaultMode(undefined), "chat");
  assert.equal(selectDefaultMode(capabilities()), "chat");
  const enabled = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
  });
  assert.equal(validateAgentCapabilities(enabled).enabled, true);
  assert.equal(validateAgentCapabilities(enabled).search, undefined, "legacy capability stays byte-shape compatible");
  assert.deepEqual(validateAgentCapabilities(enabled), enabled);
  assert.equal(canonicalJson(validateAgentCapabilities(enabled)), canonicalJson(enabled));
  assert.equal(digest(canonicalJson(validateAgentCapabilities(enabled))), digest(canonicalJson(enabled)));
  assert.equal(Object.hasOwn(FAIL_CLOSED_AGENT_CAPABILITIES, "search"), false);
  const explicitlyDisabledSearch = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
    search: { enabled: false, modes: [], maximumSources: 0 },
  });
  assert.deepEqual(validateAgentCapabilities(explicitlyDisabledSearch), enabled);
  assert.equal(Object.hasOwn(validateAgentCapabilities(explicitlyDisabledSearch), "search"), false);
  assert.equal(selectDefaultMode(enabled), "agent");
  const searchEnabled = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
    search: { enabled: true, modes: [...AGINTI_SEARCH_MODES], maximumSources: 20 },
    artifacts: { kinds: ["plot", "table", "markdown", "sources"], schemaVersion: "1" },
  });
  assert.deepEqual(validateAgentCapabilities(searchEnabled).search, {
    enabled: true,
    modes: ["web", "papers", "both"],
    maximumSources: 20,
  });
  for (const invalid of [
    { ...searchEnabled, search: { enabled: true, modes: ["web", "both", "papers"], maximumSources: 20 } },
    { ...searchEnabled, search: { enabled: true, modes: [...AGINTI_SEARCH_MODES], maximumSources: 21 } },
    { ...searchEnabled, artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" } },
    { ...capabilities(), search: { enabled: true, modes: [...AGINTI_SEARCH_MODES], maximumSources: 20 }, artifacts: { kinds: ["plot", "table", "markdown", "sources"], schemaVersion: "1" } },
  ]) assert.equal(failClosedCapabilities(invalid), FAIL_CLOSED_AGENT_CAPABILITIES);
  const accessorModes = [];
  Object.defineProperty(accessorModes, "0", { enumerable: true, get() { return "web"; } });
  accessorModes.push("papers", "both");
  assert.equal(failClosedCapabilities({
    ...searchEnabled,
    search: { ...searchEnabled.search, modes: accessorModes },
  }), FAIL_CLOSED_AGENT_CAPABILITIES);
  const sparseModes = new Array(3);
  sparseModes[0] = "web";
  sparseModes[2] = "both";
  assert.equal(failClosedCapabilities({
    ...searchEnabled,
    search: { ...searchEnabled.search, modes: sparseModes },
  }), FAIL_CLOSED_AGENT_CAPABILITIES);
  for (const invalid of [
    { ...enabled, agent: { kind: "adapter", label: "Agent" } },
    { ...enabled, model: { label: "DeepSeek" } },
    { ...enabled, workspace: "/home/private" },
    { ...enabled, attachments: { enabled: true } },
  ]) {
    assert.equal(failClosedCapabilities(invalid), FAIL_CLOSED_AGENT_CAPABILITIES);
    assert.equal(selectDefaultMode(invalid), "chat");
  }
});

test("sources artifacts are exact, bounded, credential-free HTTPS presentation data", () => {
  const normalized = validateArtifact(sourceArtifact());
  assert.equal(normalized.kind, "sources");
  assert.equal(normalized.spec.sources[0].url, "https://example.test/research");
  assert.equal(Object.isFrozen(normalized.spec.sources[0]), true);

  const invalidUrls = [
    "http://example.test/research",
    "https://user:password@example.test/research",
    "https://example.test/research#private",
    "https://example.test/research?access_token=secret",
    "https://example.test/research?X-Amz-Credential=secret&X-Amz-Signature=signed",
    "https://example.test/research?AWSAccessKeyId=secret",
    "https://example.test/research?GoogleAccessId=secret",
    "https://example.test/research?sig=secret",
    "javascript:alert(1)",
  ];
  for (const url of invalidUrls) {
    const candidate = sourceArtifact();
    candidate.spec.sources[0].url = url;
    assert.throws(() => validateArtifact(candidate), /HTTPS|credential|fragment/u);
  }
  for (const mutate of [
    (source) => { source.index = 2; },
    (source) => { source.title = "<img onerror=alert(1)>"; },
    (source) => { source.snippet = "read /home/aginti/private"; },
    (source) => { source.providers = ["same", "same"]; },
    (source) => { source.kind = "file"; },
    (source) => { source.publishedDate = "2025-02-29"; },
    (source) => { source.doi = "not-a-doi"; },
    (source) => { source.extra = "private"; },
  ]) {
    const candidate = sourceArtifact();
    mutate(candidate.spec.sources[0]);
    assert.throws(() => validateArtifact(candidate));
  }
  const sparse = sourceArtifact();
  sparse.spec.sources = new Array(1);
  assert.throws(() => validateArtifact(sparse), /sparse/u);
  const accessor = sourceArtifact();
  const providerItems = [];
  Object.defineProperty(providerItems, "0", { enumerable: true, get() { return "provider-one"; } });
  providerItems.length = 1;
  accessor.spec.sources[0].providers = providerItems;
  assert.throws(() => validateArtifact(accessor), /data entries/u);
  const tooMany = sourceArtifact();
  tooMany.spec.sources = Array.from({ length: 21 }, (unused, index) => ({
    ...sourceArtifact().spec.sources[0],
    index: index + 1,
    url: `https://example.test/research/${index + 1}`,
  }));
  assert.throws(() => validateArtifact(tooMany), /1-20/u);
  const oversized = sourceArtifact();
  oversized.spec.sources = Array.from({ length: 20 }, (unused, index) => ({
    ...sourceArtifact().spec.sources[0],
    index: index + 1,
    url: `https://example.test/research/${index + 1}`,
    snippet: "e".repeat(4_000),
  }));
  assert.throws(() => validateArtifact(oversized), /48 KiB/u);
});

test("public responses and artifacts reject private state, active content, URLs, and oversized data", () => {
  assert.equal(validateAgentResponse(AGINTI_RPC_PATHS.threadsList, {
    schemaVersion: "1",
    threads: [publicThread()],
    nextBefore: null,
  }).threads[0].authority.kind, "aginti");
  assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread(),
    rawSession: { cwd: "/home/private" },
  }), /unsupported field/u);
  assert.equal(validateAgentResponse(AGINTI_RPC_PATHS.runsStatus, {
    schemaVersion: "1",
    run: publicRun(),
  }).run.eventCursor.firstSeq, 1);
  assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.runsStatus, {
    schemaVersion: "1",
    run: publicRun({
      eventCursor: { firstSeq: 2, lastSeq: 2, lastHash: "a".repeat(64), prunedThroughSeq: 1 },
    }),
  }), /does not support pruned ledgers/u);
  assert.equal(validateArtifact(artifact()).kind, "plot");
  assert.equal(validateArtifact({
    ...artifact(),
    spec: {
      schemaVersion: "1",
      type: "line",
      labels: ["minimum", "maximum"],
      series: [{ name: "Safe boundary", data: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] }],
    },
  }).kind, "plot");
  for (const data of [
    [Number.MAX_SAFE_INTEGER + 1],
    [Number.MAX_VALUE],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ]) {
    assert.throws(() => validateArtifact({
      ...artifact(),
      spec: {
        schemaVersion: "1",
        type: "line",
        labels: data.map((unused, index) => String(index)),
        series: [{ name: "Unsafe magnitude", data }],
      },
    }), /plot magnitude/u);
  }
  assert.throws(() => validateArtifact({
    ...artifact(),
    spec: {
      schemaVersion: "1",
      type: "scatter",
      series: [{ name: "Unsafe range", points: [
        { x: -Number.MAX_VALUE, y: 0 },
        { x: Number.MAX_VALUE, y: 1 },
      ] }],
    },
  }), /plot magnitude/u);
  for (const candidate of [
    { id: ARTIFACT_ID, title: "Unsafe", kind: "html", spec: { html: "<script>" } },
    { id: ARTIFACT_ID, title: "Unsafe", kind: "markdown", spec: { schemaVersion: "1", markdown: "[open](https://example.test)" } },
    { id: ARTIFACT_ID, title: "Unsafe", kind: "markdown", spec: { schemaVersion: "1", markdown: "read /home/aginti/private" } },
    { ...artifact(), downloadUrl: "https://example.test/private" },
  ]) assert.throws(() => validateArtifact(candidate));
});

test("event ledger verifies exact hashes, ownership, sequence, and previous hash", async () => {
  const first = event({ seq: 1, type: "output.delta", payload: { text: "Hello" }, previousHash: ZERO_HASH });
  const verified = await verifyAgentEvent(first, {
    expectedRunId: RUN_ID,
    expectedThreadId: THREAD_ID,
    afterSeq: 0,
    previousHash: ZERO_HASH,
    digest: async (value) => digest(value),
  });
  assert.equal(verified.hash, first.hash);
  await assert.rejects(() => verifyAgentEvent({ ...first, hash: "f".repeat(64) }, {
    expectedRunId: RUN_ID,
    afterSeq: 0,
    previousHash: ZERO_HASH,
    digest: async (value) => digest(value),
  }), /hash verification/u);
  await assert.rejects(() => verifyAgentEvent(first, {
    expectedRunId: RUN_ID,
    afterSeq: 1,
    previousHash: first.hash,
    digest: async (value) => digest(value),
  }), /not contiguous/u);
  const malicious = event({
    seq: 1,
    type: "artifact.created",
    payload: { artifact: {
      id: ARTIFACT_ID,
      title: "Unsafe artifact",
      kind: "markdown",
      spec: { schemaVersion: "1", markdown: "<img src=x onerror=alert(1)>" },
    } },
    previousHash: ZERO_HASH,
  });
  await assert.rejects(() => verifyAgentEvent(malicious, {
    expectedRunId: RUN_ID,
    expectedThreadId: THREAD_ID,
    afterSeq: 0,
    previousHash: ZERO_HASH,
    digest: async (value) => digest(value),
  }), /may not contain HTML/u);
  assert.throws(() => validateEventEnvelope({ ...first, stdout: "secret" }), /unsupported field/u);
});

test("browser client injects only same-origin transport, CSRF, and mutation idempotency", async () => {
  const calls = [];
  const client = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/app/",
    csrfToken: "csrf-token-value-long-enough",
    releaseId: RELEASE,
    makeIdempotencyKey: () => "mutation-key-1234567890",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(AGINTI_RPC_PATHS.threadsCreate)) {
        return jsonResponse({ schemaVersion: "1", thread: publicThread() });
      }
      if (url.endsWith(AGINTI_RPC_PATHS.runsStart)) {
        return jsonResponse({ schemaVersion: "1", run: publicRun() });
      }
      if (url.endsWith(AGINTI_RPC_PATHS.runsResume)) {
        return jsonResponse({
          schemaVersion: "1",
          run: publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID }),
        });
      }
      return jsonResponse({ schemaVersion: "1", threads: [], nextBefore: null });
    },
  });
  await client.listThreads();
  await client.createThread({ title: "Plot values" });
  await client.startRun(THREAD_ID, "Find grounded evidence", { search: { mode: "web", limit: 5 } });
  await client.resumeRun(RUN_ID, "Compare with the prior answer", {
    idempotency: "agent_followup_exact_1234567890",
  });
  assert.equal(calls[0].url, `https://llm.lazying.art/api/edge${AGINTI_RPC_PATHS.threadsList}`);
  assert.equal(calls[1].url, `https://llm.lazying.art/api/edge${AGINTI_RPC_PATHS.threadsCreate}`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers.get("idempotency-key"), null);
  assert.equal(calls[1].options.headers.get("idempotency-key"), "mutation-key-1234567890");
  assert.equal(calls[1].options.headers.get("x-csrf-token"), "csrf-token-value-long-enough");
  assert.equal(calls[1].options.headers.get("x-lazying-agent-release"), RELEASE);
  assert.equal(calls[2].url, `https://llm.lazying.art/api/edge${AGINTI_RPC_PATHS.runsStart}`);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    threadId: THREAD_ID,
    input: { text: "Find grounded evidence", search: { mode: "web", limit: 5 } },
  });
  assert.equal(calls[2].options.headers.get("idempotency-key"), "mutation-key-1234567890");
  assert.equal(calls[3].url, `https://llm.lazying.art/api/edge${AGINTI_RPC_PATHS.runsResume}`);
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    runId: RUN_ID,
    input: { text: "Compare with the prior answer" },
  });
  assert.equal(calls[3].options.headers.get("idempotency-key"), "agent_followup_exact_1234567890");
  for (const name of [
    "authorization",
    "x-aginti-principal-id",
    "x-aginti-browser-session-id",
    "x-idempotency-key",
    "x-lazyedge-principal-id",
    "x-lazyedge-browser-session",
    "x-lazyedge-idempotency-key",
  ]) {
    assert.equal(calls[1].options.headers.get(name), null);
  }
  assert.equal(calls[1].options.body.includes("model"), false);
  const crossOrigin = new AgintiBrowserClient({
    transportEndpoint: () => "https://attacker.test/agent/v1/capabilities",
    baseUrl: "https://llm.lazying.art/",
    fetchImpl: async () => { throw new Error("must not dispatch"); },
  });
  await assert.rejects(() => crossOrigin.call(AGINTI_RPC_PATHS.capabilities), /same-origin/u);
  assert.throws(() => new AgintiBrowserClient({
    transportEndpoint: "/api/%2e%2e/private",
    baseUrl: "https://llm.lazying.art/",
  }), /normalized|absolute-path/u);
});

test("pinned Agent transport exposes an exact newer release without retrying", async () => {
  const client = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/",
    csrfToken: "csrf-token-value-long-enough",
    releaseId: RELEASE,
    fetchImpl: async () => jsonResponse(capabilities(), { status: 409, releaseId: NEXT_RELEASE }),
  });
  await assert.rejects(
    () => client.capabilities(),
    (error) => error instanceof AgintiTransportError
      && error.code === "client_release_mismatch"
      && error.serverRelease === NEXT_RELEASE
      && error.retryable === false,
  );
});

test("the default AgInTi fetch keeps the global browser receiver", async () => {
  const receivers = [];
  const originalFetch = globalThis.fetch;
  let clients;
  try {
    globalThis.fetch = function receiverSensitiveFetch() {
      receivers.push(this);
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(capabilities()));
    };
    clients = [
      new AgintiBrowserClient({ transportEndpoint: "/api/edge", baseUrl: "https://llm.lazying.art/" }),
      new AgintiBrowserClient({
        transportEndpoint: "/api/edge", baseUrl: "https://llm.lazying.art/", fetchImpl: globalThis.fetch,
      }),
    ];
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const client of clients) assert.equal((await client.capabilities()).enabled, false);
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("capability probe remains fail-closed on the current WIP or malformed native API", async () => {
  for (const response of [
    capabilities(),
    { schemaVersion: "1", enabled: true, authority: "aginti" },
    { ...capabilities({ enabled: true }), rawRuntime: { docker: true } },
  ]) {
    const client = new AgintiBrowserClient({
      transportEndpoint: "/api/edge",
      baseUrl: "https://llm.lazying.art/",
      fetchImpl: async () => jsonResponse(response),
    });
    const result = await client.capabilities();
    assert.equal(result.enabled, false);
    assert.equal(selectDefaultMode(result), "chat");
  }
});

test("resumable POST SSE reconnects from the verified cursor without restarting a run", async () => {
  const first = event({ seq: 1, type: "output.delta", payload: { text: "Hello" }, previousHash: ZERO_HASH });
  const second = event({ seq: 2, type: "run.completed", payload: {}, previousHash: first.hash });
  const requests = [];
  const cursors = [];
  const client = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/",
    wait: async () => {},
    digest: async (value) => digest(value),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return requests.length === 1 ? sseResponse([first]) : sseResponse([second]);
    },
  });
  const seen = [];
  for await (const item of client.streamRunEvents({
    runId: RUN_ID,
    threadId: THREAD_ID,
    cursor: initialEventCursor(),
    onCursor: async (value) => cursors.push(value),
  })) seen.push(item.event.type);
  assert.deepEqual(seen, ["output.delta", "run.completed"]);
  assert.deepEqual(requests.map((request) => request.body), [
    { runId: RUN_ID, afterSeq: 0, afterHash: ZERO_HASH },
    { runId: RUN_ID, afterSeq: 1, afterHash: first.hash },
  ]);
  assert.equal(requests.some((request) => request.url.endsWith("/runs/start")), false);
  assert.deepEqual(cursors.map((value) => value.seq), [1, 2]);
});

test("ledger corruption fails immediately and is never treated as a reconnectable outage", async () => {
  const bad = event({ seq: 1, type: "output.delta", payload: { text: "Hello" }, previousHash: ZERO_HASH });
  bad.hash = "e".repeat(64);
  let calls = 0;
  const client = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/",
    wait: async () => {},
    digest: async (value) => digest(value),
    fetchImpl: async () => { calls += 1; return sseResponse([bad]); },
  });
  await assert.rejects(async () => {
    for await (const unused of client.streamRunEvents({ runId: RUN_ID })) void unused;
  }, (error) => error instanceof AgintiProtocolError && error.code === "LEDGER_HASH_MISMATCH");
  assert.equal(calls, 1);
});

test("presentation projection accepts only verified events and mirrors output, plans, context, tools, and artifacts", async () => {
  const projection = createRunPresentation({ runId: RUN_ID, threadId: THREAD_ID });
  const raw = event({ seq: 1, type: "output.delta", payload: { text: "Hello" }, previousHash: ZERO_HASH });
  assert.throws(() => projection.apply(raw), /not passed ledger verification/u);
  const events = [];
  let previousHash = ZERO_HASH;
  for (const [type, payload] of [
    ["plan.updated", { steps: [{ id: "one", label: "Compute", status: "in_progress" }] }],
    ["context.compacted", { compactedMessages: 12, tokensBefore: 8_000, tokensAfter: 2_000 }],
    ["tool.completed", { callId: "call-1", publicLabel: "Calculate", publicSummary: "Prepared bounded data", at: NOW }],
    ["output.delta", { text: "Answer" }],
    ["artifact.created", { artifact: artifact() }],
    ["output.completed", {}],
    ["run.completed", {}],
  ]) {
    const next = event({ seq: events.length + 1, type, payload, previousHash });
    const verified = await verifyAgentEvent(next, {
      expectedRunId: RUN_ID,
      expectedThreadId: THREAD_ID,
      afterSeq: events.length,
      previousHash,
      digest: async (value) => digest(value),
    });
    events.push(verified);
    previousHash = verified.hash;
    projection.apply(verified);
  }
  const state = projection.snapshot();
  assert.equal(state.authority, "aginti");
  assert.equal(state.authoritative, false);
  assert.equal(state.output, "Answer");
  assert.equal(state.plan[0].label, "Compute");
  assert.equal(state.compaction.compactedMessages, 12);
  assert.equal(state.tools[0].summary, "Prepared bounded data");
  assert.equal(state.artifacts[0].id, ARTIFACT_ID);
  assert.equal(state.status, "completed");
});
