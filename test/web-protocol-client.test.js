import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT,
  AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT,
  AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES,
  AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
  AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT,
  AGINTI_RPC_PATHS,
  AGINTI_SEARCH_MODES,
  AgintiProtocolError,
  FAIL_CLOSED_AGENT_CAPABILITIES,
  canonicalJson,
  failClosedCapabilities,
  initialEventCursor,
  prepareAgentImageAttachments,
  validateAgentCapabilities,
  validateAgentImageAttachments,
  validateAgentRequest,
  validateAgentSearch,
  validateAgentResponse,
  validateArtifact,
  validateEventEnvelope,
  validateThreadRunAncestry,
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
const THIRD_RUN_ID = "run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

function agentAttachment(overrides = {}) {
  return {
    attachmentId: "image_0000000000000001",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUg==",
    ...overrides,
  };
}

function attachmentCapabilities() {
  return {
    enabled: true,
    transport: "inline-base64",
    acceptedMediaTypes: ["image/png", "image/jpeg"],
    maximumCount: 4,
    maximumBytesEach: 4 * 1024 * 1024,
    maximumBytesTotal: 16 * 1024 * 1024,
    requestTimeoutMs: 515_000,
    model: "localllm-vision",
    persistence: "retained-reference-v1",
  };
}

function roleCapabilities(overrides = {}) {
  const observedAt = "2026-08-31T16:11:38.009Z";
  const ready = (role) => ({
    schemaVersion: "aginti-analysis-role-state-v1",
    role,
    configured: true,
    status: "ready",
    ready: true,
    observedAt,
    reason: null,
    actionable: null,
  });
  return {
    executionWorker: ready("executionWorker"),
    documentWorker: {
      schemaVersion: "aginti-analysis-role-state-v1",
      role: "documentWorker",
      configured: true,
      status: "degraded",
      ready: false,
      observedAt,
      reason: "credential_unavailable",
      actionable: "repair the private route or credential, then reactivate",
    },
    groundedSearch: ready("groundedSearch"),
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

function fileArtifact() {
  return {
    id: ARTIFACT_ID,
    title: "Compiled paper",
    kind: "file",
    spec: {
      schemaVersion: "1",
      filename: "paper.pdf",
      mime: "application/pdf",
      bytes: 32_768,
      sha256: "c".repeat(64),
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

function jsonResponse(value, { status = 200, releaseId = RELEASE, retryAfter } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-lazying-agent-release": releaseId,
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
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
  const orderedAttachments = [
    agentAttachment(),
    agentAttachment({ attachmentId: "image_0000000000000002", data: "AQIDBAUGBwgJCgsMDQ4PEA==" }),
  ];
  assert.deepEqual(validateAgentRequest(AGINTI_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "Compare the images", attachments: orderedAttachments },
  }), {
    threadId: THREAD_ID,
    input: { text: "Compare the images", attachments: orderedAttachments },
  });
  assert.deepEqual(validateAgentImageAttachments(orderedAttachments), orderedAttachments);
  for (const attachments of [
    [],
    Array.from({ length: 5 }, (_, index) => agentAttachment({ attachmentId: `image_000000000000000${index}` })),
    [agentAttachment(), agentAttachment()],
    [agentAttachment({ mediaType: "image/gif" })],
    [agentAttachment({ data: "aGVsbG8*" })],
    [agentAttachment({ data: "AB==" })],
    [agentAttachment({ data: "AAB=" })],
    [agentAttachment({ attachmentId: "short" })],
  ]) {
    assert.throws(() => validateAgentImageAttachments(attachments));
  }
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
  assert.deepEqual(validateAgentRequest(AGINTI_RPC_PATHS.runsResume, {
    runId: RUN_ID,
    reuseAttachments: true,
  }), { runId: RUN_ID, reuseAttachments: true });
  for (const invalidResume of [
    { runId: RUN_ID, reuseAttachments: false },
    { runId: RUN_ID, reuseAttachments: "true" },
    { runId: RUN_ID, reuseAttachments: true, input: { text: "Corrected prompt" } },
  ]) {
    assert.throws(
      () => validateAgentRequest(AGINTI_RPC_PATHS.runsResume, invalidResume),
      /reuseAttachments/u,
    );
  }
  for (const request of [{ runId: RUN_ID }, { threadId: THREAD_ID }]) {
    const normalized = validateAgentRequest(AGINTI_RPC_PATHS.artifactsList, request);
    assert.deepEqual(normalized, request);
    assert.deepEqual(
      validateAgentRequest(AGINTI_RPC_PATHS.artifactsList, normalized),
      request,
      "artifact-list normalization must remain valid across the browser and BFF trust boundaries",
    );
  }
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.artifactsList, {}), /exactly one/u);
  assert.throws(() => validateAgentRequest(AGINTI_RPC_PATHS.artifactsList, {
    runId: RUN_ID,
    threadId: THREAD_ID,
  }), /exactly one/u);
});

