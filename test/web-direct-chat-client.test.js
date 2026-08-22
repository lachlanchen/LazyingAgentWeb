import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CLOUD_CSRF_COOKIE_NAME } from "../src/web/cloud-session-client.js";
import {
  DIRECT_CHAT_ROUTES,
  DirectChatBrowserClient,
  DirectChatProtocolError,
  DirectChatTransportError,
} from "../src/web/direct-chat-client.js";
import { createPwaIcon } from "../src/web/pwa-assets.js";

const CSRF = "csrf_token_abcdefghijklmnopqrstuvwxyz0123456789";
const NOW = "2026-08-20T08:00:00.000Z";
const LATER = "2026-08-20T08:00:01.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function idFactory() {
  let serial = 0;
  const factory = (kind) => `${kind}_${String(++serial).padStart(4, "0")}_${"x".repeat(24)}`;
  factory.count = () => serial;
  return factory;
}

function publicThread(overrides = {}) {
  return {
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    title: "",
    modelAlias: "local-default",
    revision: 0,
    ledgerHash: null,
    messageCount: 0,
    ledgerBytes: 0,
    currentGenerationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function publicGeneration(overrides = {}) {
  return {
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
    assistantMessageId: "assistant_0005_xxxxxxxxxxxxxxxxxxxxxxxx",
    status: "in_progress",
    terminal: false,
    modelAlias: "local-default",
    sourceRevision: 1,
    sourceHash: HASH_A,
    deltaCount: 0,
    deltaBytes: 0,
    lastDeltaHash: null,
    finalRevision: null,
    finalHash: null,
    failureCode: null,
    deltasPruned: false,
    startedAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
    prunedAt: null,
    ...overrides,
  };
}

function publicDelta(sequence, content, overrides = {}) {
  return {
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
    sequence,
    content,
    contentBytes: new TextEncoder().encode(content).byteLength,
    previousHash: sequence === 1 ? null : HASH_B,
    deltaHash: sequence === 1 ? HASH_B : HASH_C,
    createdAt: sequence === 1 ? NOW : LATER,
    ...overrides,
  };
}

function completedGeneration(overrides = {}) {
  return publicGeneration({
    status: "completed",
    terminal: true,
    deltaCount: 2,
    deltaBytes: 5,
    lastDeltaHash: HASH_C,
    finalRevision: 2,
    finalHash: HASH_A,
    updatedAt: LATER,
    terminalAt: LATER,
    ...overrides,
  });
}

function cancelledGeneration(overrides = {}) {
  return publicGeneration({
    status: "cancelled",
    terminal: true,
    updatedAt: LATER,
    terminalAt: LATER,
    ...overrides,
  });
}

function jsonResponse(value, { status = 200, contentType = "application/json; charset=utf-8", cacheControl = "no-store" } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType, "cache-control": cacheControl },
  });
}

function sseResponse(text, { chunks = [text.length], contentType = "text/event-stream; charset=utf-8", cacheControl = "no-store" } = {}) {
  const bytes = new TextEncoder().encode(text);
  const boundaries = chunks;
  const stream = new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const length of boundaries) {
        if (offset >= bytes.length) break;
        controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + length)));
        offset += length;
      }
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": contentType, "cache-control": cacheControl } });
}

function clientOptions(overrides = {}) {
  return {
    baseUrl: "https://llm.lazying.art/app/",
    cookieSource: `${CLOUD_CSRF_COOKIE_NAME}=${CSRF}`,
    makeOpaqueId: idFactory(),
    wait: async () => {},
    ...overrides,
  };
}

