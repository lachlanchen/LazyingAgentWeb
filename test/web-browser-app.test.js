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
  constructor({ decodeImage = async () => {} } = {}) {
    this.documentElement = new Node("html");
    this.decodeImage = decodeImage;
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
  createElement(name) {
    const node = new Node(name);
    if (name === "img") node.decode = () => this.decodeImage(node);
    return node;
  }
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

function terminalVisionChat({ bytes, descriptor, onAttachment = () => {} }) {
  let thread = null;
  let messages = [];
  return baseChat({
    async capabilities() {
      return {
        visionInput: true,
        visionMediaTypes: ["image/jpeg", "image/png"],
        maximumImageBytes: 4 * 1024 * 1024,
      };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_finalize_image_x" });
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
      return Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_start_finalize_image_xxxxx",
      });
    },
    async startRun(ticket) {
      messages = [
        chatMessage(1, "user", ticket.content, { attachment: descriptor }),
        chatMessage(2, "assistant", "Vision final answer"),
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
    async getAttachment(value) {
      onAttachment(value);
      return { descriptor, bytes };
    },
  });
}

function harness({
  restore = { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" },
  login,
  logout,
  agent = baseAgent(),
  chat,
  credentialSaver = async () => false,
  canonicalizeImage,
  decodeImage,
  createObjectUrl,
  revokeObjectUrl,
  attachmentDecodeTimeoutMs,
  attachmentMemoryLimitBytes,
  attachmentDecodedMemoryLimitBytes,
  IntersectionObserver,
  wait = async () => {},
  maxStreamBackoffSteps = 5,
} = {}) {
  const document = new Document({ ...(decodeImage === undefined ? {} : { decodeImage }) });
  const windowListeners = new Map();
  const window = {
    location: { protocol: "http:", reload() {} },
    setTimeout() {},
    addEventListener(name, listener) {
      const current = windowListeners.get(name) ?? [];
      current.push(listener);
      windowListeners.set(name, current);
    },
    dispatch(name, event = {}) {
      for (const listener of windowListeners.get(name) ?? []) listener(event);
    },
  };
  if (IntersectionObserver !== undefined) window.IntersectionObserver = IntersectionObserver;
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
    ...(attachmentDecodeTimeoutMs === undefined ? {} : { attachmentDecodeTimeoutMs }),
    ...(attachmentMemoryLimitBytes === undefined ? {} : { attachmentMemoryLimitBytes }),
    ...(attachmentDecodedMemoryLimitBytes === undefined ? {} : { attachmentDecodedMemoryLimitBytes }),
    wait,
    maxStreamBackoffSteps,
  });
  return { app, document, sessionClient, window };
}

function intersectionHarness() {
  const instances = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = new Set();
      instances.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    enter(target) {
      assert.equal(this.targets.has(target), true, "only an observed attachment can enter the viewport");
      this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    }
  }
  return {
    IntersectionObserver: FakeIntersectionObserver,
    instances,
    latest() { return instances.at(-1); },
  };
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
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

test("chat startup overlaps capabilities with one thread list and overlaps the first verified ledger page", async () => {
  const agentCapabilityGate = Promise.withResolvers();
  const chatCapabilityGate = Promise.withResolvers();
  const threadReadGate = Promise.withResolvers();
  const messageReadGate = Promise.withResolvers();
  const listStarted = Promise.withResolvers();
  const threadStarted = Promise.withResolvers();
  const messagesStarted = Promise.withResolvers();
  const thread = chatThread({ revision: 2, ledgerHash: CHAT_HASH_B, messageCount: 2, ledgerBytes: 18 });
  const messages = [chatMessage(1, "user", "Question"), chatMessage(2, "assistant", "Answer")];
  let listCalls = 0;
  let threadReads = 0;
  const browser = harness({
    agent: {
      ...baseAgent(),
      async capabilities() { return await agentCapabilityGate.promise; },
    },
    chat: baseChat({
      async capabilities() { return await chatCapabilityGate.promise; },
      async listThreads() {
        listCalls += 1;
        listStarted.resolve();
        return { threads: [thread] };
      },
      async getThread() {
        threadReads += 1;
        if (threadReads === 1) {
          threadStarted.resolve();
          return await threadReadGate.promise;
        }
        return { thread };
      },
      async listMessages({ afterRevision, limit }) {
        assert.equal(afterRevision, 0);
        assert.equal(limit, 2);
        messagesStarted.resolve();
        return await messageReadGate.promise;
      },
    }),
  });
  const initializing = browser.app.initialize();
  await listStarted.promise;
  assert.equal(listCalls, 1, "the thread list starts while capability hydration is still pending");
  chatCapabilityGate.resolve({ visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 });
  agentCapabilityGate.resolve(capabilities());
  await Promise.all([threadStarted.promise, messagesStarted.promise]);
  threadReadGate.resolve({ thread });
  messageReadGate.resolve({ messages });
  await initializing;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 1, "the prefetched startup list is consumed without a duplicate sidebar refresh");
  assert.equal(threadReads, 2, "the before/after authoritative thread proof remains intact");
  assert.match(browser.document.getElementById("messages").textContent, /QuestionAnswer/u);
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

test("accepted generation stream authentication expiry shows sign-in and reconnects the exact run read-only", async () => {
  let thread = null;
  let messages = [];
  let generation = chatGeneration();
  let creates = 0;
  let starts = 0;
  let runRetries = 0;
  let streams = 0;
  let statuses = 0;
  const streamPaused = Promise.withResolvers();
  const releaseExpiredStream = Promise.withResolvers();
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_stream_reauth_x" });
    },
    async createThread(ticket) {
      creates += 1;
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async retryCreateThread() { throw new Error("thread retry must not run"); },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_stream_reauth_xxxxx" });
    },
    async startRun(ticket) {
      starts += 1;
      messages = [chatMessage(1, "user", ticket.content)];
      thread = chatThread({
        title: thread.title,
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: messages[0].contentBytes,
        currentGenerationId: CHAT_GENERATION_ID,
      });
      return { request: ticket, generation };
    },
    async retryRun() { runRetries += 1; throw new Error("run retry must not run"); },
    async getRunStatus({ threadId, generationId }) {
      statuses += 1;
      assert.equal(threadId, CHAT_THREAD_ID);
      assert.equal(generationId, CHAT_GENERATION_ID);
      return { generation };
    },
    async *streamRunEvents({ afterSequence, onCursor }) {
      streams += 1;
      if (streams === 1) {
        assert.equal(afterSequence, 0);
        await onCursor({ afterSequence: 1 });
        yield { type: "delta", delta: { content: "Part" }, afterSequence: 1 };
        streamPaused.resolve();
        await releaseExpiredStream.promise;
        throw new DirectChatTransportError("session expired during stream", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      assert.equal(afterSequence, 1, "same-account recovery resumes from the last verified cursor");
      await onCursor({ afterSequence: 2 });
      yield { type: "delta", delta: { content: "ial" }, afterSequence: 2 };
      messages = [messages[0], chatMessage(2, "assistant", "Partial")];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      generation = chatGeneration({ status: "completed", terminal: true });
      yield { type: "generation", generation, afterSequence: 2 };
    },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "stream-recovery-csrf-token" }),
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Start one durable generation";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await streamPaused.promise;
  browser.document.getElementById("message-input").value = "Keep this browser-only follow-up draft";
  releaseExpiredStream.resolve();
  await submission;

  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("app-view").hidden, true);
  assert.match(browser.document.getElementById("login-error").textContent, /session expired/iu);
  assert.equal(browser.document.getElementById("message-input").value, "Keep this browser-only follow-up draft");
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(runRetries, 0);

  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(browser.document.getElementById("message-input").value, "Keep this browser-only follow-up draft");
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(runRetries, 0);
  assert.equal(streams, 2);
  assert.equal(statuses, 1);
  assert.match(browser.document.getElementById("messages").textContent, /Start one durable generationPartial/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("a different account cannot inherit an expired stream cursor, output, thread, or browser-only draft", async () => {
  let thread = null;
  let messages = [];
  let switchedAccount = false;
  let creates = 0;
  let starts = 0;
  let streams = 0;
  let statusReads = 0;
  let oldThreadReadsAfterSwitch = 0;
  const streamPaused = Promise.withResolvers();
  const releaseExpiredStream = Promise.withResolvers();
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_cross_stream_x" });
    },
    async createThread(ticket) {
      creates += 1;
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: switchedAccount ? [] : (thread ? [thread] : []) }; },
    async getThread() {
      if (switchedAccount) oldThreadReadsAfterSwitch += 1;
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_cross_stream_xxxxx" });
    },
    async startRun(ticket) {
      starts += 1;
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
    },
    async getRunStatus() { statusReads += 1; return { generation: chatGeneration() }; },
    async *streamRunEvents({ onCursor }) {
      streams += 1;
      await onCursor({ afterSequence: 1 });
      yield { type: "delta", delta: { content: "private partial output" }, afterSequence: 1 };
      streamPaused.resolve();
      await releaseExpiredStream.promise;
      throw new DirectChatTransportError("session expired during stream", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    },
  });
  const browser = harness({
    chat,
    login: async () => {
      switchedAccount = true;
      return { authenticated: true, username: "different-account", csrfToken: "different-account-csrf-token" };
    },
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "old account generation prompt";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await streamPaused.promise;
  browser.document.getElementById("message-input").value = "old account browser-only draft";
  releaseExpiredStream.resolve();
  await submission;

  browser.document.getElementById("username").value = "different-account";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(browser.document.getElementById("message-input").value, "");
  assert.doesNotMatch(browser.document.getElementById("messages").textContent, /old account|private partial/iu);
  assert.equal(browser.document.getElementById("thread-list").children.length, 0);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(oldThreadReadsAfterSwitch, 0);
  assert.equal(statusReads, 0);
  assert.equal(streams, 1);
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.match(browser.document.getElementById("toast").textContent, /previous account/iu);
});

test("completed generation finalization authentication expiry signs in and restores without replaying mutations", async () => {
  let thread = null;
  let messages = [];
  const generation = chatGeneration({ status: "completed", terminal: true });
  let finalizationExpired = false;
  let postLoginSnapshotFailures = 0;
  let creates = 0;
  let starts = 0;
  let runRetries = 0;
  let statuses = 0;
  let threadReads = 0;
  const chat = baseChat({
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_finalize_reauth_x" });
    },
    async createThread(ticket) {
      creates += 1;
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async retryCreateThread() { throw new Error("thread retry must not run"); },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() {
      threadReads += 1;
      if (finalizationExpired) throw new DirectChatTransportError("csrf expired during finalization", {
        code: "csrf_rejected",
        status: 403,
        retryable: false,
      });
      if (postLoginSnapshotFailures > 0) {
        postLoginSnapshotFailures -= 1;
        throw new DirectChatTransportError("temporary snapshot outage after sign-in", {
          code: "request_failed",
          status: 503,
          retryable: true,
        });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_finalize_reauth_xxx" });
    },
    async startRun(ticket) {
      starts += 1;
      messages = [chatMessage(1, "user", ticket.content), chatMessage(2, "assistant", "Final answer")];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      finalizationExpired = true;
      return { request: ticket, generation };
    },
    async retryRun() { runRetries += 1; throw new Error("run retry must not run"); },
    async getRunStatus({ threadId, generationId }) {
      statuses += 1;
      assert.equal(threadId, CHAT_THREAD_ID);
      assert.equal(generationId, CHAT_GENERATION_ID);
      return { generation };
    },
  });
  const browser = harness({
    chat,
    agent: baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "finalize-recovery-csrf-token" }),
  });
  await browser.app.initialize();
  browser.app.setMode("chat");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Complete exactly once";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("app-view").hidden, true);
  assert.match(browser.document.getElementById("login-error").textContent, /server-owned generation/iu);
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(runRetries, 0);

  finalizationExpired = false;
  postLoginSnapshotFailures = 3;
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(runRetries, 0);
  assert.equal(statuses, 0, "a transient post-login snapshot outage cannot fall through to status or mutation replay");
  assert.equal(browser.document.getElementById("resume-run").hidden, false);

  const readsBeforeBlockedActions = threadReads;
  const titleBeforeBlockedActions = browser.document.getElementById("conversation-title").textContent;
  const laterDraft = "Keep this later draft while recovery is locked";
  browser.document.getElementById("message-input").value = laterDraft;
  assert.equal(browser.document.getElementById("new-thread").disabled, true);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("agent-mode").disabled, true);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, true);
  browser.document.getElementById("new-thread").dispatch("click");
  await browser.app.openThread(CHAT_THREAD_ID, { mode: "chat" });
  browser.app.setMode("agent");
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(browser.document.getElementById("conversation-title").textContent, titleBeforeBlockedActions);
  assert.equal(browser.document.getElementById("message-input").value, laterDraft);
  assert.equal(threadReads, readsBeforeBlockedActions, "locked navigation cannot read or replace the recovered thread");
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(runRetries, 0);
  assert.equal(statuses, 0);

  await browser.app.resume();

  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(runRetries, 0);
  assert.equal(statuses, 1);
  assert.equal(browser.document.getElementById("message-input").value, laterDraft);
  assert.match(browser.document.getElementById("messages").textContent, /Complete exactly onceFinal answer/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("new-thread").disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);
});

