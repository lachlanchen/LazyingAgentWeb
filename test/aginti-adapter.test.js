import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGINTI_INTERNAL_HEADERS,
  AgintiAdapterError,
  createAgintiAgentAdapter,
} from "../src/aginti-adapter.js";
import { AGINTI_RPC_PATHS, canonicalJson } from "../src/web/aginti-protocol.js";

const TOKEN = "aginti-adapter-test-token-00000000000001";
const ZERO_HASH = "0".repeat(64);
const CONTEXT = Object.freeze({
  principalId: "principal_account_one",
  browserSession: "a".repeat(64),
});
const CAPABILITIES = Object.freeze({
  schemaVersion: "1",
  enabled: false,
  agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
  model: Object.freeze({ label: "LocalLLM" }),
  actions: Object.freeze({ cancel: false, resume: false, retry: false }),
  attachments: Object.freeze({ enabled: false }),
  artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
});

function event({ seq, previousHash, type = "run.status", payload = { status: "running" } }) {
  const runId = "run_abcdefab-cdef-4abc-8def-abcdefabcdef";
  const envelope = {
    schemaVersion: "1",
    id: `${runId}.${seq}`,
    seq,
    type,
    threadId: "thr_12345678-1234-4123-8123-123456789abc",
    runId,
    createdAt: `2026-08-20T08:00:0${seq}.000Z`,
    payload,
    previousHash,
  };
  return Object.freeze({
    ...envelope,
    hash: createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex"),
  });
}

test("uses only AgInTi-owned identity headers and standard mutation idempotency", async () => {
  const calls = [];
  const adapter = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, headers: new Headers(init.headers) });
      if (url.endsWith(AGINTI_RPC_PATHS.threadsCreate) || url.endsWith(AGINTI_RPC_PATHS.runsStart)) {
        return new Response("", { status: 503 });
      }
      return new Response(JSON.stringify(CAPABILITIES), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal((await adapter.capabilities(CONTEXT)).enabled, false);
  assert.equal(calls[0].url, `http://127.0.0.1:18009${AGINTI_RPC_PATHS.capabilities}`);
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers.get(AGINTI_INTERNAL_HEADERS.principal), CONTEXT.principalId);
  assert.equal(calls[0].headers.get(AGINTI_INTERNAL_HEADERS.browserSession), CONTEXT.browserSession);
  assert.equal(calls[0].headers.get(AGINTI_INTERNAL_HEADERS.idempotency), null);
  for (const legacy of ["x-lazyedge-principal-id", "x-lazyedge-browser-session-id", "x-lazyedge-idempotency-key"]) {
    assert.equal(calls[0].headers.get(legacy), null);
  }

  const idempotencyKey = "agent-mutation-00000001";
  await assert.rejects(
    adapter.rpc(AGINTI_RPC_PATHS.threadsCreate, { title: "A thread" }, { ...CONTEXT, idempotencyKey }),
    (error) => error instanceof AgintiAdapterError && error.statusCode === 503,
  );
  assert.equal(calls[1].headers.get(AGINTI_INTERNAL_HEADERS.idempotency), idempotencyKey);
  await assert.rejects(
    adapter.rpc(AGINTI_RPC_PATHS.runsStart, {
      threadId: "thr_12345678-1234-4123-8123-123456789abc",
      input: { text: "Find evidence", search: { mode: "papers", limit: 6 } },
    }, { ...CONTEXT, idempotencyKey: "agent-search-00000001" }),
    (error) => error instanceof AgintiAdapterError && error.statusCode === 503,
  );
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    threadId: "thr_12345678-1234-4123-8123-123456789abc",
    input: { text: "Find evidence", search: { mode: "papers", limit: 6 } },
  });
  assert.equal(calls[2].headers.get(AGINTI_INTERNAL_HEADERS.idempotency), "agent-search-00000001");
});

