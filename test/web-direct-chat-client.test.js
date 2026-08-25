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
const RELEASE = `release-${"a".repeat(64)}`;
const NEXT_RELEASE = `release-${"b".repeat(64)}`;
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

function jsonResponse(value, {
  status = 200,
  contentType = "application/json; charset=utf-8",
  cacheControl = "no-store",
  releaseId,
} = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl,
      ...(releaseId === undefined ? {} : { "x-lazying-agent-release": releaseId }),
    },
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

test("pinned Direct Chat uses retained session CSRF when iOS hides the cookie and reports release replacement", async () => {
  const calls = [];
  let responseRelease = RELEASE;
  const client = new DirectChatBrowserClient(clientOptions({
    cookieSource: "",
    csrfToken: () => CSRF,
    releaseId: RELEASE,
    fetchImpl: async (_url, options) => {
      calls.push(options.headers);
      return jsonResponse({ visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }, {
        releaseId: responseRelease,
      });
    },
  }));

  assert.equal((await client.capabilities()).visionInput, false);
  assert.equal(calls[0].get("x-csrf-token"), CSRF);
  assert.equal(calls[0].get("x-lazying-agent-release"), RELEASE);

  responseRelease = NEXT_RELEASE;
  await assert.rejects(
    () => client.capabilities(),
    (error) => error instanceof DirectChatTransportError
      && error.code === "client_release_mismatch"
      && error.serverRelease === NEXT_RELEASE
      && error.retryable === false,
  );
});

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
    content: "  hello\nworld\tagain\r\n  ",
    expectedRevision: 0,
    expectedHash: null,
  });
  assert.equal(runRequest.content, "hello\nworld\tagain");
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

test("prepared thread deletion retries one exact cursor-bound mutation without Agent coupling", async () => {
  const calls = [];
  const makeOpaqueId = idFactory();
  const client = new DirectChatBrowserClient(clientOptions({
    makeOpaqueId,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      return jsonResponse({ deleted: true, threadId: body.threadId });
    },
  }));
  const thread = publicThread({ revision: 2, ledgerHash: HASH_A, messageCount: 2 });
  const prepared = client.prepareThreadDeletion({
    threadId: thread.threadId,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
  });
  const generatedBeforeDispatch = makeOpaqueId.count();
  const first = await client.deleteThread(prepared);
  const replay = await client.retryDeleteThread(prepared);
  assert.deepEqual(first, replay);
  assert.equal(first.deleted, true);
  assert.equal(makeOpaqueId.count(), generatedBeforeDispatch);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://llm.lazying.art/api/chat/threads/delete");
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.headers.get("idempotency-key"), calls[1].options.headers.get("idempotency-key"));
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    threadId: thread.threadId,
    expectedRevision: 2,
    expectedHash: HASH_A,
  });
  assert.equal(calls[0].options.headers.get("x-csrf-token"), CSRF);
  assert.equal(calls[0].options.method, "POST");

  assert.throws(() => client.prepareThreadDeletion({
    threadId: thread.threadId,
    expectedRevision: 0,
    expectedHash: HASH_A,
  }), /expectedHash/u);

  const hostile = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => jsonResponse({
      deleted: true,
      threadId: thread.threadId,
      schemaVersion: "agent-thread-delete",
    }),
  }));
  await assert.rejects(hostile.deleteThread(hostile.prepareThreadDeletion({
    threadId: thread.threadId,
    expectedRevision: 2,
    expectedHash: HASH_A,
  })), DirectChatProtocolError);
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