test("PWA image control bounds selection, sends one image once, and renders only authenticated previews", async () => {
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
  let nativePickerClicks = 0;
  input.click = () => { nativePickerClicks += 1; };
  add.dispatch("click");
  assert.equal(nativePickerClicks, 1, "the visible image action synchronously opens the native picker");

  input.files = [1, 2, 3, 4, 5].map((index) => ({ name: `${index}.png` }));
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canonicalizations, 0);
  assert.match(browser.document.getElementById("toast").textContent, /up to 4/u);

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

test("PWA image control sends an ordered multi-image turn and renders a bounded gallery", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const descriptors = ["first", "second"].map((name, index) => ({
    attachmentId: `image_${name}_0000000000000001`,
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 192 + index,
    height: 192,
    sha256: String(index + 1).repeat(64),
  }));
  let thread = null;
  let messages = [];
  let preparedRun = null;
  const canonicalized = [];
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_multi_image_x" });
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
        idempotencyKey: "run_start_multi_image_xxxxx",
      });
    },
    async startRun(ticket) {
      messages = [
        chatMessage(1, "user", ticket.content, { attachments: descriptors }),
        chatMessage(2, "assistant", "Compared both images"),
      ];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return { request: ticket, generation: chatGeneration({ status: "completed", terminal: true }) };
    },
    async getAttachment({ attachment }) {
      return { descriptor: attachment, bytes };
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage(file) {
      const index = file.name === "first.png" ? 0 : 1;
      canonicalized.push(file.name);
      return Object.freeze({
        ...descriptors[index],
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl: (() => {
      let sequence = 0;
      return () => `blob:multi-${++sequence}`;
    })(),
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const input = browser.document.getElementById("image-input");
  input.files = [{ name: "first.png" }, { name: "second.png" }];
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(canonicalized, ["first.png", "second.png"]);
  assert.match(browser.document.getElementById("image-preview-label").textContent, /2 images/u);
  browser.document.getElementById("message-input").value = "Compare these images in order.";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.deepEqual(
    preparedRun.attachments.map((attachment) => attachment.attachmentId),
    descriptors.map((attachment) => attachment.attachmentId),
  );
  const userMessage = browser.document.getElementById("messages").children[0];
  assert.equal(userMessage.children[0].className, "message-attachments");
  assert.equal(userMessage.children[0].children.length, 2);
});

test("accepted image upload status-probes before retry and releases composer memory before generation ends", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const descriptor = {
    attachmentId: "image_accepted_memory_xxxxxxxxx",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 80,
    height: 80,
    sha256: "e".repeat(64),
  };
  const streamGate = Promise.withResolvers();
  const streamStarted = Promise.withResolvers();
  let thread = chatThread();
  let messages = [];
  let generation = chatGeneration();
  let statusReads = 0;
  let retries = 0;
  const revoked = [];
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ attachment }) { return { bytes, descriptor: attachment }; },
    prepareRun(request) {
      return Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_start_accepted_memory_xxxxx",
      });
    },
    async startRun(ticket) {
      messages = [chatMessage(1, "user", ticket.content, { attachment: descriptor })];
      thread = chatThread({
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: messages[0].contentBytes,
        currentGenerationId: CHAT_GENERATION_ID,
      });
      throw new DirectChatTransportError("accepted response lost", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async getRunStatus() {
      statusReads += 1;
      return { generation };
    },
    async retryRun() {
      retries += 1;
      throw new Error("an accepted image upload must not be uploaded again");
    },
    async *streamRunEvents() {
      streamStarted.resolve();
      await streamGate.promise;
      messages.push(chatMessage(2, "assistant", "Accepted exactly once"));
      thread = chatThread({
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      generation = chatGeneration({ status: "completed", terminal: true });
      yield { type: "generation", generation, afterSequence: 0 };
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage() {
      return Object.freeze({
        ...descriptor,
        bytes,
        previewBlob: new Blob([bytes], { type: descriptor.mediaType }),
      });
    },
    createObjectUrl: (() => { let value = 0; return () => `blob:accepted-memory-${value += 1}`; })(),
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const input = browser.document.getElementById("image-input");
  input.files = [{ name: "accepted.png" }];
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Describe this once";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await streamStarted.promise;
  assert.equal(statusReads, 1);
  assert.equal(retries, 0);
  assert.deepEqual(revoked, ["blob:accepted-memory-1"], "the composer Blob is released before the stream finishes");
  streamGate.resolve();
  await submission;
  assert.match(browser.document.getElementById("messages").textContent, /Accepted exactly once/u);
});

test("Completed becomes usable while its restored attachment decodes in the background", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const descriptor = {
    attachmentId: "image_0000000000000010",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 160,
    height: 90,
    sha256: "d".repeat(64),
  };
  const decodeStarted = Promise.withResolvers();
  const decodeGate = Promise.withResolvers();
  const createdUrls = [];
  const browser = harness({
    chat: terminalVisionChat({ bytes, descriptor }),
    async canonicalizeImage() {
      return Object.freeze({
        ...descriptor,
        bytes,
        previewBlob: new Blob([bytes], { type: descriptor.mediaType }),
      });
    },
    decodeImage(image) {
      decodeStarted.resolve(image);
      return decodeGate.promise;
    },
    createObjectUrl() {
      const url = `blob:decode-gate-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "decode-gate.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Wait for the restored preview";

  const submission = browser.app.submitMessage({ preventDefault() {} });
  const image = await decodeStarted.promise;
  await submission;
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(browser.document.getElementById("workspace").getAttribute("aria-busy"), "false");
  assert.equal(browser.document.getElementById("new-thread").disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);
  assert.equal(image.dataset.previewState, "loading");
  assert.equal(image.hidden, true);
  assert.equal(image.loading, "eager", "an admitted hidden Blob must not deadlock behind native lazy loading");

  decodeGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(image.dataset.previewState, "ready");
  assert.equal(image.hidden, false);
  assert.equal(image.alt, "Attached image");
});

test("a background attachment decode timeout becomes explicit unavailable state without blocking chat", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const descriptor = {
    attachmentId: "image_0000000000000011",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 120,
    height: 120,
    sha256: "e".repeat(64),
  };
  const revokedUrls = [];
  const browser = harness({
    chat: terminalVisionChat({ bytes, descriptor }),
    async canonicalizeImage() {
      return Object.freeze({
        ...descriptor,
        bytes,
        previewBlob: new Blob([bytes], { type: descriptor.mediaType }),
      });
    },
    decodeImage() { return new Promise(() => {}); },
    createObjectUrl() { return `blob:decode-timeout-${revokedUrls.length + 1}`; },
    revokeObjectUrl(url) { revokedUrls.push(url); },
    attachmentDecodeTimeoutMs: 5,
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "decode-timeout.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Bound the restored preview decode";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("workspace").getAttribute("aria-busy"), "false");
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const article = browser.document.getElementById("messages").children[0];
  const [image, status] = article.children;
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("workspace").getAttribute("aria-busy"), "false");
  assert.equal(browser.document.getElementById("new-thread").disabled, false);
  assert.equal(image.dataset.previewState, "unavailable");
  assert.equal(image.hidden, true);
  assert.equal(image.src, "");
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Attached image preview unavailable");
  assert.equal(article.dataset.attachmentState, "unavailable");
  assert.ok(revokedUrls.some((url) => url.startsWith("blob:decode-timeout-")));
});

test("offscreen historical images wait for viewport entry and restore through one verified fetch at a time", async () => {
  const observer = intersectionHarness();
  const hashes = ["1", "2", "3", "4"].map((value) => value.repeat(64));
  const descriptors = [1, 2].map((value) => ({
    attachmentId: `image_viewport_${value}_xxxxxxxx`,
    mediaType: "image/png",
    byteLength: 4,
    width: 80,
    height: 60,
    sha256: String(value).repeat(64),
  }));
  const messages = [
    chatMessage(1, "user", "First image", { messageHash: hashes[0], attachment: descriptors[0] }),
    chatMessage(2, "assistant", "First answer", { previousHash: hashes[0], messageHash: hashes[1] }),
    chatMessage(3, "user", "Second image", {
      previousHash: hashes[1], messageHash: hashes[2], attachment: descriptors[1],
    }),
    chatMessage(4, "assistant", "Second answer", { previousHash: hashes[2], messageHash: hashes[3] }),
  ];
  const thread = chatThread({
    revision: 4,
    ledgerHash: hashes[3],
    messageCount: 4,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const firstFetch = Promise.withResolvers();
  const firstFetchStarted = Promise.withResolvers();
  const secondFetchStarted = Promise.withResolvers();
  const attachmentReads = [];
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ threadId, attachment, signal }) {
      assert.equal(threadId, CHAT_THREAD_ID);
      assert.equal(signal instanceof AbortSignal, true);
      assert.equal(attachment.sha256, descriptors[attachmentReads.length].sha256);
      attachmentReads.push(attachment.attachmentId);
      if (attachmentReads.length === 1) {
        firstFetchStarted.resolve();
        return await firstFetch.promise;
      }
      secondFetchStarted.resolve();
      return { bytes, descriptor: attachment };
    },
  });
  const browser = harness({
    chat,
    IntersectionObserver: observer.IntersectionObserver,
    createObjectUrl: (() => { let value = 0; return () => `blob:viewport-${value += 1}`; })(),
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const observed = [...observer.latest().targets];
  assert.equal(observed.length, 2);
  assert.equal(attachmentReads.length, 0, "offscreen descriptors never trigger original-byte fetches");
  const images = observed.map((article) => article.children[0]);
  assert.deepEqual(images.map((image) => [image.loading, image.decoding, image.dataset.previewState]), [
    ["lazy", "async", "deferred"],
    ["lazy", "async", "deferred"],
  ]);

  observer.latest().enter(observed[0]);
  observer.latest().enter(observed[1]);
  await firstFetchStarted.promise;
  assert.equal(attachmentReads.length, 1, "the second visible original waits behind the bounded queue");
  firstFetch.resolve({ bytes, descriptor: descriptors[0] });
  await secondFetchStarted.promise;
  assert.equal(attachmentReads.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(images.map((image) => image.dataset.previewState), ["ready", "ready"]);
});

test("every image in one historical gallery gets its own viewport restoration job", async () => {
  const observer = intersectionHarness();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const descriptors = [1, 2].map((value) => ({
    attachmentId: `image_gallery_${value}_xxxxxxxxxxx`,
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 2,
    height: 2,
    sha256: String(value).repeat(64),
  }));
  const messages = [
    chatMessage(1, "user", "Compare both stored images", { attachments: descriptors }),
    chatMessage(2, "assistant", "Both were compared"),
  ];
  const thread = chatThread({
    revision: 2,
    ledgerHash: CHAT_HASH_B,
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const attachmentReads = [];
  const browser = harness({
    chat: baseChat({
      async listThreads() { return { threads: [thread] }; },
      async getThread() { return { thread }; },
      async listMessages({ afterRevision, limit }) {
        return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
      },
      async getAttachment({ attachment }) {
        attachmentReads.push(attachment.attachmentId);
        return { bytes, descriptor: attachment };
      },
    }),
    IntersectionObserver: observer.IntersectionObserver,
    createObjectUrl: (() => { let value = 0; return () => `blob:gallery-${value += 1}`; })(),
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const observedItems = [...observer.latest().targets];
  assert.equal(observedItems.length, 2);
  const images = observedItems.map((item) => item.children[0]);
  observer.latest().enter(observedItems[0]);
  observer.latest().enter(observedItems[1]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachmentReads, descriptors.map((attachment) => attachment.attachmentId));
  assert.deepEqual(images.map((image) => image.dataset.previewState), ["ready", "ready"]);
});

async function sameThreadAttachmentMemoryCase({ blobLimit, decodedLimit }) {
  const observer = intersectionHarness();
  const hashes = ["5", "6", "7", "8"].map((value) => value.repeat(64));
  const descriptors = [1, 2].map((value) => ({
    attachmentId: `image_memory_${value}_xxxxxxxxx`,
    mediaType: "image/png",
    byteLength: 4,
    width: 2,
    height: 2,
    sha256: String(value).repeat(64),
  }));
  const messages = [
    chatMessage(1, "user", "First bounded image", { messageHash: hashes[0], attachment: descriptors[0] }),
    chatMessage(2, "assistant", "First bounded answer", { previousHash: hashes[0], messageHash: hashes[1] }),
    chatMessage(3, "user", "Second bounded image", {
      previousHash: hashes[1], messageHash: hashes[2], attachment: descriptors[1],
    }),
    chatMessage(4, "assistant", "Second bounded answer", { previousHash: hashes[2], messageHash: hashes[3] }),
  ];
  const thread = chatThread({
    revision: 4,
    ledgerHash: hashes[3],
    messageCount: 4,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const reads = new Map();
  const revoked = [];
  let nextUrl = 0;
  const browser = harness({
    chat: baseChat({
      async listThreads() { return { threads: [thread] }; },
      async getThread() { return { thread }; },
      async listMessages({ afterRevision, limit }) {
        return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
      },
      async getAttachment({ attachment }) {
        reads.set(attachment.attachmentId, (reads.get(attachment.attachmentId) ?? 0) + 1);
        return { bytes: new Uint8Array([1, 2, 3, 4]), descriptor: attachment };
      },
    }),
    IntersectionObserver: observer.IntersectionObserver,
    attachmentMemoryLimitBytes: blobLimit,
    attachmentDecodedMemoryLimitBytes: decodedLimit,
    createObjectUrl() { return `blob:memory-${nextUrl += 1}`; },
    revokeObjectUrl(url) { revoked.push(url); },
  });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const articles = [...observer.latest().targets];
  assert.equal(articles.length, 2);
  observer.latest().enter(articles[0]);
  observer.latest().enter(articles[1]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { articles, browser, descriptors, reads, revoked };
}

test("same-thread Blob eviction revokes its rendered object URL instead of retaining private bytes", async () => {
  const result = await sameThreadAttachmentMemoryCase({ blobLimit: 5, decodedLimit: 32 });
  const [[firstImage, firstStatus], [secondImage]] = result.articles.map((article) => article.children);
  assert.equal(firstImage.dataset.previewState, "deferred");
  assert.equal(firstImage.src, "");
  assert.equal(firstStatus.disabled, false);
  assert.equal(secondImage.dataset.previewState, "ready");
  assert.deepEqual(result.revoked, ["blob:memory-1"]);

  firstStatus.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.reads.get(result.descriptors[0].attachmentId), 2, "an evicted compressed Blob is fetched again only on demand");
  assert.equal(firstImage.dataset.previewState, "ready");
  assert.equal(secondImage.dataset.previewState, "deferred");
});

test("the decoded-preview LRU revokes old surfaces but can reuse their still-bounded Blob", async () => {
  const result = await sameThreadAttachmentMemoryCase({ blobLimit: 16, decodedLimit: 16 });
  const [[firstImage, firstStatus], [secondImage]] = result.articles.map((article) => article.children);
  assert.equal(firstImage.dataset.previewState, "deferred");
  assert.equal(secondImage.dataset.previewState, "ready");
  assert.deepEqual(result.revoked, ["blob:memory-1"]);

  firstStatus.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.reads.get(result.descriptors[0].attachmentId), 1, "decoded eviction reuses the verified compressed Blob without network I/O");
  assert.equal(firstImage.dataset.previewState, "ready");
  assert.equal(secondImage.dataset.previewState, "deferred");
});

test("repeated failed and cancelled image turns retain at most one local preview when terminal refresh is unavailable", async () => {
  const observer = intersectionHarness();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const previewBlobs = new WeakSet();
  const previewBlobUses = new WeakMap();
  const created = [];
  const revoked = [];
  const statuses = ["failed", "cancelled"];
  const messages = [];
  let thread = chatThread();
  let runIndex = 0;
  let selectionIndex = 0;
  let failTerminalRefresh = false;
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (failTerminalRefresh) {
        failTerminalRefresh = false;
        throw new DirectChatTransportError("terminal refresh unavailable", {
          code: "request_failed",
          status: 503,
          retryable: false,
        });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      return Object.freeze({
        ...request,
        generationId: `generation_memory_${runIndex + 1}_xxxxxxxxxxxx`,
        idempotencyKey: `run_memory_${runIndex + 1}_xxxxxxxxxxxxxxxx`,
      });
    },
    async startRun(ticket) {
      const previousHash = messages.at(-1)?.messageHash ?? null;
      const messageHash = String(runIndex + 1).repeat(64);
      const attachment = Object.freeze({
        attachmentId: ticket.attachment.attachmentId,
        mediaType: ticket.attachment.mediaType,
        byteLength: ticket.attachment.byteLength,
        width: ticket.attachment.width,
        height: ticket.attachment.height,
        sha256: String(runIndex + 3).repeat(64),
      });
      messages.push(chatMessage(messages.length + 1, "user", ticket.content, {
        previousHash,
        messageHash,
        attachment,
      }));
      thread = chatThread({
        revision: messages.length,
        ledgerHash: messageHash,
        messageCount: messages.length,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      const status = statuses[runIndex];
      runIndex += 1;
      failTerminalRefresh = true;
      return {
        request: ticket,
        generation: chatGeneration({
          generationId: ticket.generationId,
          status,
          terminal: true,
        }),
      };
    },
  });
  const browser = harness({
    chat,
    IntersectionObserver: observer.IntersectionObserver,
    async canonicalizeImage() {
      selectionIndex += 1;
      const previewBlob = new Blob([bytes], { type: "image/png" });
      previewBlobs.add(previewBlob);
      return Object.freeze({
        attachmentId: `image_local_memory_${selectionIndex}_xxxxxxxx`,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 2,
        height: 2,
        bytes,
        previewBlob,
      });
    },
    createObjectUrl(blob) {
      const priorUses = previewBlobUses.get(blob) ?? 0;
      if (previewBlobs.has(blob)) previewBlobUses.set(blob, priorUses + 1);
      const kind = previewBlobs.has(blob) ? (priorUses === 0 ? "composer" : "local") : "stored";
      const url = `blob:${kind}-${created.filter((value) => value.startsWith(`blob:${kind}-`)).length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectUrl(url) { revoked.push(url); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  for (let turn = 0; turn < 2; turn += 1) {
    imageInput.files = [{ name: `terminal-${turn}.png` }];
    imageInput.dispatch("change");
    await new Promise((resolve) => setImmediate(resolve));
    messageInput.value = `Terminal image ${turn}`;
    await browser.app.submitMessage({ preventDefault() {} });
  }

  const localUrls = created.filter((url) => url.startsWith("blob:local-"));
  assert.deepEqual(localUrls, ["blob:local-1", "blob:local-2"]);
  assert.deepEqual(localUrls.filter((url) => !revoked.includes(url)), ["blob:local-2"], "the pre-send snapshot revokes the prior failed local preview");
  assert.equal(new Set(revoked).size, revoked.length, "no object URL is revoked twice");
  browser.document.getElementById("new-thread").dispatch("click");
  assert.equal(created.every((url) => revoked.includes(url)), true, "view disposal revokes the final cancelled local preview");
  assert.equal(new Set(revoked).size, revoked.length, "final cleanup still revokes every URL exactly once");
});

test("pre-send image reconciliation cannot race an accepted exact ticket with preview authentication recovery", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const acceptedSecondRun = Promise.withResolvers();
  const messages = [];
  const secondRunTickets = [];
  let thread = chatThread();
  let startCount = 0;
  let retryCount = 0;
  let selectionCount = 0;
  let failTerminalRefresh = false;
  let secondRunPending = false;
  let resumeConfirmed = false;
  let attachmentReadsDuringPendingMutation = 0;
  const appendCommittedUser = (ticket, hashDigit) => {
    const previousHash = messages.at(-1)?.messageHash ?? null;
    const messageHash = hashDigit.repeat(64);
    messages.push(chatMessage(messages.length + 1, "user", ticket.content, {
      previousHash,
      messageHash,
      attachment: Object.freeze({
        attachmentId: ticket.attachment.attachmentId,
        mediaType: ticket.attachment.mediaType,
        byteLength: ticket.attachment.byteLength,
        width: ticket.attachment.width,
        height: ticket.attachment.height,
        sha256: String(Number(hashDigit) + 2).repeat(64),
      }),
    }));
    thread = chatThread({
      revision: messages.length,
      ledgerHash: messageHash,
      messageCount: messages.length,
      ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      currentGenerationId: ticket.generationId,
    });
  };
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (failTerminalRefresh) {
        failTerminalRefresh = false;
        throw new DirectChatTransportError("terminal refresh unavailable", {
          code: "request_failed",
          status: 503,
          retryable: false,
        });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ attachment }) {
      if (!resumeConfirmed) {
        await acceptedSecondRun.promise;
        if (secondRunPending) attachmentReadsDuringPendingMutation += 1;
        throw new DirectChatTransportError("cosmetic preview authentication expired", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      return { bytes, descriptor: attachment };
    },
    prepareRun(request) {
      return Object.freeze({
        ...request,
        generationId: `generation_race_${startCount + 1}_xxxxxxxxxxxxx`,
        idempotencyKey: `run_race_${startCount + 1}_xxxxxxxxxxxxxxxxx`,
      });
    },
    async startRun(ticket) {
      startCount += 1;
      appendCommittedUser(ticket, String(startCount));
      if (startCount === 1) {
        thread = Object.freeze({ ...thread, currentGenerationId: null });
        failTerminalRefresh = true;
        return {
          request: ticket,
          generation: chatGeneration({
            generationId: ticket.generationId,
            status: "failed",
            terminal: true,
          }),
        };
      }
      secondRunTickets.push(ticket);
      secondRunPending = true;
      acceptedSecondRun.resolve();
      throw new DirectChatTransportError("accepted run response lost", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async getRunStatus() {
      throw new DirectChatTransportError("generation is not visible yet", {
        code: "not_found",
        status: 404,
        retryable: false,
      });
    },
    async retryRun(ticket) {
      secondRunTickets.push(ticket);
      retryCount += 1;
      if (retryCount === 1) {
        throw new DirectChatTransportError("session expired during exact confirmation", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      secondRunPending = false;
      resumeConfirmed = true;
      thread = Object.freeze({ ...thread, currentGenerationId: null });
      return {
        request: ticket,
        generation: chatGeneration({
          generationId: ticket.generationId,
          status: "failed",
          terminal: true,
        }),
      };
    },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "replacement-race-csrf-token" }),
    async canonicalizeImage() {
      selectionCount += 1;
      return Object.freeze({
        attachmentId: `image_race_${selectionCount}_xxxxxxxxxxxxxx`,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 2,
        height: 2,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl: (() => { let next = 0; return () => `blob:race-${next += 1}`; })(),
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  for (const [index, text] of ["Leave one local preview", "Confirm this exact second image"].entries()) {
    imageInput.files = [{ name: `race-${index}.png` }];
    imageInput.dispatch("change");
    await new Promise((resolve) => setImmediate(resolve));
    messageInput.value = text;
    await browser.app.submitMessage({ preventDefault() {} });
  }

  assert.equal(startCount, 2);
  assert.equal(retryCount, 1);
  assert.equal(attachmentReadsDuringPendingMutation, 0, "pre-send reconciliation never starts cosmetic private reads");
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(retryCount, 1, "same-account login does not auto-confirm the accepted mutation");
  await browser.app.resume();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(retryCount, 2);
  assert.equal(secondRunTickets.length, 3);
  assert.equal(secondRunTickets.every((ticket) => ticket === secondRunTickets[0]), true, "Resume reuses the identical accepted ticket");
  assert.equal(attachmentReadsDuringPendingMutation, 0);
  assert.match(browser.document.getElementById("messages").textContent, /Leave one local preview[\s\S]*Confirm this exact second image/u);
});

test("an already-pending preview 401 is fenced before an accepted lost-response mutation", async () => {
  const descriptor = Object.freeze({
    attachmentId: "image_pending_race_xxxxxxxxxx",
    mediaType: "image/png",
    byteLength: 4,
    width: 2,
    height: 2,
    sha256: "9".repeat(64),
  });
  const hashes = [CHAT_HASH_A, CHAT_HASH_B, "c".repeat(64)];
  const messages = [
    chatMessage(1, "user", "Earlier image", { messageHash: hashes[0], attachment: descriptor }),
    chatMessage(2, "assistant", "Earlier answer", { previousHash: hashes[0], messageHash: hashes[1] }),
  ];
  let thread = chatThread({
    revision: 2,
    ledgerHash: hashes[1],
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const previewStarted = Promise.withResolvers();
  const releaseLatePreview = Promise.withResolvers();
  const exactTickets = [];
  let previewSignal = null;
  let previewAuthReturns = 0;
  let retryCount = 0;
  let resumeConfirmed = false;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ attachment, signal }) {
      if (resumeConfirmed) return { bytes: new Uint8Array([1, 2, 3, 4]), descriptor: attachment };
      previewSignal = signal;
      previewStarted.resolve();
      await releaseLatePreview.promise;
      previewAuthReturns += 1;
      throw new DirectChatTransportError("late private preview authentication rejection", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    },
    prepareRun(request) {
      return Object.freeze({
        ...request,
        generationId: "generation_pending_preview_race_x",
        idempotencyKey: "run_pending_preview_race_xxxxxxxx",
      });
    },
    async startRun(ticket) {
      exactTickets.push(ticket);
      messages.push(chatMessage(3, "user", ticket.content, {
        previousHash: hashes[1],
        messageHash: hashes[2],
      }));
      thread = chatThread({
        revision: 3,
        ledgerHash: hashes[2],
        messageCount: 3,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
        currentGenerationId: ticket.generationId,
      });
      releaseLatePreview.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      throw new DirectChatTransportError("accepted response lost after preview fence", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async retryRun(ticket) {
      exactTickets.push(ticket);
      retryCount += 1;
      if (retryCount === 1) {
        throw new DirectChatTransportError("exact confirmation needs fresh authentication", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      resumeConfirmed = true;
      thread = Object.freeze({ ...thread, currentGenerationId: null });
      return {
        request: ticket,
        generation: chatGeneration({
          generationId: ticket.generationId,
          status: "failed",
          terminal: true,
        }),
      };
    },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "pending-preview-race-csrf" }),
    createObjectUrl: (() => { let next = 0; return () => `blob:pending-preview-${next += 1}`; })(),
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  await previewStarted.promise;
  const draft = "Keep this accepted exact mutation";
  browser.document.getElementById("message-input").value = draft;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(previewSignal.aborted, true, "submit fences the already-active cosmetic fetch before mutation I/O");
  assert.equal(previewAuthReturns, 1, "the non-cooperative preview still returned its late 401");
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("message-input").value, draft);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(retryCount, 1);
  await browser.app.resume();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(retryCount, 2);
  assert.equal(exactTickets.length, 3);
  assert.equal(exactTickets.every((ticket) => ticket === exactTickets[0]), true, "the late preview 401 cannot replace the exact mutation ticket");
  assert.match(browser.document.getElementById("messages").textContent, /Earlier image[\s\S]*Keep this accepted exact mutation/u);
});

test("a preview fenced by an interrupted send reloads successfully on a later tap", async () => {
  const observer = intersectionHarness();
  const descriptor = Object.freeze({
    attachmentId: "image_fenced_reload_xxxxxxxxx",
    mediaType: "image/png",
    byteLength: 4,
    width: 2,
    height: 2,
    sha256: "8".repeat(64),
  });
  const messages = [
    chatMessage(1, "user", "Reload this image", { messageHash: CHAT_HASH_A, attachment: descriptor }),
    chatMessage(2, "assistant", "Reload answer", { previousHash: CHAT_HASH_A, messageHash: CHAT_HASH_B }),
  ];
  const thread = chatThread({
    revision: 2,
    ledgerHash: CHAT_HASH_B,
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const firstFetch = Promise.withResolvers();
  const firstFetchStarted = Promise.withResolvers();
  let firstSignal = null;
  let reads = 0;
  let failSnapshot = false;
  let createdUrls = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (failSnapshot) {
        throw new DirectChatTransportError("send snapshot unavailable", {
          code: "request_failed",
          status: 503,
          retryable: false,
        });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ attachment, signal }) {
      reads += 1;
      if (reads === 1) {
        firstSignal = signal;
        firstFetchStarted.resolve();
        return await firstFetch.promise;
      }
      return { bytes: new Uint8Array([1, 2, 3, 4]), descriptor: attachment };
    },
  });
  const browser = harness({
    chat,
    IntersectionObserver: observer.IntersectionObserver,
    createObjectUrl() { createdUrls += 1; return `blob:fenced-reload-${createdUrls}`; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const article = [...observer.latest().targets][0];
  const [image, status] = article.children;
  observer.latest().enter(article);
  await firstFetchStarted.promise;
  failSnapshot = true;
  browser.document.getElementById("message-input").value = "This send will stop before dispatch";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(firstSignal.aborted, true);
  firstFetch.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), descriptor });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(image.dataset.previewState, "deferred");
  assert.equal(status.disabled, false);
  assert.equal(createdUrls, 0, "the stale non-cooperative fetch cannot create a URL");

  status.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(createdUrls, 1);
  assert.equal(image.dataset.previewState, "ready");
  assert.equal(image.src, "blob:fenced-reload-1");
});

test("tap-only previews survive successful pre-send reconciliation followed by preparation failure", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const descriptor = Object.freeze({
    attachmentId: "image_tap_only_xxxxxxxxxxxxx",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 2,
    height: 2,
    sha256: "7".repeat(64),
  });
  const messages = [];
  let thread = chatThread();
  let preparations = 0;
  let failTerminalRefresh = false;
  let attachmentReads = 0;
  let nextUrl = 0;
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (failTerminalRefresh) {
        failTerminalRefresh = false;
        throw new DirectChatTransportError("terminal snapshot unavailable", {
          code: "request_failed",
          status: 503,
          retryable: false,
        });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ attachment }) {
      attachmentReads += 1;
      return { bytes, descriptor: attachment };
    },
    prepareRun(request) {
      preparations += 1;
      if (preparations === 2) throw new TypeError("second run preparation failed");
      return Object.freeze({
        ...request,
        generationId: "generation_tap_only_xxxxxxxxx",
        idempotencyKey: "run_tap_only_xxxxxxxxxxxxxxxxx",
      });
    },
    async startRun(ticket) {
      messages.push(chatMessage(1, "user", ticket.content, {
        messageHash: CHAT_HASH_A,
        attachment: descriptor,
      }));
      thread = chatThread({
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: messages[0].contentBytes,
      });
      failTerminalRefresh = true;
      return {
        request: ticket,
        generation: chatGeneration({
          generationId: ticket.generationId,
          status: "failed",
          terminal: true,
        }),
      };
    },
  });
  const browser = harness({
    chat,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: descriptor.attachmentId,
        mediaType: descriptor.mediaType,
        byteLength: bytes.byteLength,
        width: descriptor.width,
        height: descriptor.height,
        bytes,
        previewBlob: new Blob([bytes], { type: descriptor.mediaType }),
      });
    },
    createObjectUrl() { nextUrl += 1; return `blob:tap-only-${nextUrl}`; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "tap-only.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = "First failed image";
  await browser.app.submitMessage({ preventDefault() {} });

  messageInput.value = "Preparation stops after reconciliation";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(preparations, 2);
  assert.equal(attachmentReads, 0, "pending-send reconciliation does not auto-fetch its history image");
  const article = browser.document.getElementById("messages").children[0];
  const [image, status] = article.children;
  assert.equal(image.dataset.previewState, "deferred");
  assert.equal(status.disabled, false);
  status.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attachmentReads, 1);
  assert.equal(image.dataset.previewState, "ready");
  assert.equal(image.src, "blob:tap-only-3");
});

test("the verified Blob LRU is bounded and purged on page disposal, logout, and account change", async () => {
  const observer = intersectionHarness();
  const threadBId = "chat_0002_yyyyyyyyyyyyyyyyyyyyyyyy";
  const descriptors = new Map([
    [CHAT_THREAD_ID, {
      attachmentId: "image_cache_a_xxxxxxxxxxxx", mediaType: "image/png", byteLength: 4,
      width: 40, height: 40, sha256: "a".repeat(64),
    }],
    [threadBId, {
      attachmentId: "image_cache_b_xxxxxxxxxxxx", mediaType: "image/png", byteLength: 4,
      width: 40, height: 40, sha256: "b".repeat(64),
    }],
  ]);
  const threads = new Map([...descriptors].map(([threadId, descriptor], index) => {
    const firstHash = index === 0 ? CHAT_HASH_A : "c".repeat(64);
    const finalHash = index === 0 ? CHAT_HASH_B : "d".repeat(64);
    const messages = [
      chatMessage(1, "user", `Image ${index}`, {
        threadId,
        messageId: `message_cache_${index}_1_xxxxxxxxxx`,
        messageHash: firstHash,
        attachment: descriptor,
      }),
      chatMessage(2, "assistant", `Answer ${index}`, {
        threadId,
        messageId: `message_cache_${index}_2_xxxxxxxxxx`,
        previousHash: firstHash,
        messageHash: finalHash,
      }),
    ];
    return [threadId, {
      thread: chatThread({
        threadId,
        title: `Cache ${index}`,
        revision: 2,
        ledgerHash: finalHash,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      }),
      messages,
    }];
  }));
  const reads = new Map();
  const revoked = [];
  let nextUrl = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [...threads.values()].map((value) => value.thread) }; },
    async getThread(threadId) { return { thread: threads.get(threadId).thread }; },
    async listMessages({ threadId, afterRevision, limit }) {
      return { messages: threads.get(threadId).messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ threadId, attachment }) {
      reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
      return { bytes: new Uint8Array([1, 2, 3, 4]), descriptor: attachment };
    },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-b", csrfToken: "csrf-token-value-long-enough" }),
    IntersectionObserver: observer.IntersectionObserver,
    attachmentMemoryLimitBytes: 5,
    createObjectUrl() { return `blob:lru-${nextUrl += 1}`; },
    revokeObjectUrl(url) { revoked.push(url); },
  });
  const loadVisible = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const target = [...observer.latest().targets][0];
    assert.ok(target);
    observer.latest().enter(target);
    await new Promise((resolve) => setImmediate(resolve));
  };

  await browser.app.initialize();
  await loadVisible();
  await browser.app.openThread(threadBId, { mode: "chat" });
  await loadVisible();
  await browser.app.openThread(CHAT_THREAD_ID, { mode: "chat" });
  await loadVisible();
  assert.deepEqual(Object.fromEntries(reads), { [CHAT_THREAD_ID]: 2, [threadBId]: 1 }, "a five-byte cap retains only one four-byte Blob");

  const revokedBeforeBfcache = revoked.length;
  const bfcacheImage = browser.document.getElementById("messages").children[0].children[0];
  browser.window.dispatch("pagehide", { persisted: true });
  assert.equal(revoked.length, revokedBeforeBfcache, "BFCache suspension keeps the live preview usable for pageshow restoration");
  assert.equal(bfcacheImage.dataset.previewState, "ready");

  const revokedBeforePagehide = revoked.length;
  browser.window.dispatch("pagehide", { persisted: false });
  assert.ok(revoked.length > revokedBeforePagehide, "page disposal revokes rendered object URLs");
  await browser.app.openThread(CHAT_THREAD_ID, { mode: "chat" });
  await loadVisible();
  assert.equal(reads.get(CHAT_THREAD_ID), 3, "page disposal purges the per-tab Blob cache");

  await browser.app.logout();
  browser.document.getElementById("username").value = "account-b";
  browser.document.getElementById("password").value = "new account password";
  await browser.app.login({ preventDefault() {} });
  await loadVisible();
  assert.equal(reads.get(CHAT_THREAD_ID), 4, "a new authenticated account epoch cannot reuse prior private Blobs");
});

test("leaving a thread aborts its visible attachment fetch before stale bytes can create an object URL", async () => {
  const observer = intersectionHarness();
  const descriptor = {
    attachmentId: "image_abort_owner_xxxxxxxxx", mediaType: "image/png", byteLength: 4,
    width: 40, height: 40, sha256: "f".repeat(64),
  };
  const messages = [
    chatMessage(1, "user", "Abort this preview", { attachment: descriptor }),
    chatMessage(2, "assistant", "Keep ownership strict"),
  ];
  const thread = chatThread({ revision: 2, ledgerHash: CHAT_HASH_B, messageCount: 2, ledgerBytes: 40 });
  const fetchStarted = Promise.withResolvers();
  const fetchAborted = Promise.withResolvers();
  let createdUrls = 0;
  const browser = harness({
    chat: baseChat({
      async listThreads() { return { threads: [thread] }; },
      async getThread() { return { thread }; },
      async listMessages({ afterRevision, limit }) {
        return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
      },
      async getAttachment({ signal }) {
        fetchStarted.resolve();
        return await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            fetchAborted.resolve();
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    }),
    IntersectionObserver: observer.IntersectionObserver,
    createObjectUrl() { createdUrls += 1; return `blob:must-not-exist-${createdUrls}`; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  observer.latest().enter([...observer.latest().targets][0]);
  await fetchStarted.promise;
  browser.document.getElementById("new-thread").dispatch("click");
  await fetchAborted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createdUrls, 0);
  assert.equal(browser.document.getElementById("messages").children.length, 0);
});

test("completed chat navigation ignores a stalled and then out-of-order sidebar refresh", async () => {
  const messages = [
    chatMessage(1, "user", "Existing question"),
    chatMessage(2, "assistant", "Existing answer"),
  ];
  const thread = chatThread({
    revision: 2,
    ledgerHash: CHAT_HASH_B,
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const sidebarRead = Promise.withResolvers();
  const sidebarReadStarted = Promise.withResolvers();
  const newerThread = chatThread({
    threadId: "chat_0003_zzzzzzzzzzzzzzzzzzzzzzzz",
    title: "Newer chat",
  });
  let listedThreads = [thread];
  let stallSidebar = false;
  const chat = baseChat({
    async listThreads() {
      if (stallSidebar) {
        stallSidebar = false;
        sidebarReadStarted.resolve();
        return sidebarRead.promise;
      }
      return { threads: listedThreads };
    },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));

  stallSidebar = true;
  browser.document.getElementById("thread-list").children[0].dispatch("click");
  await sidebarReadStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(browser.document.getElementById("new-thread").disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);

  listedThreads = [newerThread, thread];
  browser.document.getElementById("thread-list").children[0].dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    browser.document.getElementById("thread-list").children.map((button) => button.dataset.threadId),
    [newerThread.threadId, thread.threadId],
  );

  sidebarRead.resolve({ threads: [thread] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    browser.document.getElementById("thread-list").children.map((button) => button.dataset.threadId),
    [newerThread.threadId, thread.threadId],
    "an older list response cannot remove a chat learned by a newer refresh",
  );
});

test("a stale restored-image decode revokes its object URL even when replacement thread loading fails", async () => {
  const replacementThreadId = "chat_0002_yyyyyyyyyyyyyyyyyyyyyyyy";
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const descriptor = {
    attachmentId: "image_0000000000000012",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 96,
    height: 64,
    sha256: "f".repeat(64),
  };
  const sourceMessage = chatMessage(1, "user", "Image still loading", { attachment: descriptor });
  const sourceThread = chatThread({
    revision: 1,
    ledgerHash: CHAT_HASH_A,
    messageCount: 1,
    ledgerBytes: sourceMessage.contentBytes,
  });
  const replacementThread = chatThread({ threadId: replacementThreadId, title: "Replacement" });
  const decodeStarted = Promise.withResolvers();
  const decodeGate = Promise.withResolvers();
  const replacementReadStarted = Promise.withResolvers();
  const revokedUrls = [];
  const chat = baseChat({
    async listThreads() { return { threads: [sourceThread, replacementThread] }; },
    async getThread(threadId) {
      if (threadId === replacementThreadId) {
        replacementReadStarted.resolve();
        throw Object.assign(new Error("replacement snapshot unavailable"), { retryable: true });
      }
      return { thread: sourceThread };
    },
    async listMessages({ threadId, afterRevision, limit }) {
      const messages = threadId === CHAT_THREAD_ID ? [sourceMessage] : [];
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment() { return { descriptor, bytes }; },
  });
  const browser = harness({
    chat,
    decodeImage(image) {
      decodeStarted.resolve(image);
      return decodeGate.promise;
    },
    createObjectUrl() { return "blob:stale-restored-image"; },
    revokeObjectUrl(url) { revokedUrls.push(url); },
  });

  const initialization = browser.app.initialize();
  await decodeStarted.promise;
  browser.document.getElementById("thread-list").children[1].dispatch("click");
  await replacementReadStarted.promise;
  decodeGate.reject(new Error("stale image decode"));
  await initialization;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(revokedUrls, ["blob:stale-restored-image"]);
  assert.match(browser.document.getElementById("toast").textContent, /could not be restored safely/iu);
});

test("a local multi-image-run preparation failure preserves both images and the exact prompt for retry", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const attachmentIds = [
    "image_retry_first_0000000000001",
    "image_retry_second_000000000001",
  ];
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
    async canonicalizeImage(file) {
      const index = file.name === "retry-first.png" ? 0 : 1;
      return Object.freeze({
        attachmentId: attachmentIds[index],
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 64 + index,
        height: 64,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() {
      objectUrlCalls += 1;
      return `blob:retry-image-${objectUrlCalls}`;
    },
    revokeObjectUrl(value) { revokedUrls.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "retry-first.png" }, { name: "retry-second.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createCalls, 0, "a synchronous preparation failure cannot create a durable thread");
  assert.equal(messageInput.value, draft, "local failure restores the exact pre-trim textarea draft");
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:retry-image-1");
  assert.match(browser.document.getElementById("image-preview-label").textContent, /2 images/u);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("toast").textContent, /image message was not sent[\s\S]*still ready/iu);
  assert.deepEqual(browser.document.getElementById("workspace").dataset, {
    mode: "chat",
    status: "idle",
    failureStage: "local_preparation",
    failureCode: "run_ticket_invalid",
    failureOperation: "local_run",
  });
  assert.deepEqual(revokedUrls, [], "the restored preview keeps its original live object URL");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(createCalls, 1);
  assert.equal(preparedRun.content, prompt, "retry preserves the original prompt exactly");
  assert.deepEqual(
    preparedRun.attachments.map((attachment) => attachment.attachmentId),
    attachmentIds,
    "retry preserves both private images in their original order",
  );
  assert.equal(preparedRun.attachments[0].bytes, bytes);
  assert.equal(preparedRun.attachments[1].bytes, bytes, "retry preserves both canonical byte objects");
  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.ok(revokedUrls.includes("blob:retry-image-1"));
  assert.ok(revokedUrls.includes("blob:retry-image-2"));
  assert.match(browser.document.getElementById("messages").textContent, /Retried safely/u);
});

test("an existing-thread snapshot outage restores the exact image draft before any run dispatch", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const draft = "  Describe this image.\nKeep the exact spacing.  ";
  const thread = chatThread();
  let failReads = false;
  let prepareRuns = 0;
  let startRuns = 0;
  const waits = [];
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
    async wait(delay) { waits.push(delay); },
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
  assert.deepEqual(waits, [250, 500]);
  assert.equal(browser.document.getElementById("workspace").dataset.failureStage, "snapshot");
  assert.equal(browser.document.getElementById("workspace").dataset.failureCode, "snapshot_unavailable");
  assert.equal(browser.document.getElementById("workspace").dataset.failureOperation, "snapshot");
  assert.deepEqual(revokedUrls, []);
});

test("a retryable snapshot transport failure backs off once and dispatches exactly one run", async () => {
  const thread = chatThread();
  let failNextSnapshot = false;
  let snapshotFailures = 0;
  let prepareRuns = 0;
  let startRuns = 0;
  const waits = [];
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (failNextSnapshot && snapshotFailures === 0) {
        snapshotFailures += 1;
        throw new DirectChatTransportError("temporary transport loss", {
          code: "request_failed",
          status: 503,
          retryable: true,
        });
      }
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      prepareRuns += 1;
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_snapshot_retry_once" });
    },
    async startRun(ticket) {
      startRuns += 1;
      return { request: ticket, generation: chatGeneration({ status: "failed", terminal: true }) };
    },
  });
  const browser = harness({ chat, async wait(delay) { waits.push(delay); } });
  await browser.app.initialize();
  failNextSnapshot = true;
  browser.document.getElementById("message-input").value = "Retry only the read";

  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(snapshotFailures, 1);
  assert.deepEqual(waits, [250]);
  assert.equal(prepareRuns, 1);
  assert.equal(startRuns, 1);
  assert.equal(browser.document.getElementById("message-input").value, "");
  assert.equal(browser.document.getElementById("workspace").dataset.failureStage, undefined);
});

test("expired authentication restores the detached image first and never auto-resends after same-account login", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const thread = chatThread();
  const draft = "  Preserve this private image prompt exactly.  ";
  let expired = false;
  let starts = 0;
  let nextUrl = 0;
  const revoked = [];
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (expired) throw new DirectChatTransportError("expired", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_auth_recovery_xxxxx" });
    },
    async startRun(ticket) {
      starts += 1;
      return { request: ticket, generation: chatGeneration({ status: "failed", terminal: true }) };
    },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "replacement-csrf-token-value" }),
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
    createObjectUrl() { return `blob:auth-recovery-image-${nextUrl += 1}`; },
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "private.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;
  expired = true;

  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("app-view").hidden, true);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:auth-recovery-image-1");
  assert.equal(starts, 0);
  assert.deepEqual(browser.document.getElementById("workspace").dataset, {
    mode: "chat",
    status: "idle",
    failureStage: "authentication",
    failureCode: "authentication_required",
    failureOperation: "snapshot",
  });
  assert.doesNotMatch(JSON.stringify(browser.document.getElementById("workspace").dataset), /private|0000000000000006/iu);
  assert.deepEqual(revoked, []);

  expired = false;
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(starts, 0, "successful reauthentication never auto-dispatches the preserved request");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(starts, 1);
  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.deepEqual(revoked, ["blob:auth-recovery-image-1", "blob:auth-recovery-image-2"]);
});

test("same-account capability exhaustion keeps the recovered image visible, fenced, and removable", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const thread = chatThread();
  const draft = "Keep this image while capability reads recover";
  let expired = false;
  let capabilityOutage = false;
  let capabilityReads = 0;
  const waits = [];
  const revoked = [];
  const chat = baseChat({
    async capabilities() {
      capabilityReads += 1;
      if (capabilityOutage) throw new DirectChatTransportError("capability unavailable", {
        code: "request_failed",
        status: 503,
        retryable: true,
      });
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (expired) throw new DirectChatTransportError("expired", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) { return Object.freeze(request); },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "replacement-capability-csrf" }),
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000009",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:capability-recovery-image"; },
    revokeObjectUrl(value) { revoked.push(value); },
    async wait(delay) { waits.push(delay); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "recover.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;
  expired = true;
  await browser.app.submitMessage({ preventDefault() {} });

  expired = false;
  capabilityOutage = true;
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(capabilityReads, 4, "startup plus three bounded recovery capability reads");
  assert.deepEqual(waits, [250, 500]);
  assert.equal(messageInput.value, draft);
  assert.equal(messageInput.disabled, true);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("remove-image").disabled, false);
  assert.deepEqual(revoked, []);
  assert.match(browser.document.getElementById("toast").textContent, /remains visible and unsent/iu);

  browser.document.getElementById("remove-image").dispatch("click");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(messageInput.value, draft);
  assert.equal(messageInput.disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.deepEqual(revoked, ["blob:capability-recovery-image"]);
});

test("same-account vision disablement keeps the recovered image visible until explicit removal", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const thread = chatThread();
  const draft = "Keep this image when vision is authoritatively unavailable";
  let expired = false;
  let visionInput = true;
  const revoked = [];
  const chat = baseChat({
    async capabilities() {
      return visionInput
        ? { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 }
        : { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (expired) throw new DirectChatTransportError("expired", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) { return Object.freeze(request); },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "replacement-no-vision-csrf" }),
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000010",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:no-vision-recovery-image"; },
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "recover.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = draft;
  expired = true;
  await browser.app.submitMessage({ preventDefault() {} });

  expired = false;
  visionInput = false;
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(messageInput.value, draft);
  assert.equal(messageInput.disabled, true);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("remove-image").disabled, false);
  assert.deepEqual(revoked, []);
  assert.match(browser.document.getElementById("toast").textContent, /Image sending is unavailable/iu);

  browser.document.getElementById("remove-image").dispatch("click");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(messageInput.value, draft);
  assert.equal(messageInput.disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.deepEqual(revoked, ["blob:no-vision-recovery-image"]);
});

test("expired authentication never carries a private draft or image into a different account", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const thread = chatThread();
  let expired = false;
  const revoked = [];
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (expired) throw new DirectChatTransportError("expired", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
      return { thread };
    },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) { return Object.freeze(request); },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "different-user", csrfToken: "different-csrf-token-value" }),
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000007",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:cross-account-image"; },
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "private.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = "Private old-account draft";
  expired = true;
  await browser.app.submitMessage({ preventDefault() {} });

  expired = false;
  browser.document.getElementById("username").value = "different-user";
  browser.document.getElementById("password").value = "different password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.deepEqual(revoked, ["blob:cross-account-image"]);
  assert.match(browser.document.getElementById("toast").textContent, /cleared before switching accounts/iu);
});