test("rejects ambient, remote, malformed, accessor, and confused request authority before fetch", async () => {
  let fetchCalls = 0;
  const options = {
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => { fetchCalls += 1; return new Response(); },
  };
  for (const upstream of ["https://127.0.0.1:18009", "http://0.0.0.0:18009", "http://127.0.0.1:80", "http://127.0.0.1:18009/prefix", "http://user@127.0.0.1:18009"]) {
    assert.throws(() => createAgintiAgentAdapter({ ...options, upstream }), TypeError);
  }
  assert.throws(() => createAgintiAgentAdapter({ upstream: options.upstream }), TypeError);
  const adapter = createAgintiAgentAdapter(options);
  await assert.rejects(adapter.rpc(AGINTI_RPC_PATHS.capabilities, {}, { ...CONTEXT, extra: true }), TypeError);
  await assert.rejects(adapter.rpc(AGINTI_RPC_PATHS.capabilities, {}, { ...CONTEXT, idempotencyKey: "read-key-00000001" }), TypeError);
  await assert.rejects(adapter.rpc(AGINTI_RPC_PATHS.threadsCreate, { title: "A" }, CONTEXT), TypeError);
  await assert.rejects(adapter.rpc(AGINTI_RPC_PATHS.runsStart, {
    threadId: "thr_12345678-1234-4123-8123-123456789abc",
    input: { text: "Find evidence", search: { mode: "web", limit: 5, endpoint: "http://127.0.0.1:8000" } },
  }, { ...CONTEXT, idempotencyKey: "agent-search-00000001" }));
  const accessor = {};
  Object.defineProperty(accessor, "principalId", { enumerable: true, get() { return CONTEXT.principalId; } });
  Object.defineProperty(accessor, "browserSession", { enumerable: true, value: CONTEXT.browserSession });
  await assert.rejects(adapter.rpc(AGINTI_RPC_PATHS.capabilities, {}, accessor), TypeError);
  assert.equal(fetchCalls, 0);
});

test("validates a split-CRLF event stream and its contiguous hash chain", async () => {
  const first = event({ seq: 1, previousHash: ZERO_HASH });
  const second = event({ seq: 2, previousHash: first.hash, type: "output.delta", payload: { text: "hello" } });
  const source = [first, second]
    .map((item) => `id: ${item.id}\r\nevent: ${item.type}\r\ndata: ${JSON.stringify(item)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(source);
  const split = source.indexOf("\r\n") + 1;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
  let requestBody;
  const adapter = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async (url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
  const events = await adapter.rpc(AGINTI_RPC_PATHS.runsEvents, {
    runId: first.runId,
    afterSeq: 0,
    afterHash: ZERO_HASH,
  }, CONTEXT);
  const received = [];
  for await (const item of events) received.push(item);
  assert.deepEqual(received, [first, second]);
  assert.deepEqual(requestBody, { runId: first.runId, afterSeq: 0, afterHash: ZERO_HASH });
  assert.equal(received.every(Object.isFrozen), true);
});

test("fails closed on a corrupt ledger, an oversized JSON response, and credential failure", async () => {
  const valid = event({ seq: 1, previousHash: ZERO_HASH });
  const corrupt = { ...valid, hash: "f".repeat(64) };
  const adapter = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => new Response(
      `id: ${corrupt.id}\nevent: ${corrupt.type}\ndata: ${JSON.stringify(corrupt)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });
  const iterable = await adapter.rpc(AGINTI_RPC_PATHS.runsEvents, {
    runId: valid.runId,
    afterSeq: 0,
    afterHash: ZERO_HASH,
  }, CONTEXT);
  await assert.rejects(async () => { for await (const unused of iterable) void unused; }, /ledger verification/u);

  const wrongPrevious = event({ seq: 2, previousHash: ZERO_HASH });
  const resumed = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => new Response(
      `id: ${wrongPrevious.id}\nevent: ${wrongPrevious.type}\ndata: ${JSON.stringify(wrongPrevious)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });
  const resumedIterable = await resumed.rpc(AGINTI_RPC_PATHS.runsEvents, {
    runId: valid.runId,
    afterSeq: 1,
    afterHash: valid.hash,
  }, CONTEXT);
  await assert.rejects(
    async () => { for await (const unused of resumedIterable) void unused; },
    /ledger verification/u,
  );

  let eagerCalls = 0;
  const rejectedCursor = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => { eagerCalls += 1; return new Response("", { status: 400 }); },
  });
  await assert.rejects(
    rejectedCursor.rpc(AGINTI_RPC_PATHS.runsEvents, {
      runId: valid.runId,
      afterSeq: 1,
      afterHash: valid.hash,
    }, CONTEXT),
    (error) => error instanceof AgintiAdapterError && error.statusCode === 400,
  );
  assert.equal(eagerCalls, 1);

  let pulls = 0;
  let cancelled = false;
  const oversized = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await oversized.capabilities(CONTEXT);
  assert.equal(result.enabled, false);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 34, `expected bounded pulls, received ${pulls}`);

  let exactPulls = 0;
  let exactCancelled = false;
  const exactLimit = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { exactPulls += 1; controller.enqueue(new Uint8Array([0x7b])); },
      cancel() { exactCancelled = true; },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
    }),
  });
  assert.equal((await exactLimit.capabilities(CONTEXT)).enabled, false);
  assert.equal(exactCancelled, true);
  assert.ok(exactPulls <= 1, `expected only the stream's construction prefetch, received ${exactPulls}`);

  const unavailable = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => "invalid token with spaces",
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal((await unavailable.capabilities(CONTEXT)).enabled, false);
});

test("streams exact bounded PDF and TeX artifact responses without forwarding a browser Range header", async () => {
  const artifactId = `art_${"a".repeat(64)}`;
  const pdf = new TextEncoder().encode("%PDF-1.7\nprivate local file\n");
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const calls = [];
  const adapter = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async (url, init) => {
      const input = JSON.parse(init.body);
      const headers = new Headers(init.headers);
      calls.push({ url, input, headers, init });
      const start = input.range?.start ?? 0;
      const end = input.range?.end === undefined ? pdf.byteLength - 1 : Math.min(input.range.end, pdf.byteLength - 1);
      const selected = pdf.slice(start, end + 1);
      const metadataOnly = input.metadataOnly === true;
      return new Response(metadataOnly ? null : selected, {
        status: input.range === undefined ? 200 : 206,
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "no-store, private",
          "content-disposition": "attachment; filename=\"paper_final.pdf\"; filename*=UTF-8''paper%20%28final%27s%2A!%29.pdf",
          "content-length": metadataOnly ? "0" : String(selected.byteLength),
          "content-type": "application/pdf",
          etag: `"${sha256}"`,
          "x-content-type-options": "nosniff",
          ...(metadataOnly ? { "x-artifact-content-length": String(selected.byteLength) } : {}),
          ...(input.range === undefined ? {} : { "content-range": `bytes ${start}-${end}/${pdf.byteLength}` }),
        },
      });
    },
  });

  const full = await adapter.artifactContent({ artifactId }, CONTEXT);
  assert.equal(full.status, 200);
  assert.equal(full.filename, "paper (final's*!).pdf");
  assert.equal(full.mime, "application/pdf");
  assert.equal(full.totalBytes, pdf.byteLength);
  assert.equal(full.selectedBytes, pdf.byteLength);
  assert.deepEqual(new Uint8Array(await new Response(full.body).arrayBuffer()), pdf);
  assert.equal(calls[0].url, "http://127.0.0.1:18009/agent/v1/artifacts/content");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].headers.get("range"), null);
  assert.equal(calls[0].headers.get(AGINTI_INTERNAL_HEADERS.principal), CONTEXT.principalId);
  assert.equal(calls[0].headers.get(AGINTI_INTERNAL_HEADERS.browserSession), CONTEXT.browserSession);
  assert.deepEqual(calls[0].input, { artifactId });

  const metadata = await adapter.artifactContent({
    artifactId,
    metadataOnly: true,
    range: { start: 3, end: 9 },
  }, CONTEXT);
  assert.equal(metadata.status, 206);
  assert.equal(metadata.body, null);
  assert.equal(metadata.selectedBytes, 7);
  assert.deepEqual(metadata.range, { start: 3, end: 9, total: pdf.byteLength, value: `bytes 3-9/${pdf.byteLength}` });
  assert.equal(calls[1].headers.get("range"), null);
  assert.deepEqual(calls[1].input, { artifactId, metadataOnly: true, range: { start: 3, end: 9 } });
});