test("multi-image run tickets preserve order and bytes across exact retries", async () => {
  const bytes = Buffer.from(createPwaIcon(192));
  const calls = [];
  const originalStringify = JSON.stringify;
  let runBodySerializations = 0;
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async (_url, options) => {
      calls.push(options);
      const body = JSON.parse(options.body);
      return jsonResponse({ generation: publicGeneration({
        threadId: body.threadId,
        generationId: body.generationId,
        assistantMessageId: body.assistantMessageId,
        modelAlias: "localllm-vision",
      }) }, { status: 202 });
    },
  }));
  const attachments = ["first", "second"].map((suffix) => ({
    attachmentId: `image_${suffix}_0000000000000001`,
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 192,
    height: 192,
    bytes,
  }));
  let request;
  try {
    JSON.stringify = (value, ...rest) => {
      if (value?.attachments !== undefined) runBodySerializations += 1;
      return originalStringify(value, ...rest);
    };
    request = client.prepareRun({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      content: "Compare these images in order.",
      expectedRevision: 0,
      expectedHash: null,
      attachments,
    });
    await client.startRun(request);
    await client.retryRun(request);
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.equal(runBodySerializations, 1, "the exact large JSON upload body is serialized once before dispatch");
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[0].body).attachments, attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    mediaType: attachment.mediaType,
    data: bytes.toString("base64"),
  })));
  assert.throws(() => client.prepareRun({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    content: "Too many.",
    expectedRevision: 0,
    expectedHash: null,
    attachments: [...attachments, attachments[0], attachments[1], attachments[0]],
  }), /invalid/u);
  assert.throws(() => client.prepareRun({
    threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
    content: "Reject duplicate identities.",
    expectedRevision: 0,
    expectedHash: null,
    attachments: [attachments[0], { ...attachments[1], attachmentId: attachments[0].attachmentId }],
  }), /unique/u);

  const encodedBeyondFourMiB = "A".repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4);
  await assert.rejects(client.startRun({
    ...request,
    attachments: Array.from({ length: 4 }, (_, index) => ({
      attachmentId: `image_aggregate_${index}_xxxxxxxxxxxx`,
      mediaType: "image/png",
      data: encodedBeyondFourMiB,
    })),
  }), /aggregate/u);

  const sparseAttachments = new Array(2);
  sparseAttachments[0] = request.attachments[0];
  await assert.rejects(client.startRun({
    ...request,
    attachments: sparseAttachments,
  }), /dense/u);

  let getterCalls = 0;
  const accessorAttachments = [request.attachments[0], request.attachments[1]];
  Object.defineProperty(accessorAttachments, 1, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return request.attachments[1];
    },
  });
  await assert.rejects(client.startRun({
    ...request,
    attachments: accessorAttachments,
  }), /dense/u);
  assert.equal(getterCalls, 0);
});

test("a local large-body serialization failure occurs before any ambiguous network dispatch", () => {
  const bytes = Buffer.from(createPwaIcon(192));
  let fetchCalls = 0;
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    },
  }));
  const attachments = [0, 1].map((index) => ({
    attachmentId: `image_serialize_${index}_xxxxxxxxxxxx`,
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 192,
    height: 192,
    bytes,
  }));
  const originalStringify = JSON.stringify;
  try {
    JSON.stringify = (value, ...rest) => {
      if (value?.attachments !== undefined) throw new RangeError("simulated mobile allocation failure");
      return originalStringify(value, ...rest);
    };
    assert.throws(() => client.prepareRun({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      content: "Preserve this unsent image draft.",
      expectedRevision: 0,
      expectedHash: null,
      attachments,
    }), /allocation failure/u);
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.equal(fetchCalls, 0);
});

test("maximum-size image base64 uses bounded mobile intermediates and stays canonical", () => {
  const bytes = new Uint8Array(4 * 1024 * 1024);
  Object.defineProperty(bytes, "toBase64", { value: undefined });
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index & 0xff;
  const originalBtoa = globalThis.btoa;
  let calls = 0;
  let maximumInput = 0;
  try {
    globalThis.btoa = (value) => {
      calls += 1;
      maximumInput = Math.max(maximumInput, value.length);
      return originalBtoa(value);
    };
    const client = new DirectChatBrowserClient(clientOptions());
    const request = client.prepareRun({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      content: "Describe the maximum-size image.",
      expectedRevision: 0,
      expectedHash: null,
      attachment: {
        attachmentId: "image_0000000000000099",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 4_096,
        height: 4_096,
        bytes,
      },
    });
    assert.ok(calls > 1);
    assert.ok(maximumInput <= 12 * 1024, `largest btoa input was ${maximumInput} bytes`);
    assert.equal(request.attachment.data.length, Math.ceil(bytes.byteLength / 3) * 4);
    assert.deepEqual(Buffer.from(request.attachment.data, "base64"), Buffer.from(bytes));
  } finally {
    globalThis.btoa = originalBtoa;
  }
});

