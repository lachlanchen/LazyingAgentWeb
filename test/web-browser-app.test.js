import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBrowserApp } from "../src/web/browser-app.js";
import { canonicalJson, verifyAgentEvent } from "../src/web/aginti-protocol.js";
import { DirectChatTransportError } from "../src/web/direct-chat-client.js";

const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";
const RUN_ID = "run_12345678-1234-4123-8123-123456789abc";
const NOW = "2026-08-20T08:00:00.000Z";
const ZERO_HASH = "0".repeat(64);
const CHAT_THREAD_ID = "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx";
const CHAT_GENERATION_ID = "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx";
const CHAT_HASH_A = "a".repeat(64);
const CHAT_HASH_B = "b".repeat(64);

function chatThread(overrides = {}) {
  return {
    threadId: CHAT_THREAD_ID,
    title: "Durable chat",
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

function chatMessage(revision, role, content, overrides = {}) {
  return {
    threadId: CHAT_THREAD_ID,
    messageId: `message_${String(revision).padStart(4, "0")}_xxxxxxxxxxxxxxxxxxxxxxxx`,
    revision,
    role,
    content,
    contentBytes: new TextEncoder().encode(content).byteLength,
    previousHash: revision === 1 ? null : CHAT_HASH_A,
    messageHash: revision === 1 ? CHAT_HASH_A : CHAT_HASH_B,
    generationId: role === "assistant" ? CHAT_GENERATION_ID : null,
    createdAt: NOW,
    ...overrides,
  };
}

function chatGeneration(overrides = {}) {
  return {
    threadId: CHAT_THREAD_ID,
    generationId: CHAT_GENERATION_ID,
    status: "in_progress",
    terminal: false,
    ...overrides,
  };
}

class Node {
  constructor(tagName = "div", text = "") {
    this.tagName = tagName;
    this.nodeValue = text;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) { this.children = []; children.forEach((child) => this.appendChild(child)); }
  addEventListener(name, listener) {
    const current = this.listeners.get(name) ?? [];
    current.push(listener);
    this.listeners.set(name, current);
  }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get textContent() { return this.tagName === "#text" ? this.nodeValue : this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.children = [new Node("#text", String(value))]; }
}

const IDS = [
  "login-view", "app-view", "login-form", "login-submit", "login-error", "username", "password", "remember-session",
  "signed-in-user", "logout", "new-thread", "thread-list", "workspace", "conversation-title",
  "connection-state", "mode-switch", "agent-mode", "chat-mode", "theme-picker", "offline-banner",
  "update-banner", "apply-update", "defer-update", "context-indicator", "context-indicator-text", "welcome",
  "welcome-eyebrow", "welcome-copy", "messages", "activity-panel", "run-state", "agent-plan",
  "agent-timeline", "agent-artifacts", "composer", "message-input", "send-message", "resume-run",
  "stop-run", "image-input", "add-image", "image-preview", "image-preview-thumbnail",
  "image-preview-label", "remove-image", "install-app", "toast", "sidebar", "sidebar-scrim", "open-sidebar",
];

class Document {
  constructor() {
    this.documentElement = new Node("html");
    this.ids = new Map(IDS.map((id) => [id, new Node(id === "composer" || id === "login-form" ? "form" : "div")]));
    this.ids.get("app-view").hidden = true;
    this.ids.get("mode-switch").hidden = true;
    this.ids.get("login-submit").disabled = true;
    this.ids.get("login-submit").textContent = "Preparing secure sign-in…";
    this.ids.get("login-form").setAttribute("aria-busy", "true");
    this.ids.get("logout").disabled = true;
    this.ids.get("remember-session").checked = true;
  }
  getElementById(id) { return this.ids.get(id) ?? null; }
  createElement(name) { return new Node(name); }
  createTextNode(value) { return new Node("#text", String(value)); }
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

function baseAgent(capability = capabilities()) {
  return {
    async capabilities() { return capability; },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async *streamRunEvents() {},
  };
}

function baseChat(overrides = {}) {
  return {
    async capabilities() { return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }; },
    prepareThread() { throw new Error("unexpected Direct Chat mutation"); },
    async createThread() { throw new Error("unexpected Direct Chat mutation"); },
    async retryCreateThread() { throw new Error("unexpected Direct Chat mutation"); },
    async listThreads() { return { threads: [] }; },
    async getThread() { throw new Error("unexpected Direct Chat read"); },
    async listMessages() { throw new Error("unexpected Direct Chat read"); },
    async getAttachment() { throw new Error("unexpected Direct Chat attachment read"); },
    prepareRun() { throw new Error("unexpected Direct Chat mutation"); },
    async startRun() { throw new Error("unexpected Direct Chat mutation"); },
    async retryRun() { throw new Error("unexpected Direct Chat mutation"); },
    async getRunStatus() { throw new Error("unexpected Direct Chat read"); },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("unexpected Direct Chat mutation"); },
    async cancelRun() { throw new Error("unexpected Direct Chat mutation"); },
    ...overrides,
  };
}

function harness({
  restore = { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" },
  login,
  logout,
  agent = baseAgent(),
  chat,
  credentialSaver = async () => false,
  canonicalizeImage,
  createObjectUrl,
  revokeObjectUrl,
  wait = async () => {},
  maxStreamBackoffSteps = 5,
} = {}) {
  const document = new Document();
  const windowListeners = new Map();
  const window = {
    location: { protocol: "http:", reload() {} },
    setTimeout() {},
    addEventListener(name, listener) {
      const current = windowListeners.get(name) ?? [];
      current.push(listener);
      windowListeners.set(name, current);
    },
  };
  const sessionClient = {
    async restore() { return restore; },
    async login(value) { return login ? await login(value) : restore; },
    async logout() { return logout ? await logout() : { signedOut: true, agentCancellationPending: false }; },
  };
  const directChat = chat ?? baseChat();
  const app = createBrowserApp({
    document,
    window,
    navigator: { onLine: true },
    sessionClient,
    createAgentClient: () => agent,
    createChatClient: () => directChat,
    renderer: {
      renderMarkdown(target, value) { target.textContent = value; },
      renderArtifact(target, value) { target.textContent = value.title; return true; },
    },
    credentialSaver,
    ...(canonicalizeImage === undefined ? {} : { canonicalizeImage }),
    ...(createObjectUrl === undefined ? {} : { createObjectUrl }),
    ...(revokeObjectUrl === undefined ? {} : { revokeObjectUrl }),
    wait,
    maxStreamBackoffSteps,
  });
  return { app, document, sessionClient };
}

function digest(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

test("sign-in stays disabled until startup restore settles and then accepts exactly one request", async () => {
  const startup = Promise.withResolvers();
  const loginResult = Promise.withResolvers();
  let loginCalls = 0;
  const browser = harness({
    restore: startup.promise,
    async login(value) {
      loginCalls += 1;
      assert.deepEqual(value, { username: "account-user", password: "correct horse", remember: true });
      return await loginResult.promise;
    },
  });
  const submit = browser.document.getElementById("login-submit");
  const form = browser.document.getElementById("login-form");
  const username = browser.document.getElementById("username");
  const password = browser.document.getElementById("password");
  username.value = "account-user";
  password.value = "correct horse";

  const initializing = browser.app.initialize();
  assert.equal(submit.disabled, true);
  assert.equal(submit.textContent, "Preparing secure sign-in…");
  assert.equal(form.getAttribute("aria-busy"), "true");
  let prevented = false;
  form.dispatch("submit", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "the bound form handler prevents native submission during restore");
  await Promise.resolve();
  assert.equal(loginCalls, 0, "login cannot overlap the authoritative startup restore");

  startup.resolve({ authenticated: false });
  await initializing;
  assert.equal(password.value, "correct horse", "startup restore preserves typed or autofilled credentials");
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, "Sign in");
  assert.equal(form.getAttribute("aria-busy"), "false");

  const first = browser.app.login({ preventDefault() {} });
  const duplicate = browser.app.login({ preventDefault() {} });
  assert.equal(loginCalls, 1, "a pending login remains single-flight");
  assert.equal(submit.disabled, true);
  assert.equal(submit.textContent, "Signing in…");
  loginResult.resolve({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" });
  await Promise.all([first, duplicate]);
  assert.equal(password.value, "", "an actual login attempt clears the password field");
  assert.equal(browser.document.getElementById("login-view").hidden, true);
  assert.equal(browser.document.getElementById("app-view").hidden, false);
  await browser.app.logout();
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, "Sign in");
});

test("failed startup restore releases the guarded sign-in control", async () => {
  const browser = harness({ restore: Promise.reject(new Error("session unavailable")) });
  await browser.app.initialize();
  assert.equal(browser.document.getElementById("login-submit").disabled, false);
  assert.equal(browser.document.getElementById("login-submit").textContent, "Sign in");
  assert.equal(browser.document.getElementById("login-form").getAttribute("aria-busy"), "false");
  assert.equal(browser.document.getElementById("login-error").hidden, false);
});

test("authenticated startup restore clears a typed password before hydration can stall", async () => {
  const startup = Promise.withResolvers();
  const threads = Promise.withResolvers();
  const threadsStarted = Promise.withResolvers();
  const browser = harness({
    restore: startup.promise,
    chat: baseChat({
      async listThreads() {
        threadsStarted.resolve();
        return await threads.promise;
      },
    }),
  });
  const password = browser.document.getElementById("password");
  password.value = "must-not-remain-hidden";
  const initializing = browser.app.initialize();
  startup.resolve({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" });
  await threadsStarted.promise;
  assert.equal(password.value, "", "an authenticated restore clears typed or autofilled secret input immediately");
  assert.equal(browser.document.getElementById("login-view").hidden, true);
  assert.equal(browser.document.getElementById("logout").disabled, true, "sign-out stays guarded during hydration");
  threads.resolve({ threads: [] });
  await initializing;
  assert.equal(browser.document.getElementById("logout").disabled, false);
});

test("sign-out stays disabled while successful login hydration is pending", async () => {
  const threads = Promise.withResolvers();
  const threadsStarted = Promise.withResolvers();
  let logoutCalls = 0;
  const browser = harness({
    restore: { authenticated: false },
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    logout: async () => {
      logoutCalls += 1;
      return { signedOut: true, agentCancellationPending: false };
    },
    chat: baseChat({
      async listThreads() {
        threadsStarted.resolve();
        return await threads.promise;
      },
    }),
  });
  await browser.app.initialize();
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "not-retained";
  const signingIn = browser.app.login({ preventDefault() {} });
  await threadsStarted.promise;
  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(browser.document.getElementById("password").value, "", "a validated login clears its secret before hydration finishes");
  assert.equal(browser.document.getElementById("logout").disabled, true);
  await browser.app.logout();
  assert.equal(logoutCalls, 0, "a programmatic sign-out is also rejected while authentication is hydrating");
  assert.equal(browser.document.getElementById("login-view").hidden, true);
  assert.equal(browser.document.getElementById("login-submit").disabled, true);
  threads.resolve({ threads: [] });
  await signingIn;
  assert.equal(browser.document.getElementById("logout").disabled, false);
  await browser.app.logout();
  assert.equal(logoutCalls, 1);
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("login-submit").disabled, false);
});

test("failed login clears the password and releases the single-flight guard", async () => {
  let loginCalls = 0;
  const browser = harness({
    restore: { authenticated: false },
    async login() {
      loginCalls += 1;
      if (loginCalls === 1) throw Object.assign(new Error("invalid credentials"), { status: 401 });
      return { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" };
    },
  });
  await browser.app.initialize();
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "wrong password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(loginCalls, 1);
  assert.equal(browser.document.getElementById("password").value, "");
  assert.equal(browser.document.getElementById("login-submit").disabled, false);
  assert.equal(browser.document.getElementById("login-submit").textContent, "Sign in");
  assert.equal(browser.document.getElementById("login-form").getAttribute("aria-busy"), "false");
  assert.match(browser.document.getElementById("login-error").textContent, /Sign-in failed/u);
  browser.document.getElementById("password").value = "correct password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(loginCalls, 2, "the released guard permits a second attempt");
  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(browser.document.getElementById("password").value, "");
});

async function verifiedEvent({ seq, type, payload, previousHash }) {
  const envelope = {
    schemaVersion: "1",
    id: `${RUN_ID}.${seq}`,
    seq,
    type,
    threadId: THREAD_ID,
    runId: RUN_ID,
    createdAt: NOW,
    payload,
    previousHash,
  };
  const value = { ...envelope, hash: digest(canonicalJson(envelope)) };
  return await verifyAgentEvent(value, {
    expectedRunId: RUN_ID,
    expectedThreadId: THREAD_ID,
    afterSeq: seq - 1,
    previousHash,
    digest: async (input) => digest(input),
  });
}

function run(status = "running") {
  return { id: RUN_ID, threadId: THREAD_ID, status, output: status === "completed" ? "Done" : "" };
}

test("browser UI defaults to Agent only after an exact enabled AgInTi capability", async () => {
  const enabled = harness({
    agent: baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
  });
  await enabled.app.initialize();
  assert.equal(enabled.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(enabled.document.getElementById("mode-switch").hidden, false);
  assert.equal(enabled.document.getElementById("agent-mode").getAttribute("aria-pressed"), "true");

  const malformed = harness({ agent: baseAgent({ ...capabilities({ enabled: true }), runtime: { model: "browser-choice" } }) });
  await malformed.app.initialize();
  assert.equal(malformed.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(malformed.document.getElementById("mode-switch").hidden, true);
});

test("startup restores the server-owned Direct Chat thread and message ledger", async () => {
  const thread = chatThread({
    revision: 2,
    ledgerHash: CHAT_HASH_B,
    messageCount: 2,
    ledgerBytes: 25,
  });
  const messages = [chatMessage(1, "user", "Remember this"), chatMessage(2, "assistant", "Restored answer")];
  let threadReads = 0;
  const browser = harness({
    chat: baseChat({
      async listThreads() { return { threads: [thread] }; },
      async getThread(threadId) { threadReads += 1; assert.equal(threadId, CHAT_THREAD_ID); return { thread }; },
      async listMessages({ threadId, afterRevision, limit }) {
        assert.equal(threadId, CHAT_THREAD_ID);
        return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
      },
    }),
  });
  await browser.app.initialize();
  assert.equal(threadReads, 2, "a stable ledger cursor is confirmed before rendering");
  assert.equal(browser.document.getElementById("conversation-title").textContent, "Durable chat");
  assert.equal(browser.document.getElementById("thread-list").children.length, 1);
  assert.match(browser.document.getElementById("messages").textContent, /Remember thisRestored answer/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Direct Chat creates and starts with exact retry tickets, then reconnects SSE without duplicate dispatch", async () => {
  let authoritativeThread = null;
  let authoritativeMessages = [];
  let authoritativeGeneration = null;
  const createTickets = [];
  const runTickets = [];
  const streamCursors = [];
  let streams = 0;
  const waits = [];
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_xxxxxxxxxxxxxxxxx" });
    },
    async createThread(ticket) {
      createTickets.push(ticket);
      authoritativeThread = chatThread({ title: ticket.title });
      throw Object.assign(new Error("response lost"), { retryable: true });
    },
    async retryCreateThread(ticket) {
      createTickets.push(ticket);
      return { request: ticket, thread: authoritativeThread };
    },
    async listThreads() { return { threads: authoritativeThread ? [authoritativeThread] : [] }; },
    async getThread(threadId) { assert.equal(threadId, CHAT_THREAD_ID); return { thread: authoritativeThread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: authoritativeMessages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      assert.equal(request.expectedRevision, 0);
      assert.equal(request.expectedHash, null);
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_xxxxxxxxxxxxxxxxxxxx" });
    },
    async startRun(ticket) {
      runTickets.push(ticket);
      authoritativeMessages = [chatMessage(1, "user", ticket.content)];
      authoritativeThread = chatThread({
        title: authoritativeThread.title,
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: ticket.content.length,
        currentGenerationId: CHAT_GENERATION_ID,
      });
      authoritativeGeneration = chatGeneration();
      throw Object.assign(new Error("accepted response lost"), { retryable: true });
    },
    async retryRun(ticket) {
      runTickets.push(ticket);
      return { request: ticket, generation: authoritativeGeneration };
    },
    async getRunStatus() { return { generation: authoritativeGeneration }; },
    async *streamRunEvents(options) {
      streamCursors.push(options.afterSequence);
      streams += 1;
      if (streams === 1) {
        await options.onCursor({ afterSequence: 1 });
        yield { type: "delta", delta: { content: "Hel" }, afterSequence: 1 };
        throw Object.assign(new Error("rotated"), { retryable: true });
      }
      await options.onCursor({ afterSequence: 2 });
      yield { type: "delta", delta: { content: "lo" }, afterSequence: 2 };
      authoritativeMessages = [
        authoritativeMessages[0],
        chatMessage(2, "assistant", "Hello authoritative"),
      ];
      authoritativeThread = chatThread({
        title: authoritativeThread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: 30,
      });
      authoritativeGeneration = chatGeneration({ status: "completed", terminal: true });
      yield { type: "generation", generation: authoritativeGeneration, afterSequence: 2 };
    },
  });
  const browser = harness({ chat, wait: async (milliseconds) => { waits.push(milliseconds); } });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Hello durable world";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createTickets.length, 2);
  assert.equal(createTickets[0], createTickets[1], "thread retry reuses the exact prepared ticket");
  assert.equal(runTickets.length, 2);
  assert.equal(runTickets[0], runTickets[1], "run retry reuses the exact prepared ticket");
  assert.deepEqual(streamCursors, [0, 1]);
  assert.deepEqual(waits, [250, 250, 250]);
  assert.equal(streams, 2);
  assert.match(browser.document.getElementById("messages").textContent, /Hello durable worldHello authoritative/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("two sequential normal turns advance the authoritative ledger without duplicate dispatch", async () => {
  const hashC = "c".repeat(64);
  const hashD = "d".repeat(64);
  const generationTwo = "generation_0005_xxxxxxxxxxxxxxxxxxxxxxxx";
  let thread = null;
  let messages = [];
  let turn = 0;
  const preparedCursors = [];
  const starts = [];
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_two_turn_xxxxx" });
    },
    async createThread(ticket) {
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparedCursors.push([request.expectedRevision, request.expectedHash]);
      const generationId = preparedCursors.length === 1 ? CHAT_GENERATION_ID : generationTwo;
      return Object.freeze({
        ...request,
        generationId,
        idempotencyKey: `run_start_two_turn_${preparedCursors.length}_xxxxxxxx`,
      });
    },
    async startRun(ticket) {
      starts.push(ticket);
      turn += 1;
      if (turn === 1) {
        messages = [chatMessage(1, "user", ticket.content)];
        thread = chatThread({
          title: thread.title,
          revision: 1,
          ledgerHash: CHAT_HASH_A,
          messageCount: 1,
          ledgerBytes: messages[0].contentBytes,
          currentGenerationId: CHAT_GENERATION_ID,
        });
        return { request: ticket, generation: chatGeneration() };
      }
      messages.push(chatMessage(3, "user", ticket.content, {
        previousHash: CHAT_HASH_B,
        messageHash: hashC,
      }));
      thread = chatThread({
        title: thread.title,
        revision: 3,
        ledgerHash: hashC,
        messageCount: 3,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
        currentGenerationId: generationTwo,
      });
      return {
        request: ticket,
        generation: chatGeneration({ generationId: generationTwo }),
      };
    },
    async *streamRunEvents({ generationId, onCursor }) {
      await onCursor({ afterSequence: 1 });
      if (generationId === CHAT_GENERATION_ID) {
        yield { type: "delta", delta: { content: "First answer" }, afterSequence: 1 };
        messages.push(chatMessage(2, "assistant", "First answer"));
        thread = chatThread({
          title: thread.title,
          revision: 2,
          ledgerHash: CHAT_HASH_B,
          messageCount: 2,
          ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
        });
        yield {
          type: "generation",
          generation: chatGeneration({ status: "completed", terminal: true }),
          afterSequence: 1,
        };
        return;
      }
      yield { type: "delta", delta: { content: "Second answer" }, afterSequence: 1 };
      messages.push(chatMessage(4, "assistant", "Second answer", {
        previousHash: hashC,
        messageHash: hashD,
        generationId: generationTwo,
      }));
      thread = chatThread({
        title: thread.title,
        revision: 4,
        ledgerHash: hashD,
        messageCount: 4,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      yield {
        type: "generation",
        generation: chatGeneration({ generationId: generationTwo, status: "completed", terminal: true }),
        afterSequence: 1,
      };
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "First normal turn";
  await browser.app.submitMessage({ preventDefault() {} });
  browser.document.getElementById("message-input").value = "Second normal turn";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.deepEqual(preparedCursors, [[0, null], [2, CHAT_HASH_B]]);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].content, "First normal turn");
  assert.equal(starts[1].content, "Second normal turn");
  assert.equal(thread.revision, 4);
  assert.match(browser.document.getElementById("messages").textContent, /First normal turnFirst answerSecond normal turnSecond answer/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("PWA image control canonicalizes exactly one file, sends it once, and renders only authenticated previews", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const imagePrompt = "Describe the private image.\nFocus\ton its colors.";
  const descriptor = {
    attachmentId: "image_0000000000000001",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 192,
    height: 192,
    sha256: "c".repeat(64),
  };
  let thread = null;
  let messages = [];
  let preparedRun;
  let canonicalizations = 0;
  let previewReads = 0;
  let readsBeforeRunDispatch = 0;
  let runDispatchStarted = false;
  const createdUrls = [];
  const revokedUrls = [];
  const chat = baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    prepareThread({ title }) {
      assert.equal(title, "Describe the private image. Focus on its colors.");
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_image_xxxxxxxxx" });
    },
    async createThread(ticket) {
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() {
      if (!runDispatchStarted) readsBeforeRunDispatch += 1;
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      if (!runDispatchStarted) readsBeforeRunDispatch += 1;
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparedRun = request;
      return Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_start_image_xxxxxxxxxxxx",
      });
    },
    async startRun(ticket) {
      runDispatchStarted = true;
      messages = [
        chatMessage(1, "user", ticket.content, { attachment: descriptor }),
        chatMessage(2, "assistant", "Authenticated vision answer"),
      ];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return {
        request: ticket,
        generation: chatGeneration({ status: "completed", terminal: true }),
      };
    },
    async getAttachment({ threadId, attachment }) {
      previewReads += 1;
      assert.equal(threadId, CHAT_THREAD_ID);
      assert.deepEqual(attachment, descriptor);
      return { descriptor, bytes };
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage(selectedFile, options) {
      canonicalizations += 1;
      assert.equal(selectedFile.name, "private.png");
      assert.equal(typeof options.makeAttachmentId, "function");
      return Object.freeze({
        attachmentId: descriptor.attachmentId,
        mediaType: descriptor.mediaType,
        byteLength: descriptor.byteLength,
        width: descriptor.width,
        height: descriptor.height,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() {
      const value = `blob:vision-${createdUrls.length + 1}`;
      createdUrls.push(value);
      return value;
    },
    revokeObjectUrl(value) { revokedUrls.push(value); },
  });
  await browser.app.initialize();
  const input = browser.document.getElementById("image-input");
  const add = browser.document.getElementById("add-image");
  assert.equal(add.hidden, false);

  input.files = [{ name: "one.png" }, { name: "two.png" }];
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canonicalizations, 0);
  assert.match(browser.document.getElementById("toast").textContent, /exactly one/u);

  input.files = [{ name: "private.png" }];
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canonicalizations, 1);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:vision-1");

  browser.document.getElementById("message-input").value = imagePrompt;
  await browser.app.submitMessage({ preventDefault() {} });
  await Promise.resolve();
  assert.equal(preparedRun.content, imagePrompt, "normal multiline formatting reaches the durable image run unchanged");
  assert.deepEqual(preparedRun.attachment, {
    attachmentId: descriptor.attachmentId,
    mediaType: descriptor.mediaType,
    byteLength: descriptor.byteLength,
    width: descriptor.width,
    height: descriptor.height,
    bytes,
  });
  assert.equal(readsBeforeRunDispatch, 0, "a confirmed new thread needs no fallible snapshot read before its first run");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.ok(revokedUrls.includes("blob:vision-1"), "the local selection preview is revoked after dispatch");
  assert.ok(previewReads >= 1, "rendering retrieves bytes through the authenticated attachment client");
  assert.match(browser.document.getElementById("messages").textContent, /Describe the private image\.\s+Focus\s+on its colors\.Authenticated vision answer/u);
  assert.ok(createdUrls.length >= 2, "a server-returned private preview gets a distinct object URL");
});

test("a local image-run preparation failure cannot create an empty thread and restores the exact draft", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const prompt = `${"a".repeat(79)}😀 private image`;
  const draft = `  ${prompt}\n  `;
  const safeTitle = `${"a".repeat(79)}😀`;
  let thread = null;
  let messages = [];
  let preparationCalls = 0;
  let createCalls = 0;
  let preparedRun = null;
  let objectUrlCalls = 0;
  const revokedUrls = [];
  const chat = baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    prepareThread({ title }) {
      assert.equal(title, safeTitle, "the generated title ends on a complete Unicode scalar");
      return Object.freeze({
        threadId: CHAT_THREAD_ID,
        title,
        idempotencyKey: "thread_create_image_retry_xxxxxx",
      });
    },
    async createThread(ticket) {
      createCalls += 1;
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparationCalls += 1;
      if (preparationCalls === 1) throw new TypeError("synthetic local run-ticket failure");
      preparedRun = request;
      return Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_start_image_retry_xxxxxxxxx",
      });
    },
    async startRun(ticket) {
      messages = [
        chatMessage(1, "user", ticket.content),
        chatMessage(2, "assistant", "Retried safely"),
      ];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return {
        request: ticket,
        generation: chatGeneration({ status: "completed", terminal: true }),
      };
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000004",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 64,
        height: 64,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() {
      objectUrlCalls += 1;
      return objectUrlCalls === 1 ? "blob:retry-image" : "blob:dispatched-image";
    },
    revokeObjectUrl(value) { revokedUrls.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "retry.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createCalls, 0, "a synchronous preparation failure cannot create a durable thread");
  assert.equal(messageInput.value, draft, "local failure restores the exact pre-trim textarea draft");
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:retry-image");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("toast").textContent, /image message was not sent[\s\S]*still ready/iu);
  assert.deepEqual(revokedUrls, [], "the restored preview keeps its original live object URL");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createCalls, 1);
  assert.equal(preparedRun.content, prompt, "retry preserves the original prompt exactly");
  assert.equal(preparedRun.attachment.attachmentId, "image_0000000000000004");
  assert.equal(preparedRun.attachment.bytes, bytes, "retry preserves the canonical private image bytes");
  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.deepEqual([...revokedUrls].sort(), ["blob:dispatched-image", "blob:retry-image"]);
  assert.match(browser.document.getElementById("messages").textContent, /Retried safely/u);
});

test("an existing-thread snapshot outage restores the exact image draft before any run dispatch", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const draft = "  Describe this image.\nKeep the exact spacing.  ";
  const thread = chatThread();
  let failReads = false;
  let prepareRuns = 0;
  let startRuns = 0;
  const revokedUrls = [];
  const chat = baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (failReads) throw Object.assign(new Error("snapshot offline"), { retryable: true });
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      prepareRuns += 1;
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_snapshot_xxxxxxxxx" });
    },
    async startRun() {
      startRuns += 1;
      throw new Error("unexpected run dispatch");
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000005",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 72,
        height: 72,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:snapshot-retry-image"; },
    revokeObjectUrl(value) { revokedUrls.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "snapshot-retry.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;
  failReads = true;

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(prepareRuns, 0);
  assert.equal(startRuns, 0);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:snapshot-retry-image");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.match(browser.document.getElementById("toast").textContent, /not sent[\s\S]*still ready/iu);
  assert.deepEqual(revokedUrls, []);
});

test("an authoritative run rejection releases its ticket and restores the exact composer draft", async () => {
  const thread = chatThread();
  const draft = "  Retry after the other tab finishes.\nKeep this spacing.  ";
  let starts = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_conflict_xxxxxxxxx" });
    },
    async startRun() {
      starts += 1;
      throw new DirectChatTransportError("not accepted", {
        code: "conflict",
        status: 409,
        retryable: false,
      });
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  const messageInput = browser.document.getElementById("message-input");
  messageInput.value = draft;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(starts, 1);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);
  assert.equal(browser.document.getElementById("connection-state").textContent, "Request not sent");
  assert.match(browser.document.getElementById("toast").textContent, /not sent[\s\S]*composer/iu);
});

test("an ambiguous new-thread commit keeps the exact image draft visible and resumes the same tickets", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const draft = "  Describe the committed image.\nDo not duplicate it.  ";
  const prompt = draft.trim();
  let thread = null;
  let messages = [];
  let createRetries = 0;
  let runStarts = 0;
  let preparedRun = null;
  let objectUrls = 0;
  const createTickets = [];
  const revokedUrls = [];
  const chat = baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_ambiguous_xxxxx" });
    },
    async createThread(ticket) {
      createTickets.push(ticket);
      thread = chatThread({ title: ticket.title });
      throw Object.assign(new Error("committed response lost"), { retryable: true });
    },
    async retryCreateThread(ticket) {
      createTickets.push(ticket);
      createRetries += 1;
      if (createRetries === 1) throw Object.assign(new Error("confirmation still offline"), { retryable: true });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparedRun = Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_start_ambiguous_xxxxxxxxx",
      });
      return preparedRun;
    },
    async startRun(ticket) {
      runStarts += 1;
      messages = [
        chatMessage(1, "user", ticket.content),
        chatMessage(2, "assistant", "Exactly once"),
      ];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return {
        request: ticket,
        generation: chatGeneration({ status: "completed", terminal: true }),
      };
    },
  });
  const browser = harness({
    chat,
    async logout() { throw new Error("sign-out response unavailable"); },
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000006",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() {
      objectUrls += 1;
      return `blob:ambiguous-${objectUrls}`;
    },
    revokeObjectUrl(value) { revokedUrls.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "ambiguous.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createTickets.length, 2);
  assert.equal(createTickets[0], createTickets[1]);
  assert.equal(runStarts, 0);
  assert.equal(preparedRun.content, prompt);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:ambiguous-1");
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("remove-image").disabled, true);
  assert.match(browser.document.getElementById("toast").textContent, /remain visible and locked/iu);
  assert.deepEqual(revokedUrls, []);
  browser.document.getElementById("remove-image").dispatch("click");
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.deepEqual(revokedUrls, [], "a programmatic Remove cannot hide an image still owned by the pending ticket");
  await browser.app.logout();
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.match(browser.document.getElementById("toast").textContent, /Sign-out could not be confirmed/iu);

  await browser.app.resume();
  assert.equal(createTickets.length, 3);
  assert.equal(createTickets.every((ticket) => ticket === createTickets[0]), true);
  assert.equal(runStarts, 1);
  assert.equal(preparedRun.attachment.attachmentId, "image_0000000000000006");
  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.ok(revokedUrls.includes("blob:ambiguous-1"));
  assert.match(browser.document.getElementById("messages").textContent, /Describe the committed image[\s\S]*Exactly once/iu);
});

test("PWA submit blocks and invalidates an image preparation race without consuming the prompt", async () => {
  const pending = Promise.withResolvers();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let thread = null;
  let messages = [];
  let preparedRun = null;
  let objectUrls = 0;
  const chat = baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_race_xxxxxxxxx" });
    },
    async createThread(ticket) {
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparedRun = request;
      return Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_start_race_xxxxxxxxxxxxx",
      });
    },
    async startRun(ticket) {
      messages = [
        chatMessage(1, "user", ticket.content),
        chatMessage(2, "assistant", "Text-only answer"),
      ];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return {
        request: ticket,
        generation: chatGeneration({ status: "completed", terminal: true }),
      };
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage() { return await pending.promise; },
    createObjectUrl() { objectUrls += 1; return `blob:unexpected-${objectUrls}`; },
  });
  await browser.app.initialize();
  const input = browser.document.getElementById("image-input");
  const message = browser.document.getElementById("message-input");
  const send = browser.document.getElementById("send-message");
  input.files = [{ name: "slow-private.png" }];
  input.dispatch("change");
  message.value = "Keep this text-only prompt";
  assert.equal(send.disabled, true, "Send is disabled before canonicalization yields");
  assert.equal(browser.document.getElementById("add-image").disabled, true);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(preparedRun, null, "a programmatic form submission cannot bypass the pending guard");
  assert.equal(message.value, "Keep this text-only prompt", "the blocked submission preserves typed text");
  assert.equal(send.disabled, false, "cancelling the pending selection releases the composer");

  pending.resolve(Object.freeze({
    attachmentId: "image_0000000000000002",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 128,
    height: 128,
    bytes,
    previewBlob: new Blob([bytes], { type: "image/png" }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(objectUrls, 0, "the invalidated completion never receives a preview URL");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(Object.hasOwn(preparedRun, "attachment"), false, "the later prompt cannot inherit the stale private image");
  assert.equal(message.value, "");
  assert.match(browser.document.getElementById("messages").textContent, /Keep this text-only promptText-only answer/u);
});

test("PWA mode, explicit clear, and logout each invalidate unresolved image preparation", async () => {
  const pending = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const selected = Object.freeze({
    attachmentId: "image_0000000000000003",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 96,
    height: 96,
    bytes,
    previewBlob: new Blob([bytes], { type: "image/png" }),
  });
  let canonicalizations = 0;
  let objectUrls = 0;
  const browser = harness({
    agent: baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    chat: baseChat({
      async capabilities() {
        return {
          visionInput: true,
          visionMediaTypes: ["image/jpeg", "image/png"],
          maximumImageBytes: 4 * 1024 * 1024,
        };
      },
    }),
    canonicalizeImage() {
      const deferred = pending[canonicalizations];
      canonicalizations += 1;
      return deferred.promise;
    },
    createObjectUrl() { objectUrls += 1; return `blob:unexpected-${objectUrls}`; },
  });
  await browser.app.initialize();
  browser.app.setMode("chat", { restoreView: false });
  const input = browser.document.getElementById("image-input");
  const send = browser.document.getElementById("send-message");

  input.files = [{ name: "mode-race.png" }];
  input.dispatch("change");
  assert.equal(send.disabled, true);
  browser.app.setMode("agent", { restoreView: false });
  pending[0].resolve(selected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("image-preview").hidden, true);

  browser.app.setMode("chat", { restoreView: false });
  input.files = [{ name: "clear-race.png" }];
  input.dispatch("change");
  assert.equal(send.disabled, true);
  browser.document.getElementById("remove-image").dispatch("click");
  assert.equal(send.disabled, false);
  pending[1].resolve(selected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("image-preview").hidden, true);

  input.files = [{ name: "logout-race.png" }];
  input.dispatch("change");
  assert.equal(send.disabled, true);
  browser.document.getElementById("message-input").value = "private draft for this account only";
  await browser.app.logout();
  assert.equal(browser.document.getElementById("message-input").value, "");
  pending[2].resolve(selected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(objectUrls, 0, "no invalidated preparation can become a selectable preview");
  assert.equal(canonicalizations, 3);
});

test("a confirmed completed run stays completed when its final snapshot is temporarily unavailable", async () => {
  let thread = null;
  let runAccepted = false;
  const completed = chatGeneration({ status: "completed", terminal: true });
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_terminal_xxxxxxxx" });
    },
    async createThread(ticket) {
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() {
      if (runAccepted) throw Object.assign(new Error("snapshot temporarily unavailable"), { retryable: true });
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_terminal_xxxxxxxxx" });
    },
    async startRun(ticket) {
      runAccepted = true;
      return { request: ticket, generation: completed };
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Keep the confirmed result";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(browser.document.getElementById("connection-state").textContent, "Completed · refresh pending");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("toast").textContent, /completed this response/iu);
  assert.doesNotMatch(browser.document.getElementById("toast").textContent, /interrupted/iu);
  assert.match(browser.document.getElementById("messages").textContent, /Keep the confirmed result/u);
});

test("Resume releases an ambiguous run when its exact retry receives an authoritative rejection", async () => {
  const thread = chatThread();
  const draft = "  Original ambiguous prompt.\nRestore it exactly.  ";
  let retryCalls = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_resume_reject_xxxxx" });
    },
    async startRun() {
      throw Object.assign(new Error("response unavailable"), { retryable: true });
    },
    async retryRun() {
      retryCalls += 1;
      if (retryCalls === 1) throw Object.assign(new Error("still unavailable"), { retryable: true });
      throw new DirectChatTransportError("not accepted", {
        code: "conflict",
        status: 409,
        retryable: false,
      });
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  const messageInput = browser.document.getElementById("message-input");
  messageInput.value = draft;
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(messageInput.disabled, true);
  assert.equal(messageInput.value, "");

  await browser.app.resume();
  assert.equal(retryCalls, 2);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(messageInput.disabled, false);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);
  assert.equal(browser.document.getElementById("connection-state").textContent, "Request not sent");
  assert.match(browser.document.getElementById("toast").textContent, /rejected before it ran/iu);
});

test("confirmed logout discards an ambiguous browser ticket without requiring Resume", async () => {
  const draft = "  Private pending prompt.\nDo not carry accounts.  ";
  let createCalls = 0;
  let runStarts = 0;
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_logout_pending_x" });
    },
    async createThread() {
      createCalls += 1;
      throw Object.assign(new Error("response unavailable"), { retryable: true });
    },
    async retryCreateThread() {
      createCalls += 1;
      throw Object.assign(new Error("still unavailable"), { retryable: true });
    },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_logout_pending_xxxxx" });
    },
    async startRun() {
      runStarts += 1;
      throw new Error("unexpected run dispatch");
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  const messageInput = browser.document.getElementById("message-input");
  messageInput.value = draft;
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createCalls, 2);
  assert.equal(runStarts, 0);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);

  await browser.app.logout();
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("app-view").hidden, true);
  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  await browser.app.resume();
  assert.equal(createCalls, 2);
  assert.equal(runStarts, 0);
});