test("a different account cannot inherit an ambiguous committed thread ticket or its locked image", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let thread = null;
  let differentAccount = false;
  let threadCommits = 0;
  let createRetries = 0;
  let starts = 0;
  const revoked = [];
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_cross_account_x" });
    },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_cross_account_xxxx" });
    },
    async createThread(ticket) {
      threadCommits += 1;
      thread = chatThread({ title: ticket.title });
      throw new DirectChatTransportError("accepted response lost", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async retryCreateThread() {
      createRetries += 1;
      throw new DirectChatTransportError("session expired", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    },
    async listThreads() { return { threads: differentAccount ? [] : (thread ? [thread] : []) }; },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    async startRun() { starts += 1; throw new Error("cross-account workflow must not dispatch"); },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "different-user", csrfToken: "different-account-csrf-token" }),
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000008",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:ambiguous-cross-account-image"; },
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "private.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  messageInput.value = "Private ambiguous old-account draft";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(threadCommits, 1);
  assert.equal(createRetries, 1);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(messageInput.disabled, true);

  differentAccount = true;
  browser.document.getElementById("username").value = "different-user";
  browser.document.getElementById("password").value = "different password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(messageInput.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.deepEqual(revoked, ["blob:ambiguous-cross-account-image"]);
  await browser.app.resume();
  assert.equal(createRetries, 1);
  assert.equal(starts, 0);
});