test("maximum-size Agent PNG preparation keeps mobile intermediates bounded and skips trusted retry rescans", () => {
  const bytes = new Uint8Array(4 * 1024 * 1024);
  Object.defineProperty(bytes, "toBase64", { value: undefined });
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index & 0xff;
  const originalBtoa = globalThis.btoa;
  let maximumInput = 0;
  try {
    globalThis.btoa = (value) => {
      maximumInput = Math.max(maximumInput, value.length);
      return originalBtoa(value);
    };
    const prepared = prepareAgentImageAttachments([{
      attachmentId: "image_0000000000000001",
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      width: 4_096,
      height: 4_096,
      bytes,
    }]);
    assert.ok(maximumInput <= 12 * 1024, `largest btoa input was ${maximumInput} bytes`);
    assert.equal(prepared[0].data.length, Math.ceil(bytes.byteLength / 3) * 4);
    assert.deepEqual(Buffer.from(prepared[0].data, "base64"), Buffer.from(bytes));

    const originalCharCodeAt = String.prototype.charCodeAt;
    let largeBase64Rescans = 0;
    try {
      String.prototype.charCodeAt = function observedCharCodeAt(index) {
        if (this.length > 1024 * 1024) largeBase64Rescans += 1;
        return originalCharCodeAt.call(this, index);
      };
      assert.deepEqual(validateAgentImageAttachments(prepared), prepared);
      assert.deepEqual(validateAgentImageAttachments(prepared), prepared,
        "an exact retry reuses the same immutable prepared attachments");
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
    }
    assert.equal(largeBase64Rescans, 0);
    assert.throws(() => validateAgentImageAttachments([{
      ...prepared[0],
      data: `${prepared[0].data.slice(0, -1)}*`,
    }]), /base64/u, "a clone still takes the full fail-closed validation path");
  } finally {
    globalThis.btoa = originalBtoa;
  }
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
  const fileEnabled = {
    ...enabled,
    artifacts: { kinds: ["plot", "table", "markdown", "file"], schemaVersion: "1" },
  };
  assert.deepEqual(validateAgentCapabilities(fileEnabled).artifacts.kinds, ["plot", "table", "markdown", "file"]);
  const attachmentEnabled = {
    ...enabled,
    attachments: attachmentCapabilities(),
  };
  assert.deepEqual(validateAgentCapabilities(attachmentEnabled).attachments, attachmentCapabilities());
  assert.equal(validateAgentCapabilities(attachmentEnabled).attachments.acceptedMediaTypes,
    AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES);
  assert.deepEqual(AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES, ["image/png", "image/jpeg"]);
  assert.equal(AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT, 4);
  assert.equal(AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT, 4 * 1024 * 1024);
  assert.equal(AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT, 16 * 1024 * 1024);
  assert.equal(AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS, 515_000);
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
  const searchAndFiles = {
    ...searchEnabled,
    artifacts: { kinds: ["plot", "table", "markdown", "sources", "file"], schemaVersion: "1" },
  };
  assert.deepEqual(validateAgentCapabilities(searchAndFiles).artifacts.kinds, [
    "plot", "table", "markdown", "sources", "file",
  ]);
  const roleAware = { ...searchEnabled, roles: roleCapabilities() };
  assert.deepEqual(validateAgentCapabilities(roleAware), roleAware,
    "strict role health is retained without disabling an otherwise ready Agent");
  assert.equal(validateAgentCapabilities(roleAware).roles.executionWorker.ready, true);
  assert.equal(validateAgentCapabilities(roleAware).roles.documentWorker.status, "degraded");
  for (const roles of [
    { ...roleCapabilities(), executionWorker: { ...roleCapabilities().executionWorker, role: "documentWorker" } },
    { ...roleCapabilities(), groundedSearch: { ...roleCapabilities().groundedSearch, status: "degraded", ready: true } },
    { ...roleCapabilities(), documentWorker: { ...roleCapabilities().documentWorker, actionable: "/home/private" } },
    { ...roleCapabilities(), unknownWorker: roleCapabilities().executionWorker },
  ]) {
    assert.equal(failClosedCapabilities({ ...searchEnabled, roles }), FAIL_CLOSED_AGENT_CAPABILITIES);
  }
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
    { ...attachmentEnabled, attachments: { ...attachmentCapabilities(), acceptedMediaTypes: ["image/jpeg", "image/png"] } },
    { ...attachmentEnabled, attachments: { ...attachmentCapabilities(), maximumCount: 5 } },
    { ...attachmentEnabled, attachments: { ...attachmentCapabilities(), requestTimeoutMs: 270_000 } },
    { ...attachmentEnabled, attachments: { ...attachmentCapabilities(), persistence: "browser-cache" } },
    { ...capabilities(), attachments: attachmentCapabilities() },
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

test("file artifacts expose only bounded PDF or TeX metadata and never local bytes or paths", () => {
  const file = {
    id: ARTIFACT_ID,
    title: "Compiled paper",
    kind: "file",
    spec: {
      schemaVersion: "1",
      filename: "paper.pdf",
      mime: "application/pdf",
      bytes: 32_768,
      sha256: "c".repeat(64),
    },
  };
  const normalized = validateArtifact(file);
  assert.equal(normalized.kind, "file");
  assert.deepEqual(normalized.spec, file.spec);
  assert.equal(Object.isFrozen(normalized.spec), true);
  assert.equal(JSON.stringify(normalized).includes("/home/"), false);
  for (const candidate of [
    { ...file, spec: { ...file.spec, filename: "../paper.pdf" } },
    { ...file, spec: { ...file.spec, filename: "/home/private/paper.pdf" } },
    { ...file, spec: { ...file.spec, filename: "paper.html" } },
    { ...file, spec: { ...file.spec, filename: "paper.tex" } },
    { ...file, spec: { ...file.spec, mime: "text/html" } },
    { ...file, spec: { ...file.spec, bytes: 0 } },
    { ...file, spec: { ...file.spec, bytes: 16 * 1024 * 1024 + 1 } },
    { ...file, spec: { ...file.spec, sha256: "C".repeat(64) } },
    { ...file, spec: { ...file.spec, localPath: "/tmp/paper.pdf" } },
    { ...file, content: "%PDF-1.7" },
  ]) assert.throws(() => validateArtifact(candidate));
  assert.equal(validateArtifact({
    ...file,
    spec: { ...file.spec, filename: "source.tex", mime: "application/x-tex" },
  }).spec.mime, "application/x-tex");
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

test("persisted Agent messages cannot make a pristine thread replay or restart", () => {
  const message = (role) => ({
    id: `msg_${role}_1234567890abcdef`,
    role,
    content: role === "user" ? "Run the calculation" : "Stored result",
    runId: RUN_ID,
    createdAt: NOW,
    digest: role === "user" ? "a".repeat(64) : "b".repeat(64),
  });
  for (const role of ["user", "assistant"]) {
    assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
      schemaVersion: "1",
      thread: publicThread({ messages: [message(role)] }),
    }), /replay messages require a lastRunId/u);
  }
  assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({ status: "running" }),
  }), /running thread requires a lastRunId/u);
  for (const replay of [
    { prunedMessageCount: 0, anchorDigest: "c".repeat(64) },
    { prunedMessageCount: 1, anchorDigest: ZERO_HASH },
  ]) {
    assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
      schemaVersion: "1",
      thread: publicThread({ replay }),
    }), /replay anchor is inconsistent/u);
  }
  const replayable = validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({
      lastRunId: RUN_ID,
      messages: [message("user"), message("assistant")],
    }),
  }).thread;
  assert.equal(replayable.lastRunId, RUN_ID);
  assert.deepEqual(replayable.messages.map(({ role, runId }) => ({ role, runId })), [
    { role: "user", runId: RUN_ID },
    { role: "assistant", runId: RUN_ID },
  ]);

  const descriptor = {
    attachmentId: "image_0000000000000001",
    mediaType: "image/jpeg",
    byteLength: 4_096,
    width: 4_032,
    height: 3_024,
    sha256: "c".repeat(64),
  };
  const withImages = validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({
      lastRunId: RUN_ID,
      messages: [{ ...message("user"), attachments: [descriptor] }, message("assistant")],
    }),
  }).thread;
  assert.deepEqual(withImages.messages[0].attachments, [descriptor]);
  assert.equal(Object.isFrozen(withImages.messages[0].attachments), true);
  for (const invalidAttachments of [
    [],
    [{ ...descriptor, mediaType: "image/heic" }],
    [{ ...descriptor, data: "private-bytes" }],
    [{ ...descriptor, width: 8_192, height: 8_192 }],
    [descriptor, descriptor],
  ]) {
    assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
      schemaVersion: "1",
      thread: publicThread({
        lastRunId: RUN_ID,
        messages: [{ ...message("user"), attachments: invalidAttachments }],
      }),
    }));
  }
  assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({
      lastRunId: RUN_ID,
      messages: [{ ...message("assistant"), attachments: [descriptor] }],
    }),
  }), /only Agent user messages/u);
});