test("an in-flight submit cannot restore private composer state after confirmed logout", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const thread = chatThread();
  const readStarted = Promise.withResolvers();
  const readGate = Promise.withResolvers();
  let holdRead = false;
  let held = false;
  let prepareRuns = 0;
  let objectUrls = 0;
  const revokedUrls = [];
  const chat = baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (holdRead && !held) {
        held = true;
        readStarted.resolve();
        return await readGate.promise;
      }
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      prepareRuns += 1;
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_owner_fence_xxxxxxx" });
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000007",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 88,
        height: 88,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() {
      objectUrls += 1;
      return `blob:owner-fence-${objectUrls}`;
    },
    revokeObjectUrl(value) { revokedUrls.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "owner-fence.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = "private in-flight image prompt";
  holdRead = true;

  const submission = browser.app.submitMessage({ preventDefault() {} });
  await readStarted.promise;
  await browser.app.logout();
  assert.equal(messageInput.value, "");
  readGate.resolve({ thread });
  await submission;

  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("app-view").hidden, true);
  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(prepareRuns, 0);
  assert.equal(objectUrls, 1, "the signed-out completion cannot recreate a private preview URL");
  assert.deepEqual(revokedUrls, ["blob:owner-fence-1"]);
});

test("Resume fences an ambiguous Direct Chat ticket without consuming later composer work or navigation", async () => {
  let thread = chatThread();
  let messages = [];
  let prepared;
  const dispatched = [];
  let retryCalls = 0;
  const completed = chatGeneration({ status: "completed", terminal: true });
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      prepared = Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_resume_xxxxxxxxxxxxx" });
      return prepared;
    },
    async startRun(ticket) {
      dispatched.push(ticket);
      messages = [chatMessage(1, "user", ticket.content), chatMessage(2, "assistant", "Already completed")];
      thread = chatThread({
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: 32,
      });
      throw Object.assign(new Error("response lost"), { retryable: true });
    },
    async retryRun(ticket) {
      dispatched.push(ticket);
      retryCalls += 1;
      if (retryCalls === 1) throw Object.assign(new Error("still offline"), { retryable: true });
      return { request: ticket, generation: completed };
    },
  });
  const browser = harness({
    chat,
    agent: baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
  });
  await browser.app.initialize();
  browser.app.setMode("chat");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  browser.document.getElementById("message-input").value = "Ambiguous dispatch";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, true);
  browser.document.getElementById("message-input").value = "Do not consume this later draft";
  const dispatchesBeforeBlockedSubmit = dispatched.length;
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(dispatched.length, dispatchesBeforeBlockedSubmit, "a second submit cannot replace the ambiguous ticket");
  assert.equal(browser.document.getElementById("message-input").value, "Do not consume this later draft");
  assert.match(browser.document.getElementById("toast").textContent, /awaiting confirmation/iu);
  browser.app.setMode("agent");
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  assert.match(browser.document.getElementById("toast").textContent, /Resume before changing modes/iu);
  await browser.app.resume();
  assert.equal(dispatched.length, 3);
  assert.equal(dispatched.every((ticket) => ticket === prepared), true);
  assert.equal(browser.document.getElementById("message-input").value, "Do not consume this later draft");
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);
  assert.match(browser.document.getElementById("messages").textContent, /Already completed/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Stop uses the explicit durable cancellation mutation; detaching its SSE alone never cancels", async () => {
  let thread = null;
  let messages = [];
  let generation = chatGeneration();
  let streamReady;
  const streamStarted = new Promise((resolve) => { streamReady = resolve; });
  const firstDelta = Promise.withResolvers();
  let runAccepted = false;
  let streamEntered = false;
  let postAcceptanceReadsBeforeStream = 0;
  const cancellations = [];
  const chat = baseChat({
    prepareThread({ title }) { return Object.freeze({ threadId: CHAT_THREAD_ID, title }); },
    async createThread(ticket) {
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() {
      if (runAccepted && !streamEntered) postAcceptanceReadsBeforeStream += 1;
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      if (runAccepted && !streamEntered) postAcceptanceReadsBeforeStream += 1;
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) { return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID }); },
    async startRun(ticket) {
      runAccepted = true;
      messages = [chatMessage(1, "user", ticket.content)];
      thread = chatThread({
        title: thread.title,
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: ticket.content.length,
        currentGenerationId: CHAT_GENERATION_ID,
      });
      return { request: ticket, generation };
    },
    async *streamRunEvents({ signal, onCursor }) {
      streamEntered = true;
      streamReady();
      await firstDelta.promise;
      await onCursor({ afterSequence: 1 });
      yield { type: "delta", delta: { content: "partial" }, afterSequence: 1 };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    prepareCancellation(request) { return Object.freeze({ ...request, idempotencyKey: "cancel_xxxxxxxxxxxxxxxxxxxxxxxx" }); },
    async cancelRun(ticket) {
      cancellations.push(ticket);
      generation = chatGeneration({ status: "cancelled", terminal: true });
      thread = chatThread({
        title: thread.title,
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: messages[0].contentBytes,
      });
      return { request: ticket, generation };
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Cancel me";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await streamStarted;
  assert.equal(postAcceptanceReadsBeforeStream, 0, "streaming starts immediately after run acceptance without a snapshot gate");
  assert.equal(browser.document.getElementById("run-state").textContent, "Warming LocalLLM");
  firstDelta.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("run-state").textContent, "Generating");
  assert.equal(cancellations.length, 0, "streaming or disconnect setup is not cancellation");
  await browser.app.stop();
  await submission;
  assert.equal(cancellations.length, 1);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "cancelled");
  assert.equal(browser.document.getElementById("run-state").textContent, "Cancelled");
});