test("prepared create/start requests carry browser IDs and remain byte-identical across retries", async () => {
  const calls = [];
  const makeOpaqueId = idFactory();
  const client = new DirectChatBrowserClient(clientOptions({
    makeOpaqueId,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(DIRECT_CHAT_ROUTES.threadsCreate)) {
        const body = JSON.parse(options.body);
        return jsonResponse({ thread: publicThread({ threadId: body.threadId, title: body.title }) }, { status: 201 });
      }
      const body = JSON.parse(options.body);
      return jsonResponse({ generation: publicGeneration({
        threadId: body.threadId,
        generationId: body.generationId,
        assistantMessageId: body.assistantMessageId,
      }) }, { status: 202 });
    },
  }));

  const threadRequest = client.prepareThread({ title: "Durable chat" });
  assert.equal(Object.isFrozen(threadRequest), true);
  await client.createThread(threadRequest);
  await client.retryCreateThread(threadRequest);

  const runRequest = client.prepareRun({
    threadId: threadRequest.threadId,
    content: "  hello  ",
    expectedRevision: 0,
    expectedHash: null,
  });
  assert.equal(runRequest.content, "hello");
  assert.equal(Object.isFrozen(runRequest), true);
  const generatedBeforeDispatch = makeOpaqueId.count();
  await client.startRun(runRequest);
  await client.retryRun(runRequest);
  assert.equal(makeOpaqueId.count(), generatedBeforeDispatch);

  assert.equal(calls[0].url, "https://llm.lazying.art/api/chat/threads/create");
  assert.equal(calls[2].url, "https://llm.lazying.art/api/chat/runs/start");
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.headers.get("idempotency-key"), calls[1].options.headers.get("idempotency-key"));
  assert.equal(calls[2].options.body, calls[3].options.body);
  assert.equal(calls[2].options.headers.get("idempotency-key"), calls[3].options.headers.get("idempotency-key"));
  for (const { options } of calls) {
    const body = JSON.parse(options.body);
    assert.equal(Object.hasOwn(body, "accountId"), false);
    for (const field of ["provider", "model", "endpoint", "path", "baseUrl", "token"]) {
      assert.equal(Object.hasOwn(body, field), false);
    }
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.get("x-csrf-token"), CSRF);
    assert.equal(options.headers.get("authorization"), null);
    assert.equal(options.headers.get("x-lazyedge-principal-id"), null);
  }
});

test("vision capabilities, canonical image retries, and authenticated previews stay exact and bounded", async () => {
  const bytes = Buffer.from(createPwaIcon(192));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(DIRECT_CHAT_ROUTES.capabilities)) {
        return jsonResponse({
          visionInput: true,
          visionMediaTypes: ["image/jpeg", "image/png"],
          maximumImageBytes: 4 * 1024 * 1024,
        });
      }
      if (url.endsWith(DIRECT_CHAT_ROUTES.attachmentsGet)) {
        return new Response(bytes, {
          headers: {
            "content-type": "image/png",
            "content-length": String(bytes.byteLength),
            "cache-control": "no-store",
          },
        });
      }
      const body = JSON.parse(options.body);
      return jsonResponse({ generation: publicGeneration({
        threadId: body.threadId,
        generationId: body.generationId,
        assistantMessageId: body.assistantMessageId,
        modelAlias: "localllm-vision",
      }) }, { status: 202 });
    },
  }));

  assert.deepEqual(await client.capabilities(), {
    visionInput: true,
    visionMediaTypes: ["image/jpeg", "image/png"],
    maximumImageBytes: 4 * 1024 * 1024,
  });
  const request = client.prepareRun({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    content: "Describe this image.",
    expectedRevision: 0,
    expectedHash: null,
    attachment: {
      attachmentId: "image_0000000000000001",
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      width: 192,
      height: 192,
      bytes,
    },
  });
  await client.startRun(request);
  await client.retryRun(request);
  assert.equal(calls[1].options.body, calls[2].options.body);
  assert.equal(calls[1].options.headers.get("idempotency-key"), calls[2].options.headers.get("idempotency-key"));
  const runBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(runBody.attachment, {
    attachmentId: "image_0000000000000001",
    mediaType: "image/png",
    data: bytes.toString("base64"),
  });
  assert.equal(Object.hasOwn(runBody.attachment, "bytes"), false);
  assert.equal(Object.hasOwn(runBody.attachment, "sha256"), false);

  const descriptor = {
    attachmentId: "image_0000000000000001",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 192,
    height: 192,
    sha256: digest,
  };
  const preview = await client.getAttachment({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    attachment: descriptor,
  });
  assert.deepEqual(preview.descriptor, descriptor);
  assert.deepEqual(Buffer.from(preview.bytes), bytes);
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    attachmentId: "image_0000000000000001",
  });
  assert.equal(calls[3].options.cache, "no-store");
  assert.equal(calls[3].options.headers.get("x-csrf-token"), CSRF);
});