test("Agent thread image-context proof is optional, boolean, and requires an exact head run", () => {
  const absent = validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({ lastRunId: RUN_ID }),
  }).thread;
  const inactive = validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({ lastRunId: RUN_ID, activeImageContext: false }),
  }).thread;
  const active = validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
    schemaVersion: "1",
    thread: publicThread({ lastRunId: RUN_ID, activeImageContext: true }),
  }).thread;

  assert.equal(absent.activeImageContext, false, "an older backend response normalizes fail closed");
  assert.equal(inactive.activeImageContext, false);
  assert.equal(active.activeImageContext, true);
  for (const thread of [
    publicThread({ activeImageContext: true }),
    publicThread({ lastRunId: RUN_ID, activeImageContext: "true" }),
    publicThread({ lastRunId: RUN_ID, activeImageContext: 1 }),
    publicThread({ lastRunId: RUN_ID, activeImageContext: null }),
  ]) {
    assert.throws(() => validateAgentResponse(AGINTI_RPC_PATHS.threadsGet, {
      schemaVersion: "1",
      thread,
    }), /active image context/u);
  }
});

test("thread replay ancestry accepts one exact chain and one proven omitted prefix", () => {
  const message = (runId, index) => ({
    id: `msg_lineage_${String(index).padStart(16, "0")}`,
    role: "user",
    content: `Accepted turn ${index}`,
    runId,
    createdAt: NOW,
    digest: String(index).repeat(64),
  });
  const first = publicRun({ id: RUN_ID, previousRunId: null, status: "completed" });
  const second = publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID, status: "completed" });
  const third = publicRun({ id: THIRD_RUN_ID, previousRunId: SECOND_RUN_ID, status: "completed" });
  const ancestry = validateThreadRunAncestry(publicThread({
    lastRunId: THIRD_RUN_ID,
    messages: [message(SECOND_RUN_ID, 2), message(THIRD_RUN_ID, 3), message(RUN_ID, 1)],
  }), [third, first, second]);
  assert.deepEqual(ancestry.runs.map((run) => run.id), [RUN_ID, SECOND_RUN_ID, THIRD_RUN_ID]);
  assert.equal(ancestry.headRun.id, THIRD_RUN_ID);
  assert.equal(ancestry.omittedPrefix, false);
  assert.equal(ancestry.requiresThreadRefresh, false);
  assert.equal(Object.isFrozen(ancestry.runs), true);

  const suffix = validateThreadRunAncestry(publicThread({
    lastRunId: THIRD_RUN_ID,
    replay: { prunedMessageCount: 2, anchorDigest: "c".repeat(64) },
    messages: [message(THIRD_RUN_ID, 3)],
  }), [third]);
  assert.deepEqual(suffix.runs.map((run) => run.id), [THIRD_RUN_ID]);
  assert.equal(suffix.headRun.id, THIRD_RUN_ID);
  assert.equal(suffix.omittedPrefix, true);
  assert.equal(suffix.requiresThreadRefresh, false);

  const completedDuringRead = validateThreadRunAncestry(publicThread({
    status: "running",
    lastRunId: THIRD_RUN_ID,
    messages: [message(THIRD_RUN_ID, 3)],
  }), [publicRun({ id: THIRD_RUN_ID, previousRunId: null, status: "completed" })]);
  assert.equal(completedDuringRead.headRun.status, "completed");
  assert.equal(completedDuringRead.requiresThreadRefresh, true,
    "a terminal run read after a running thread snapshot requests a fresh thread before follow-up");
});