test("a rejected CSRF token returns to sign-in with the exact draft and no automatic redispatch", async () => {
  const thread = chatThread();
  const draft = "  Keep this CSRF-recovery draft exactly.\n  ";
  let starts = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_csrf_recovery_xxxxx" });
    },
    async startRun() {
      starts += 1;
      throw new DirectChatTransportError("csrf rejected", {
        code: "csrf_rejected",
        status: 403,
        retryable: false,
      });
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = draft;

  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(starts, 1);
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("message-input").value, draft);
  assert.equal(browser.document.getElementById("workspace").dataset.failureStage, "csrf");
  assert.equal(browser.document.getElementById("workspace").dataset.failureCode, "csrf_rejected");
  assert.equal(browser.document.getElementById("workspace").dataset.failureOperation, "run_dispatch");
  await Promise.resolve();
  assert.equal(starts, 1, "reauthentication recovery never auto-resends a rejected mutation");
});

test("a committed thread with a lost response survives repeated auth expiry and resumes only its exact tickets", async () => {
  const draft = "  Confirm this exact new-thread send after sign-in.  ";
  let thread = null;
  let threadPreparations = 0;
  let runPreparations = 0;
  let threadCommits = 0;
  let createRetries = 0;
  let starts = 0;
  let logins = 0;
  const chat = baseChat({
    prepareThread({ title }) {
      threadPreparations += 1;
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_auth_ambiguous_x" });
    },
    prepareRun(request) {
      runPreparations += 1;
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_auth_ambiguous_xxxx" });
    },
    async createThread(ticket) {
      threadCommits += 1;
      thread = chatThread({ title: ticket.title });
      throw new DirectChatTransportError("accepted response lost", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async retryCreateThread(ticket) {
      createRetries += 1;
      if (createRetries <= 2) {
        throw new DirectChatTransportError("session expired", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    async startRun(ticket) {
      starts += 1;
      return { request: ticket, generation: chatGeneration({ status: "failed", terminal: true }) };
    },
  });
  const browser = harness({
    chat,
    login: async () => {
      logins += 1;
      return { authenticated: true, username: "account-user", csrfToken: `replacement-csrf-token-${logins}` };
    },
  });
  await browser.app.initialize();
  const messageInput = browser.document.getElementById("message-input");
  messageInput.value = draft;

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(threadCommits, 1);
  assert.equal(createRetries, 1);
  assert.equal(starts, 0);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.match(browser.document.getElementById("toast").textContent, /may already exist[\s\S]*Resume/iu);

  for (let recovery = 0; recovery < 2; recovery += 1) {
    browser.document.getElementById("username").value = "account-user";
    browser.document.getElementById("password").value = "replacement password";
    await browser.app.login({ preventDefault() {} });
    assert.equal(starts, 0, "login never auto-confirms or dispatches the preserved workflow");
    assert.equal(threadPreparations, 1);
    assert.equal(runPreparations, 1);
    assert.equal(messageInput.value, draft);
    assert.equal(messageInput.disabled, true);
    assert.equal(browser.document.getElementById("resume-run").hidden, false);
    await browser.app.resume();
    if (recovery === 0) {
      assert.equal(browser.document.getElementById("login-view").hidden, false, "a second expiry keeps the same ticket recoverable");
      assert.equal(createRetries, 2);
      assert.equal(starts, 0);
    }
  }

  assert.equal(threadCommits, 1, "the authoritative thread mutation occurred exactly once");
  assert.equal(createRetries, 3);
  assert.equal(threadPreparations, 1);
  assert.equal(runPreparations, 1);
  assert.equal(starts, 1);
  assert.equal(messageInput.value, "");
});

test("same-account login hydration expiry preserves an ambiguous exact-send workflow across another login", async () => {
  const draft = "Keep the original exact ticket through repeated login hydration";
  let thread = null;
  let logins = 0;
  let listAuthenticationFailures = 0;
  let threadPreparations = 0;
  let runPreparations = 0;
  let threadCommits = 0;
  let createRetries = 0;
  let starts = 0;
  const createTickets = [];
  const runTickets = [];
  const chat = baseChat({
    prepareThread({ title }) {
      threadPreparations += 1;
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_create_login_hydration_x" });
    },
    prepareRun(request) {
      runPreparations += 1;
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_login_hydration_xxxx" });
    },
    async createThread(ticket) {
      createTickets.push(ticket);
      threadCommits += 1;
      thread = chatThread({ title: ticket.title });
      throw new DirectChatTransportError("accepted response lost", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async retryCreateThread(ticket) {
      createTickets.push(ticket);
      createRetries += 1;
      if (createRetries === 1) {
        throw new DirectChatTransportError("session expired after ambiguous commit", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      return { request: ticket, thread };
    },
    async listThreads() {
      if (logins === 1 && listAuthenticationFailures === 0) {
        listAuthenticationFailures += 1;
        throw new DirectChatTransportError("session expired during login hydration", {
          code: "authentication_required",
          status: 401,
          retryable: false,
        });
      }
      return { threads: thread ? [thread] : [] };
    },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    async startRun(ticket) {
      runTickets.push(ticket);
      starts += 1;
      return { request: ticket, generation: chatGeneration({ status: "failed", terminal: true }) };
    },
  });
  const browser = harness({
    chat,
    login: async () => {
      logins += 1;
      return { authenticated: true, username: "account-user", csrfToken: `hydration-csrf-token-${logins}` };
    },
  });
  await browser.app.initialize();
  const messageInput = browser.document.getElementById("message-input");
  messageInput.value = draft;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(threadCommits, 1);
  assert.equal(createRetries, 1);
  assert.equal(starts, 0);
  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });

  assert.equal(listAuthenticationFailures, 1);
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(messageInput.value, draft);
  assert.equal(threadCommits, 1);
  assert.equal(createRetries, 1, "login hydration never retries the ambiguous mutation");
  assert.equal(starts, 0);

  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "second replacement password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(browser.document.getElementById("app-view").hidden, false);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(messageInput.disabled, true);
  assert.equal(createRetries, 1, "a successful login also never auto-confirms the mutation");
  await browser.app.resume();

  assert.equal(threadPreparations, 1);
  assert.equal(runPreparations, 1);
  assert.equal(threadCommits, 1);
  assert.equal(createRetries, 2);
  assert.equal(starts, 1);
  assert.equal(createTickets.every((ticket) => ticket === createTickets[0]), true);
  assert.equal(runTickets.length, 1);
  assert.equal(messageInput.value, "");
});

test("a committed run with a lost response survives an opaque proxy 403 and Resume renders the same existing thread", async () => {
  const thread = chatThread();
  const draft = "Confirm the exact existing-thread turn";
  let authoritativeThread = thread;
  let messages = [];
  let runPreparations = 0;
  let runCommits = 0;
  let runRetries = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [authoritativeThread] }; },
    async getThread() { return { thread: authoritativeThread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      runPreparations += 1;
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_csrf_ambiguous_xxxx" });
    },
    async startRun(ticket) {
      runCommits += 1;
      messages = [chatMessage(1, "user", ticket.content)];
      authoritativeThread = chatThread({
        revision: 1,
        ledgerHash: CHAT_HASH_A,
        messageCount: 1,
        ledgerBytes: messages[0].contentBytes,
      });
      throw new DirectChatTransportError("accepted response lost", {
        code: "request_timeout",
        status: 504,
        retryable: true,
      });
    },
    async retryRun(ticket) {
      runRetries += 1;
      if (runRetries === 1) {
        throw new DirectChatTransportError("opaque proxy rejection", {
          code: "request_failed",
          status: 403,
          retryable: false,
        });
      }
      return { request: ticket, generation: chatGeneration({ status: "failed", terminal: true }) };
    },
  });
  const browser = harness({
    chat,
    login: async () => ({ authenticated: true, username: "account-user", csrfToken: "replacement-csrf-run-token" }),
  });
  await browser.app.initialize();
  const messageInput = browser.document.getElementById("message-input");
  messageInput.value = draft;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(runCommits, 1);
  assert.equal(runRetries, 1);
  assert.equal(runPreparations, 1);
  assert.equal(messageInput.value, draft);
  assert.equal(browser.document.getElementById("workspace").dataset.failureStage, "authoritative_rejection");
  assert.equal(browser.document.getElementById("workspace").dataset.failureCode, "request_rejected");
  assert.equal(browser.document.getElementById("workspace").dataset.failureOperation, "run_dispatch");
  assert.equal(browser.document.getElementById("login-view").hidden, false);

  browser.document.getElementById("username").value = "account-user";
  browser.document.getElementById("password").value = "replacement password";
  await browser.app.login({ preventDefault() {} });
  assert.equal(runRetries, 1, "same-account login never auto-retries the mutation");
  assert.equal(messageInput.disabled, true);
  await browser.app.resume();

  assert.equal(runCommits, 1);
  assert.equal(runRetries, 2);
  assert.equal(runPreparations, 1);
  assert.equal(messageInput.value, "");
  assert.match(browser.document.getElementById("messages").textContent, /Confirm the exact existing-thread turn/u);
  assert.equal(browser.document.getElementById("conversation-title").textContent, thread.title);
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
  assert.equal(browser.document.getElementById("connection-state").textContent, "Request not sent · Conversation changed");
  assert.equal(browser.document.getElementById("workspace").dataset.failureStage, "authoritative_conflict");
  assert.equal(browser.document.getElementById("workspace").dataset.failureCode, "conflict");
  assert.equal(browser.document.getElementById("workspace").dataset.failureOperation, "run_dispatch");
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

test("a completed generation stays visibly locked in Finalizing until Resume restores its authoritative snapshot", async () => {
  let thread = null;
  let messages = [];
  let runAccepted = false;
  let finalSnapshotAvailable = false;
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
      if (runAccepted && !finalSnapshotAvailable) {
        throw Object.assign(new Error("snapshot temporarily unavailable"), { retryable: true });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId: CHAT_GENERATION_ID, idempotencyKey: "run_start_terminal_xxxxxxxxx" });
    },
    async startRun(ticket) {
      runAccepted = true;
      messages = [
        chatMessage(1, "user", ticket.content),
        chatMessage(2, "assistant", "Authoritative final answer"),
      ];
      thread = chatThread({
        title: thread.title,
        revision: 2,
        ledgerHash: CHAT_HASH_B,
        messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return { request: ticket, generation: completed };
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Keep the confirmed result";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "finalizing");
  assert.equal(browser.document.getElementById("workspace").getAttribute("aria-busy"), "true");
  assert.equal(browser.document.getElementById("run-state").textContent, "Finalizing");
  assert.equal(browser.document.getElementById("connection-state").textContent, "Finalizing · reconnect needed");
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(browser.document.getElementById("new-thread").disabled, true);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.match(browser.document.getElementById("toast").textContent, /authoritative final view is not ready/iu);
  assert.doesNotMatch(browser.document.getElementById("toast").textContent, /interrupted/iu);
  assert.match(browser.document.getElementById("messages").textContent, /Keep the confirmed result/u);

  browser.document.getElementById("new-thread").dispatch("click");
  assert.equal(browser.document.getElementById("conversation-title").textContent, "Keep the confirmed result");
  finalSnapshotAvailable = true;
  await browser.app.resume();
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("workspace").getAttribute("aria-busy"), "false");
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(browser.document.getElementById("connection-state").textContent, "Connected");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(browser.document.getElementById("new-thread").disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("thread-list").children[0].disabled, false);
  assert.match(browser.document.getElementById("messages").textContent, /Authoritative final answer/u);
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
  assert.equal(browser.document.getElementById("connection-state").textContent, "Request not sent · Conversation changed");
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
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|CacheStorage|caches\.open/u);
  const releaseReload = /function reloadForActiveUpdate\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? "";
  assert.match(releaseReload, /purgeAttachmentMemory\(\)/u, "release navigation purges private in-memory attachment state");
  assert.match(source, /addEventListener\?\.\("pagehide", \(event\) => \{[\s\S]*?event\?\.persisted !== true[\s\S]*?purgeAttachmentMemory\(\)/u);
});