test("attachment previews reject dishonest metadata, digest changes, and oversized streams", async () => {
  const bytes = Buffer.from(createPwaIcon(192));
  const descriptor = {
    attachmentId: "image_0000000000000001",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 192,
    height: 192,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let responseBytes = Buffer.from(bytes);
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => new Response(responseBytes, {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    }),
  }));
  responseBytes[responseBytes.byteLength - 1] ^= 1;
  await assert.rejects(
    () => client.getAttachment({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      attachment: descriptor,
    }),
    /digest/u,
  );
  await assert.rejects(
    () => client.getAttachment({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      attachment: { ...descriptor, width: 9_999 },
    }),
    /width|descriptor/u,
  );

  let pulls = 0;
  let cancelled = false;
  const oversized = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/png", "cache-control": "no-store" } }),
  }));
  await assert.rejects(
    () => oversized.getAttachment({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      attachment: { ...descriptor, byteLength: 4 * 1024 * 1024 },
    }),
    /size limit/u,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 18, `oversized preview pulled ${pulls} chunks`);
});

test("read routes validate public owner-free thread and message envelopes", async () => {
  const thread = publicThread({ revision: 1, ledgerHash: HASH_A, messageCount: 1, ledgerBytes: 5 });
  const message = {
    threadId: thread.threadId,
    messageId: "message_0002_xxxxxxxxxxxxxxxxxxxxxxxx",
    revision: 1,
    role: "user",
    content: "hello",
    contentBytes: 5,
    previousHash: null,
    messageHash: HASH_A,
    generationId: null,
    createdAt: NOW,
  };
  const calls = [];
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith(DIRECT_CHAT_ROUTES.threadsList)) return jsonResponse({ threads: [thread] });
      if (url.endsWith(DIRECT_CHAT_ROUTES.threadsGet)) return jsonResponse({ thread });
      if (url.endsWith(DIRECT_CHAT_ROUTES.messagesList)) return jsonResponse({ messages: [message] });
      return jsonResponse({ generation: publicGeneration({ threadId: thread.threadId }) });
    },
  }));
  assert.equal((await client.listThreads({ limit: 5 })).threads[0].threadId, thread.threadId);
  assert.equal((await client.getThread(thread.threadId)).thread.threadId, thread.threadId);
  assert.equal((await client.listMessages({ threadId: thread.threadId })).messages[0].content, "hello");
  assert.equal((await client.getRunStatus({
    threadId: thread.threadId,
    generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
  })).generation.status, "in_progress");
  assert.deepEqual(calls.map((call) => call.body), [
    { limit: 5 },
    { threadId: thread.threadId },
    { threadId: thread.threadId, afterRevision: 0, limit: 100 },
    { threadId: thread.threadId, generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx" },
  ]);
});