test("native Uint8Array base64 avoids binary-string upload intermediates", () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  let nativeCalls = 0;
  Object.defineProperty(bytes, "toBase64", {
    value() {
      nativeCalls += 1;
      return Buffer.from(this).toString("base64");
    },
  });
  const originalBtoa = globalThis.btoa;
  try {
    globalThis.btoa = () => { throw new Error("the native path must not allocate a binary string"); };
    const client = new DirectChatBrowserClient(clientOptions());
    const request = client.prepareRun({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      content: "Use the native mobile encoder.",
      expectedRevision: 0,
      expectedHash: null,
      attachment: {
        attachmentId: "image_0000000000000100",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 1,
        height: 1,
        bytes,
      },
    });
    assert.equal(nativeCalls, 1);
    assert.equal(request.attachment.data, "AAEC/f7/");
  } finally {
    globalThis.btoa = originalBtoa;
  }
});

test("server body-abort envelopes remain retryable for the app's exact idempotent ticket", async () => {
  for (const code of ["request_aborted", "request_error"]) {
    const client = new DirectChatBrowserClient(clientOptions({
      fetchImpl: async () => jsonResponse({ error: { code, message: "Body read stopped." } }, { status: 400 }),
    }));
    await assert.rejects(
      () => client.listThreads(),
      (error) => error instanceof DirectChatTransportError
        && error.code === code
        && error.status === 400
        && error.retryable === true,
    );
  }
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
    { threadId: thread.threadId, afterRevision: 0, limit: 100, attachmentSchema: 2 },
    { threadId: thread.threadId, generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx" },
  ]);
});

test("message reads accept an ordered bounded attachment array without private bytes", async () => {
  const thread = publicThread({ revision: 1, ledgerHash: HASH_A, messageCount: 1, ledgerBytes: 5 });
  const attachments = [HASH_B, HASH_C].map((digest, index) => ({
    attachmentId: `image_read_${index}_xxxxxxxxxxxxxxxx`,
    mediaType: "image/png",
    byteLength: index + 1,
    width: 1,
    height: 1,
    sha256: digest,
  }));
  const message = {
    threadId: thread.threadId,
    messageId: "message_multi_read_xxxxxxxxxxxxxxxx",
    revision: 1,
    role: "user",
    content: "hello",
    contentBytes: 5,
    previousHash: null,
    messageHash: HASH_A,
    generationId: null,
    createdAt: NOW,
    attachments,
  };
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => jsonResponse({ messages: [message] }),
  }));
  const response = await client.listMessages({ threadId: thread.threadId });
  assert.deepEqual(response.messages[0].attachments, attachments);
  assert.equal(Object.hasOwn(response.messages[0], "attachment"), false);
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

test("an explicit reconnect boundary is retryable when the app owns recovery", async () => {
  const client = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => sseResponse('event: reconnect\ndata: {"afterSequence":0}\n\n'),
  }));
  await assert.rejects(async () => {
    for await (const _event of client.streamRunEvents({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
      maxReconnects: 0,
    })) { /* consume */ }
  }, (error) => error instanceof DirectChatTransportError
    && error.code === "stream_interrupted"
    && error.retryable === true);

  const incomplete = new DirectChatBrowserClient(clientOptions({
    fetchImpl: async () => sseResponse(`id: 1\nevent: delta\ndata: ${JSON.stringify(publicDelta(1, "A"))}\n\n`),
  }));
  await assert.rejects(async () => {
    for await (const _event of incomplete.streamRunEvents({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      generationId: "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx",
      maxReconnects: 0,
    })) { /* consume */ }
  }, DirectChatProtocolError);
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
  for (const content of ["unsafe\u000bcontrol", "unsafe\u001fcontrol", "unsafe\u007fcontrol"]) {
    assert.throws(() => authenticated.prepareRun({
      threadId: "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx",
      content,
      expectedRevision: 0,
      expectedHash: null,
    }), /content is invalid/u);
  }
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