test("clean nonterminal EOF status-probes and reconnects from the last verified cursor without restarting", async () => {
  const first = await verifiedEvent({ seq: 1, type: "output.delta", payload: { text: "Working" }, previousHash: ZERO_HASH });
  const second = await verifiedEvent({ seq: 2, type: "run.completed", payload: {}, previousHash: first.hash });
  const streamCursors = [];
  let streams = 0;
  let statuses = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Plot values" } }; },
    async startRun() { starts += 1; return { run: run() }; },
    async runStatus() { statuses += 1; return { run: run() }; },
    async resumeRun() { resumes += 1; return { run: run() }; },
    async *streamRunEvents(options) {
      streamCursors.push(options.cursor);
      streams += 1;
      if (streams === 1) yield { event: first, cursor: { seq: 1, hash: first.hash } };
      else yield { event: second, cursor: { seq: 2, hash: second.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Plot values";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(streams, 2);
  assert.equal(statuses, 1);
  assert.equal(starts, 1);
  assert.equal(resumes, 0);
  assert.deepEqual(streamCursors.map((value) => value.seq), [0, 1]);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.match(browser.document.getElementById("messages").textContent, /Working/u);
});

test("bounded native stream rotations keep reconnecting until AgInTi is terminal", async () => {
  const terminal = await verifiedEvent({ seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH });
  let streams = 0;
  let statuses = 0;
  let starts = 0;
  const waits = [];
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Long calculation" } }; },
    async startRun() { starts += 1; return { run: run() }; },
    async runStatus() { statuses += 1; return { run: run() }; },
    async *streamRunEvents() {
      streams += 1;
      if (streams === 8) yield { event: terminal, cursor: { seq: 1, hash: terminal.hash } };
    },
  };
  const browser = harness({
    agent,
    maxStreamBackoffSteps: 2,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Long calculation";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(streams, 8);
  assert.equal(statuses, 7);
  assert.equal(starts, 1);
  assert.deepEqual(waits, [250, 500, 1_000, 1_000, 1_000, 1_000, 1_000]);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("retryable outage recovers through status probe and cursor replay without start/resume duplication", async () => {
  const first = await verifiedEvent({ seq: 1, type: "output.delta", payload: { text: "Recovered" }, previousHash: ZERO_HASH });
  const second = await verifiedEvent({ seq: 2, type: "run.completed", payload: {}, previousHash: first.hash });
  let streams = 0;
  let statuses = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Recover" } }; },
    async startRun() { starts += 1; return { run: run() }; },
    async runStatus() { statuses += 1; return { run: run() }; },
    async resumeRun() { resumes += 1; return { run: run() }; },
    async *streamRunEvents() {
      streams += 1;
      if (streams === 1) throw Object.assign(new Error("offline"), { retryable: true });
      yield { event: first, cursor: { seq: 1, hash: first.hash } };
      yield { event: second, cursor: { seq: 2, hash: second.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Recover";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(streams, 2);
  assert.equal(statuses, 1);
  assert.equal(starts, 1);
  assert.equal(resumes, 0);
  assert.match(browser.document.getElementById("messages").textContent, /Recovered/u);
});

test("login errors distinguish credentials from busy/unavailable without leaking details", async () => {
  async function messageFor(error) {
    const browser = harness({
      restore: { authenticated: false },
      login: async () => { throw error; },
    });
    await browser.app.initialize();
    browser.document.getElementById("username").value = "account-user";
    browser.document.getElementById("password").value = "not-retained";
    await browser.app.login({ preventDefault() {} });
    assert.equal(browser.document.getElementById("password").value, "");
    return browser.document.getElementById("login-error").textContent;
  }
  const unauthorized = await messageFor({ status: 401, message: "account exists" });
  const forbidden = await messageFor({ status: 403, message: "account missing" });
  assert.equal(unauthorized, forbidden);
  assert.doesNotMatch(unauthorized, /exists|missing|401|403/u);
  assert.match(await messageFor({ status: 429, message: "rate limiter internals" }), /temporarily busy/u);
  assert.match(await messageFor({ status: 503, message: "upstream address" }), /unavailable/u);
  assert.match(await messageFor(new TypeError("network host secret")), /unavailable/u);
});

test("Credential Management save runs only for a successful remembered login", async () => {
  async function attempt(remember) {
    let saves = 0;
    const browser = harness({
      restore: { authenticated: false },
      login: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
      credentialSaver: async () => { saves += 1; return true; },
    });
    await browser.app.initialize();
    browser.document.getElementById("username").value = "account-user";
    browser.document.getElementById("password").value = "password-not-stored";
    browser.document.getElementById("remember-session").checked = remember;
    await browser.app.login({ preventDefault() {} });
    assert.equal(browser.document.getElementById("password").value, "");
    return saves;
  }
  assert.equal(await attempt(true), 1);
  assert.equal(await attempt(false), 0);
});

test("browser integration has no legacy direct endpoint or browser-owned chat persistence", async () => {
  const source = await readFile(new URL("../src/web/browser-app.js", import.meta.url), "utf8");
  assert.match(source, /DirectChatBrowserClient/u);
  assert.match(source, /CloudSessionClient/u);
  assert.doesNotMatch(source, /DirectLocalLlmClient|\/v1\/chat\/completions/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u);
});