test("the default Direct Chat fetch keeps the global browser receiver", async () => {
  const receivers = [];
  const originalFetch = globalThis.fetch;
  let clients;
  try {
    globalThis.fetch = function receiverSensitiveFetch() {
      receivers.push(this);
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse({ threads: [] }));
    };
    clients = [
      new DirectChatBrowserClient(clientOptions()),
      new DirectChatBrowserClient(clientOptions({ fetchImpl: globalThis.fetch })),
    ];
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const client of clients) assert.deepEqual(await client.listThreads(), { threads: [] });
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("public response validation rejects account identity, unknown fields, inconsistent hashes, and wrong statuses", async () => {
  let response = jsonResponse({ threads: [{ ...publicThread(), accountId: "principal-private" }] });
  const client = new DirectChatBrowserClient(clientOptions({ fetchImpl: async () => response }));
  await assert.rejects(() => client.listThreads(), /unsupported field/u);

  response = jsonResponse({ threads: [publicThread({ revision: 1, messageCount: 1, ledgerHash: null })] });
  await assert.rejects(() => client.listThreads(), /ledger(?:Hash| cursor)/u);

  response = jsonResponse({ threads: [publicThread()] }, { status: 201 });
  await assert.rejects(
    () => client.listThreads(),
    (error) => error instanceof DirectChatTransportError
      && error.status === 201
      && error.message === "Direct Chat request was not accepted.",
  );

  response = jsonResponse({ threads: [publicThread()] }, { contentType: "text/html" });
  await assert.rejects(() => client.listThreads(), /content type/u);

  response = jsonResponse({ threads: [publicThread()] }, { cacheControl: "private" });
  await assert.rejects(() => client.listThreads(), /no-store/u);
});

test("stream resumes from the persisted sequence across a bounded reconnect and accepts split CRLF UTF-8", async () => {
  const first = publicDelta(1, "A");
  const second = publicDelta(2, "β");
  const firstBody = [
    ": heartbeat",
    `id: 1\nevent: delta\ndata: ${JSON.stringify(first)}`,
    `event: reconnect\ndata: ${JSON.stringify({ afterSequence: 1 })}`,
    "",
  ].join("\r\n\r\n");
  const secondBody = [
    `id: 2\nevent: delta\ndata: ${JSON.stringify(second)}`,
    `event: generation\ndata: ${JSON.stringify(completedGeneration({ deltaBytes: 3 }))}`,
    "",
  ].join("\n\n");
  const requests = [];
  const cursorWrites = [];
  let dispatch = 0;
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      dispatch += 1;
      return dispatch === 1
        ? sseResponse(firstBody, { chunks: [1, 3, 17, 2, 41] })
        : sseResponse(secondBody, { chunks: [5, 2, 1, 29], contentType: "Text/Event-Stream; Charset=UTF-8" });
    },
  }));
  const events = [];
  for await (const event of client.streamRunEvents({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
    onCursor: async (cursor) => { cursorWrites.push(cursor.afterSequence); },
  })) events.push(event);
  assert.deepEqual(requests.map((request) => request.afterSequence), [0, 1]);
  assert.deepEqual(cursorWrites, [1, 2]);
  assert.deepEqual(events.map((event) => event.type), ["delta", "delta", "generation"]);
  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.delta.content), ["A", "β"]);
  assert.equal(events.at(-1).generation.status, "completed");
});

test("ending event delivery detaches only; durable cancellation requires its explicit route", async () => {
  let streamCancelled = false;
  const routes = [];
  const first = publicDelta(1, "A");
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async (url, options) => {
      routes.push(url);
      if (url.endsWith(DIRECT_CHAT_ROUTES.runsEvents)) {
        const text = `id: 1\nevent: delta\ndata: ${JSON.stringify(first)}\n\n`;
        const bytes = new TextEncoder().encode(text);
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(bytes); },
          cancel() { streamCancelled = true; },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      const body = JSON.parse(options.body);
      return jsonResponse({ generation: cancelledGeneration({
        threadId: body.threadId,
        generationId: body.generationId,
      }) });
    },
  }));
  const iterator = client.streamRunEvents({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
  });
  assert.equal((await iterator.next()).value.delta.content, "A");
  await iterator.return();
  assert.equal(streamCancelled, true);
  assert.deepEqual(routes, ["https://llm.lazying.art/api/chat/runs/events"]);

  const cancellation = client.prepareCancellation({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
  });
  await client.cancelRun(cancellation);
  assert.deepEqual(routes, [
    "https://llm.lazying.art/api/chat/runs/events",
    "https://llm.lazying.art/api/chat/runs/cancel",
  ]);
});