test("thread replay ancestry rejects branches, cycles, and an unproved missing predecessor", () => {
  const message = (runId, index) => ({
    id: `msg_ancestry_${String(index).padStart(16, "0")}`,
    role: "user",
    content: `Accepted turn ${index}`,
    runId,
    createdAt: NOW,
    digest: String(index).repeat(64),
  });
  const threeRunThread = publicThread({
    lastRunId: THIRD_RUN_ID,
    messages: [message(RUN_ID, 1), message(SECOND_RUN_ID, 2), message(THIRD_RUN_ID, 3)],
  });
  assert.throws(() => validateThreadRunAncestry(threeRunThread, [
    publicRun({ id: RUN_ID, previousRunId: null, status: "completed" }),
    publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID, status: "completed" }),
    publicRun({ id: THIRD_RUN_ID, previousRunId: RUN_ID, status: "completed" }),
  ]), /ancestry branches/u);

  assert.throws(() => validateThreadRunAncestry(threeRunThread, [
    publicRun({ id: RUN_ID, previousRunId: SECOND_RUN_ID, status: "completed" }),
    publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID, status: "completed" }),
    publicRun({ id: THIRD_RUN_ID, previousRunId: null, status: "completed" }),
  ]), /ancestry contains a cycle/u);

  assert.throws(() => validateThreadRunAncestry(publicThread({
    lastRunId: SECOND_RUN_ID,
    messages: [message(SECOND_RUN_ID, 2)],
  }), [publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID, status: "completed" })]), /missing without a pruned-prefix proof/u);

  const opaqueNativePrefix = validateThreadRunAncestry(publicThread({
    lastRunId: SECOND_RUN_ID,
    messages: [],
  }), [publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID, status: "completed" })]);
  assert.deepEqual(opaqueNativePrefix.runs.map((run) => run.id), [SECOND_RUN_ID]);
  assert.equal(opaqueNativePrefix.omittedPrefix, true,
    "a full retained-native get projection may keep its durable predecessor opaque");

  assert.throws(() => validateThreadRunAncestry(publicThread({
    lastRunId: RUN_ID,
    messages: [message(RUN_ID, 1)],
  }), [publicRun({ id: RUN_ID, previousRunId: null, status: "running" })]), /thread status does not match/u,
  "an idle replay cannot unlock a nonterminal head");

  assert.throws(() => validateThreadRunAncestry(publicThread({
    status: "deleting",
    lastRunId: RUN_ID,
    messages: [message(RUN_ID, 1)],
  }), [publicRun({ id: RUN_ID, previousRunId: null, status: "completed" })]), /deleting thread cannot unlock/u);
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
  const receiptDigest = "d".repeat(64);
  const fileCreated = event({
    seq: 1,
    type: "artifact.created",
    payload: { artifact: fileArtifact(), receiptDigest },
    previousHash: ZERO_HASH,
  });
  assert.equal(validateEventEnvelope(fileCreated).payload.receiptDigest, receiptDigest);
  assert.throws(() => validateEventEnvelope(event({
    seq: 1,
    type: "artifact.created",
    payload: { artifact: fileArtifact() },
    previousHash: ZERO_HASH,
  })), /receiptDigest/u);
  assert.throws(() => validateEventEnvelope(event({
    seq: 1,
    type: "artifact.updated",
    payload: { artifact: fileArtifact(), receiptDigest: receiptDigest.toUpperCase() },
    previousHash: ZERO_HASH,
  })), /receiptDigest/u);
  assert.throws(() => validateEventEnvelope(event({
    seq: 1,
    type: "artifact.created",
    payload: { artifact: artifact(), receiptDigest },
    previousHash: ZERO_HASH,
  })), /unsupported field/u);
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
    attachments: [agentAttachment()],
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
    input: { text: "Compare with the prior answer", attachments: [agentAttachment()] },
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