test("artifact content adapter preserves private absence semantics and rejects malformed upstream metadata", async () => {
  const artifactId = `art_${"b".repeat(64)}`;
  let status = 404;
  const adapter = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }),
  });
  for (const expected of [404, 410, 416]) {
    status = expected;
    assert.deepEqual(await adapter.artifactContent({ artifactId }, CONTEXT), { status: expected });
  }

  let calls = 0;
  const invalid = createAgintiAgentAdapter({
    upstream: "http://127.0.0.1:18009",
    credentialProvider: async () => TOKEN,
    fetchImpl: async () => {
      calls += 1;
      return new Response(new Uint8Array([1]), {
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=3600",
          "content-disposition": "inline; filename=paper.pdf",
          "content-length": "1",
          "content-type": "application/pdf",
          etag: `"${"a".repeat(64)}"`,
          "x-content-type-options": "nosniff",
        },
      });
    },
  });
  await assert.rejects(
    invalid.artifactContent({ artifactId }, CONTEXT),
    (error) => error instanceof AgintiAdapterError && error.code === "AGINTI_RESPONSE_INVALID" && error.statusCode === 502,
  );
  await assert.rejects(invalid.artifactContent({ artifactId, range: { start: 4, end: 3 } }, CONTEXT), TypeError);
  await assert.rejects(invalid.artifactContent({ artifactId, metadataOnly: "yes" }, CONTEXT), TypeError);
  await assert.rejects(invalid.artifactContent({ artifactId, range: { start: 0 }, extra: true }, CONTEXT), TypeError);
  assert.equal(calls, 1, "invalid browser input is rejected before transport");
});