test("SSE parser rejects owner leakage, gaps, repeated fields, and cursor persistence failure", async () => {
  const cases = [
    `id: 1\nevent: delta\ndata: ${JSON.stringify({ ...publicDelta(1, "A"), accountId: "private" })}\n\n`,
    `id: 2\nevent: delta\ndata: ${JSON.stringify(publicDelta(2, "B"))}\n\n`,
    `id: 1\nid: 1\nevent: delta\ndata: ${JSON.stringify(publicDelta(1, "A"))}\n\n`,
  ];
  for (const text of cases) {
    const client = new DirectChatBrowserClient(clientOptions({ fetchImpl: async () => sseResponse(text) }));
    await assert.rejects(async () => {
      for await (const _event of client.streamRunEvents({
        threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
        generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
        maxReconnects: 0,
      })) { /* consume */ }
    }, DirectChatProtocolError);
  }

  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => sseResponse(`id: 1\nevent: delta\ndata: ${JSON.stringify(publicDelta(1, "A"))}\n\n`),
  }));
  await assert.rejects(async () => {
    for await (const _event of client.streamRunEvents({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
      onCursor: async () => { throw new Error("storage failed"); },
    })) { /* consume */ }
  }, (error) => error.code === "cursor_persistence_failed");
});

test("request validators reject browser provider controls and a missing authenticated cookie before dispatch", async () => {
  let dispatches = 0;
  const client = new DirectChatBrowserClient(clientOptions({
    cookieSource: "",
    fetchImpl: async () => { dispatches += 1; return jsonResponse({ threads: [] }); },
  }));
  await assert.rejects(() => client.listThreads(), (error) => error.code === "authentication_required");
  assert.equal(dispatches, 0);

  const authenticated = new DirectChatBrowserClient(clientOptions({ fetchImpl: async () => jsonResponse({ generation: publicGeneration() }, { status: 202 }) }));
  const prepared = authenticated.prepareRun({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    content: "hello",
    expectedRevision: 0,
    expectedHash: null,
  });
  await assert.rejects(() => authenticated.startRun({ ...prepared, model: "browser-choice" }), /unsupported field/u);
  await assert.rejects(() => authenticated.startRun({ ...prepared, accountId: "private" }), /unsupported field/u);
  assert.throws(() => authenticated.prepareRun({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    content: "hello",
    expectedRevision: 0,
    expectedHash: null,
    provider: "browser-choice",
  }), /unsupported field/u);
  await assert.rejects(() => authenticated.listThreads({ accountId: "private" }), /unsupported field/u);
  assert.throws(() => new DirectChatBrowserClient({ ...clientOptions(), endpoint: "/v1/chat/completions" }), /unsupported field/u);
});

test("Direct Chat transport rejects invalid response objects, redirects, dishonest lengths, and malformed SSE headers", async () => {
  let response = { status: 200, headers: {} };
  const client = new DirectChatBrowserClient(clientOptions({ fetchImpl: async () => response }));
  await assert.rejects(() => client.listThreads(), /invalid response/u);

  response = jsonResponse({ threads: [] });
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(() => client.listThreads(), /unexpected URL/u);

  response = new Response("{}", {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": String(513 * 1024),
    },
  });
  await assert.rejects(() => client.listThreads(), /size limit/u);

  response = sseResponse("event: reconnect\ndata: {\"afterSequence\":0}\n\n", { contentType: "application/json" });
  await assert.rejects(async () => {
    for await (const _event of client.streamRunEvents({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
    })) { /* consume */ }
  }, /content type/u);
});