test("Agent image mutations outlive the ordinary deadline while preserving abort and idempotency", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let responseDelayMs = 20_000;
  const client = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/",
    csrfToken: "csrf-token-value-long-enough",
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      calls.push({ url, options });
      const timer = setTimeout(() => resolve(jsonResponse({
        schemaVersion: "1",
        run: url.endsWith(AGINTI_RPC_PATHS.runsResume)
          ? publicRun({ id: SECOND_RUN_ID, previousRunId: RUN_ID })
          : publicRun(),
      })), responseDelayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(options.signal.reason ?? new DOMException("request aborted", "AbortError"));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }),
  });

  const ordinary = client.startRun(THREAD_ID, "Text-only slow request", {
    idempotency: "ordinary_agent_timeout_0001",
  });
  const ordinaryRejected = assert.rejects(ordinary, (error) => error instanceof AgintiTransportError
    && error.code === "AGINTI_TIMEOUT" && error.retryable === true);
  t.mock.timers.tick(15_000);
  await ordinaryRejected;

  const image = client.startRun(THREAD_ID, "Slow image upload", {
    idempotency: "image_agent_slow_upload_001",
    attachments: [agentAttachment()],
  });
  let imageSettled = false;
  image.then(() => { imageSettled = true; }, () => { imageSettled = true; });
  t.mock.timers.tick(15_000);
  await Promise.resolve();
  assert.equal(imageSettled, false, "the ordinary 15-second deadline does not abort an image mutation");
  t.mock.timers.tick(5_000);
  assert.equal((await image).run.id, RUN_ID, "a slow acknowledged image mutation completes once");
  assert.equal(calls[1].options.headers.get("idempotency-key"), "image_agent_slow_upload_001");

  const retainedImageRetry = client.resumeRun(RUN_ID, undefined, {
    idempotency: "image_agent_retained_retry_01",
    reuseAttachments: true,
  });
  let retainedRetrySettled = false;
  retainedImageRetry.then(() => { retainedRetrySettled = true; }, () => { retainedRetrySettled = true; });
  t.mock.timers.tick(15_000);
  await Promise.resolve();
  assert.equal(retainedRetrySettled, false, "a retained-image retry does not use the ordinary deadline");
  t.mock.timers.tick(5_000);
  assert.equal((await retainedImageRetry).run.id, SECOND_RUN_ID);
  assert.deepEqual(JSON.parse(calls[2].options.body), { runId: RUN_ID, reuseAttachments: true });
  assert.equal(calls[2].options.headers.get("idempotency-key"), "image_agent_retained_retry_01");
  assert.throws(
    () => client.resumeRun(RUN_ID, "Corrected prompt", { reuseAttachments: true }),
    /reuseAttachments/u,
  );

  responseDelayMs = 600_000;
  const caller = new AbortController();
  const aborted = client.resumeRun(RUN_ID, "Abort this image follow-up", {
    idempotency: "image_agent_caller_abort_01",
    attachments: [agentAttachment()],
    signal: caller.signal,
  });
  caller.abort(new DOMException("cancelled by caller", "AbortError"));
  await assert.rejects(aborted, (error) => error instanceof AgintiTransportError
    && error.code === "AGINTI_ABORTED" && error.retryable === false);
  assert.equal(calls[3].options.headers.get("idempotency-key"), "image_agent_caller_abort_01");

  const timedOut = client.resumeRun(RUN_ID, "Bound the image follow-up", {
    idempotency: "image_agent_exact_timeout_1",
    attachments: [agentAttachment()],
  });
  let timedOutSettled = false;
  timedOut.then(() => { timedOutSettled = true; }, () => { timedOutSettled = true; });
  t.mock.timers.tick(AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(timedOutSettled, false);
  const timeoutRejected = assert.rejects(timedOut, (error) => error instanceof AgintiTransportError
    && error.code === "AGINTI_TIMEOUT" && error.retryable === true);
  t.mock.timers.tick(1);
  await timeoutRejected;
  assert.equal(calls[4].options.headers.get("idempotency-key"), "image_agent_exact_timeout_1");
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

test("Agent transport preserves only the exact rollout code and a bounded delta-seconds retry", async (t) => {
  for (const candidate of [
    { name: "missing", value: undefined, expected: 1_000 },
    { name: "zero", value: "0", expected: 1_000 },
    { name: "exact", value: "4", expected: 4_000 },
    { name: "clamped", value: "12", expected: 5_000 },
    { name: "non-delta", value: "tomorrow", expected: 1_000 },
  ]) {
    await t.test(candidate.name, async () => {
      const client = new AgintiBrowserClient({
        transportEndpoint: "/api/edge",
        baseUrl: "https://llm.lazying.art/",
        csrfToken: "csrf-token-value-long-enough",
        fetchImpl: async () => jsonResponse({ error: { code: "rollout_in_progress" } }, {
          status: 503,
          retryAfter: candidate.value,
        }),
      });
      await assert.rejects(
        () => client.startRun(THREAD_ID, "Wait for the rollout", {
          idempotency: "rollout_agent_mutation_0001",
        }),
        (error) => error instanceof AgintiTransportError
          && error.code === "rollout_in_progress"
          && error.status === 503
          && error.retryable === true
          && error.retryAfterMs === candidate.expected,
      );
    });
  }

  const nearMiss = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/",
    fetchImpl: async () => jsonResponse({ error: { code: "rollout_in_progress_extra" } }, {
      status: 503,
      retryAfter: "5",
    }),
  });
  await assert.rejects(
    () => nearMiss.listThreads(),
    (error) => error instanceof AgintiTransportError
      && error.code === "AGINTI_REQUEST_FAILED"
      && !Object.hasOwn(error, "retryAfterMs"),
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

test("terminal Agent delivery never waits for an unsettled browser body cancellation", async () => {
  const completed = event({ seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH });
  const bytes = new TextEncoder().encode(
    `id: ${completed.id}\nevent: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`,
  );
  let cancelCalled = false;
  const client = new AgintiBrowserClient({
    transportEndpoint: "/api/edge",
    baseUrl: "https://llm.lazying.art/",
    digest: async (value) => digest(value),
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); },
      cancel() {
        cancelCalled = true;
        return new Promise(() => {});
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const iterator = client.streamRunEvents({ runId: RUN_ID, threadId: THREAD_ID });
  assert.equal((await iterator.next()).value.event.type, "run.completed");
  const detached = await Promise.race([
    iterator.return().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(detached, true);
  assert.equal(cancelCalled, true);
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
