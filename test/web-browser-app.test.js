import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBrowserApp } from "../src/web/browser-app.js";
import { AgintiTransportError } from "../src/web/aginti-client.js";
import { canonicalJson, verifyAgentEvent } from "../src/web/aginti-protocol.js";
import { DirectChatTransportError } from "../src/web/direct-chat-client.js";

const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";
const OTHER_THREAD_ID = "thr_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "run_12345678-1234-4123-8123-123456789abc";
const SECOND_RUN_ID = "run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THIRD_RUN_ID = "run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARTIFACT_ID = `art_${"a".repeat(64)}`;
const SECOND_ARTIFACT_ID = `art_${"b".repeat(64)}`;
const NOW = "2026-08-20T08:00:00.000Z";
const ZERO_HASH = "0".repeat(64);
const CHAT_THREAD_ID = "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx";
const CHAT_GENERATION_ID = "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx";
const CHAT_HASH_A = "a".repeat(64);
const CHAT_HASH_B = "b".repeat(64);

function rolloutChatError(retryAfterMs = 1_000) {
  return new DirectChatTransportError("Direct Chat request was not accepted.", {
    code: "rollout_in_progress",
    status: 503,
    retryable: true,
    retryAfterMs,
  });
}

function rolloutAgentError(retryAfterMs = 1_000) {
  return new AgintiTransportError("AgInTi request was not accepted", {
    code: "rollout_in_progress",
    status: 503,
    retryable: true,
    retryAfterMs,
  });
}

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
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollCalls = [];
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
  scrollTo(options) {
    this.scrollTop = Number(options?.top ?? 0);
    this.scrollCalls.push({ top: this.scrollTop, behavior: options?.behavior ?? "auto" });
  }
  get textContent() { return this.tagName === "#text" ? this.nodeValue : this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.children = [new Node("#text", String(value))]; }
}

const IDS = [
  "login-view", "app-view", "login-form", "login-submit", "login-error", "username", "password", "remember-session",
  "signed-in-user", "logout", "new-thread", "thread-list", "workspace", "conversation-title",
  "connection-state", "mode-switch", "agent-mode", "chat-mode", "theme-picker", "offline-banner",
  "update-banner", "apply-update", "defer-update", "context-indicator", "context-indicator-text", "welcome",
  "welcome-eyebrow", "welcome-copy", "chat-scroll", "messages", "chat-bottom", "go-to-bottom",
  "activity-panel", "activity-disclosure", "run-state", "agent-plan",
  "agent-timeline", "agent-artifacts", "composer", "message-input", "send-message", "resume-run",
  "stop-run", "image-input", "add-image", "image-preview", "image-preview-thumbnail",
  "image-preview-label", "remove-image", "install-app", "toast", "sidebar", "sidebar-scrim", "open-sidebar",
  "search-controls", "search-toggle", "search-options", "search-mode", "search-limit", "capability-note",
];

class Document {
  constructor({ decodeImage = async () => {} } = {}) {
    this.documentElement = new Node("html");
    this.decodeImage = decodeImage;
    this.visibilityState = "visible";
    this.listeners = new Map();
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
  addEventListener(name, listener) {
    const current = this.listeners.get(name) ?? [];
    current.push(listener);
    this.listeners.set(name, current);
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function threadOpenControls(document) {
  return document.getElementById("thread-list").children.map((entry) => (
    entry.className === "thread-row" ? entry.children[0] : entry
  ));
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

function agentImageCapabilities(overrides = {}) {
  return capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: true },
    attachments: {
      enabled: true,
      transport: "inline-base64",
      acceptedMediaTypes: ["image/png", "image/jpeg"],
      maximumCount: 4,
      maximumBytesEach: 4 * 1024 * 1024,
      maximumBytesTotal: 16 * 1024 * 1024,
      requestTimeoutMs: 515_000,
      model: "localllm-vision",
      persistence: "retained-reference-v1",
    },
    ...overrides,
  });
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
    prepareThreadDeletion() { throw new Error("unexpected Direct Chat deletion"); },
    async deleteThread() { throw new Error("unexpected Direct Chat deletion"); },
    async retryDeleteThread() { throw new Error("unexpected Direct Chat deletion retry"); },
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

function terminalTextChat({ onRun = () => {} } = {}) {
  let thread = null;
  let messages = [];
  return baseChat({
    prepareThread({ title }) {
      return Object.freeze({
        threadId: CHAT_THREAD_ID,
        title,
        idempotencyKey: "thread_create_agent_handoff_x",
      });
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
        idempotencyKey: "run_start_agent_handoff_xxx",
      });
    },
    async startRun(ticket) {
      onRun(ticket);
      messages = [
        chatMessage(1, "user", ticket.content),
        chatMessage(2, "assistant", "Direct Chat answer"),
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
}

function harness({
  restore = { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" },
  login,
  logout,
  agent = baseAgent(),
  chat,
  agentFactory,
  chatFactory,
  credentialSaver = async () => false,
  canonicalizeImage,
  decodeImage,
  createObjectUrl,
  revokeObjectUrl,
  attachmentDecodeTimeoutMs,
  attachmentMemoryLimitBytes,
  attachmentDecodedMemoryLimitBytes,
  IntersectionObserver,
  cursorStore,
  wait = async () => {},
  maxStreamBackoffSteps = 5,
  maxAutomaticAgentReconnects = 3,
  requestAnimationFrame = (callback) => callback(),
} = {}) {
  const document = new Document({ ...(decodeImage === undefined ? {} : { decodeImage }) });
  const windowListeners = new Map();
  const window = {
    location: { protocol: "http:", reload() {} },
    setTimeout() {},
    requestAnimationFrame,
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
    async restore() { return typeof restore === "function" ? await restore() : await restore; },
    async login(value) { return login ? await login(value) : restore; },
    async logout() { return logout ? await logout() : { signedOut: true, agentCancellationPending: false }; },
  };
  const directChat = chat ?? baseChat();
  const app = createBrowserApp({
    document,
    window,
    navigator: { onLine: true },
    sessionClient,
    createAgentClient: agentFactory ?? (() => agent),
    createChatClient: chatFactory ?? (() => directChat),
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
    ...(cursorStore === undefined ? {} : { cursorStore }),
    wait,
    maxStreamBackoffSteps,
    maxAutomaticAgentReconnects,
  });
  return { app, document, sessionClient, window };
}

async function settleBrowserEvents(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

async function verifiedEvent({
  seq, type, payload, previousHash, runId = RUN_ID, threadId = THREAD_ID,
}) {
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
  const value = { ...envelope, hash: digest(canonicalJson(envelope)) };
  return await verifyAgentEvent(value, {
    expectedRunId: runId,
    expectedThreadId: threadId,
    afterSeq: seq - 1,
    previousHash,
    digest: async (input) => digest(input),
  });
}

async function verifiedEvents(entries, { runId = RUN_ID } = {}) {
  const events = [];
  let previousHash = ZERO_HASH;
  for (const [type, payload] of entries) {
    const event = await verifiedEvent({ seq: events.length + 1, type, payload, previousHash, runId });
    events.push(event);
    previousHash = event.hash;
  }
  return events;
}

function run(status = "running", overrides = {}) {
  const id = overrides.id ?? RUN_ID;
  const defaultPreviousRunId = id === SECOND_RUN_ID
    ? RUN_ID
    : (id === THIRD_RUN_ID ? SECOND_RUN_ID : null);
  return {
    id,
    threadId: THREAD_ID,
    previousRunId: Object.hasOwn(overrides, "previousRunId")
      ? overrides.previousRunId
      : defaultPreviousRunId,
    status,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: ["completed", "failed", "cancelled"].includes(status) ? NOW : null,
    cancelRequestedAt: null,
    output: status === "completed" ? "Done" : "",
    error: null,
    authority: { kind: "aginti", snapshotHash: null, runtimeRevision: null, contextDigest: null },
    eventCursor: { firstSeq: 1, lastSeq: 0, lastHash: ZERO_HASH, prunedThroughSeq: 0 },
    ...overrides,
  };
}

function terminalRun(status, events, overrides = {}) {
  const last = events.at(-1);
  return run(status, {
    eventCursor: {
      firstSeq: 1,
      lastSeq: last?.seq ?? 0,
      lastHash: last?.hash ?? ZERO_HASH,
      prunedThroughSeq: 0,
    },
    ...overrides,
  });
}

function agentThread(overrides = {}) {
  const messages = (overrides.messages ?? []).map((message) => ({
    ...message,
    id: /^msg_[A-Za-z0-9_-]{16,96}$/u.test(message.id)
      ? message.id
      : `${message.id}${"_".repeat(Math.max(0, 20 - message.id.length))}`,
    createdAt: message.createdAt ?? NOW,
    digest: message.digest ?? digest(message.content),
  }));
  return {
    id: THREAD_ID,
    title: "Agent calculation",
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
    ...overrides,
    messages,
  };
}

test("browser UI defaults to Agent only after an exact enabled AgInTi capability", async () => {
  const enabled = harness({
    agent: baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
  });
  await enabled.app.initialize();
  assert.equal(enabled.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(enabled.document.getElementById("mode-switch").hidden, false);
  assert.equal(enabled.document.getElementById("agent-mode").getAttribute("aria-pressed"), "true");
  assert.equal(enabled.document.getElementById("search-controls").hidden, true, "legacy Agent capability keeps Search absent");
  assert.equal(enabled.document.getElementById("add-image").hidden, true,
    "Agent image input stays hidden until the exact attachment capability is enabled");
  assert.match(enabled.document.getElementById("capability-note").textContent,
    /bounded Python 3\.12[\s\S]*no image input, file creation, web search/iu);

  const malformed = harness({ agent: baseAgent({ ...capabilities({ enabled: true }), runtime: { model: "browser-choice" } }) });
  await malformed.app.initialize();
  assert.equal(malformed.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(malformed.document.getElementById("mode-switch").hidden, true);
  assert.equal(malformed.document.getElementById("connection-state").textContent, "Connected · Chat only");
  assert.match(malformed.document.getElementById("capability-note").textContent, /Agent unavailable/iu);
});

test("foreground capability refresh exposes an upgraded Agent image input without reloading or changing the draft", async () => {
  let agentCapability = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
  });
  let agentReads = 0;
  let chatReads = 0;
  const agent = {
    ...baseAgent(),
    async capabilities() {
      agentReads += 1;
      return agentCapability;
    },
  };
  const chat = baseChat({
    async capabilities() {
      chatReads += 1;
      return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 };
    },
  });
  const browser = harness({ agent, chat });
  await browser.app.initialize();
  const draft = browser.document.getElementById("message-input");
  draft.value = "Describe the images I will attach";
  assert.equal(browser.document.getElementById("add-image").hidden, true);

  agentCapability = agentImageCapabilities();
  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents();

  assert.equal(agentReads, 2);
  assert.equal(chatReads, 2, "one foreground edge refetches both independent capability contracts");
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(browser.document.getElementById("add-image").hidden, false);
  assert.equal(draft.value, "Describe the images I will attach");
  assert.match(browser.document.getElementById("capability-note").textContent, /up to four images/iu);
});

test("an in-page Agent availability upgrade reveals its mode without reassigning the current Chat view", async () => {
  let agentCapability = capabilities();
  const agent = {
    ...baseAgent(),
    async capabilities() { return agentCapability; },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  const draft = browser.document.getElementById("message-input");
  draft.value = "Keep this Chat draft while Agent appears";
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(browser.document.getElementById("mode-switch").hidden, true);

  agentCapability = agentImageCapabilities();
  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents();
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(browser.document.getElementById("mode-switch").hidden, false);
  assert.equal(browser.document.getElementById("agent-mode").disabled, false);
  assert.equal(draft.value, "Keep this Chat draft while Agent appears");
});

test("concurrent pageshow and visibility resume events share one capability refresh and throttle the next duplicate", async () => {
  const session = { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" };
  const resumedSession = Promise.withResolvers();
  let restores = 0;
  let agentReads = 0;
  let chatReads = 0;
  const browser = harness({
    async restore() {
      restores += 1;
      return restores === 1 ? session : await resumedSession.promise;
    },
    agent: {
      ...baseAgent(),
      async capabilities() { agentReads += 1; return capabilities(); },
    },
    chat: baseChat({
      async capabilities() {
        chatReads += 1;
        return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 };
      },
    }),
  });
  await browser.app.initialize();

  browser.window.dispatch("pageshow", { persisted: true });
  browser.document.dispatch("visibilitychange");
  await Promise.resolve();
  assert.equal(restores, 2, "the visibility duplicate does not start a second session read");
  resumedSession.resolve(session);
  await settleBrowserEvents();
  assert.equal(agentReads, 2);
  assert.equal(chatReads, 2);

  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents();
  assert.equal(restores, 3, "session ownership is still revalidated on the later event");
  assert.equal(agentReads, 2, "the bounded foreground throttle skips a duplicate Agent probe");
  assert.equal(chatReads, 2, "the bounded foreground throttle skips a duplicate Chat probe");
});

test("capability outage retains a staged Chat image fail-closed and an online edge restores it in place", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const draftText = "Keep this exact offline image draft";
  let outage = false;
  let agentReads = 0;
  let chatReads = 0;
  const revoked = [];
  const browser = harness({
    agent: {
      ...baseAgent(),
      async capabilities() {
        agentReads += 1;
        if (outage) throw new Error("Agent capability offline");
        return capabilities();
      },
    },
    chat: baseChat({
      async capabilities() {
        chatReads += 1;
        if (outage) throw new Error("Chat capability offline");
        return {
          visionInput: true,
          visionMediaTypes: ["image/jpeg", "image/png"],
          maximumImageBytes: 4 * 1024 * 1024,
        };
      },
    }),
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_resume_outage_00001",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:resume-outage-image"; },
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "offline.png" }];
  imageInput.dispatch("change");
  await settleBrowserEvents(1);
  messageInput.value = draftText;

  outage = true;
  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents();
  assert.equal(agentReads, 4, "the failed Agent probe is bounded to three resume attempts");
  assert.equal(chatReads, 4, "the failed Chat probe is bounded to three resume attempts");
  assert.equal(messageInput.value, draftText);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:resume-outage-image");
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("remove-image").disabled, false);
  assert.deepEqual(revoked, []);
  assert.match(browser.document.getElementById("capability-note").textContent, /remain staged/iu);

  outage = false;
  browser.window.dispatch("online");
  await settleBrowserEvents();
  assert.equal(agentReads, 5, "online bypasses the recent-outage throttle for one recovery probe");
  assert.equal(chatReads, 5);
  assert.equal(messageInput.value, draftText);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.deepEqual(revoked, []);
});

test("authoritative Agent image downgrade retains the exact staged composer and cannot fall through to Chat", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let agentCapability = agentImageCapabilities();
  let agentStarts = 0;
  const revoked = [];
  const agent = {
    ...baseAgent(),
    async capabilities() { return agentCapability; },
    async createThread() { agentStarts += 1; throw new Error("must not dispatch"); },
  };
  const browser = harness({
    agent,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_agent_downgrade_001",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 80,
        height: 80,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:agent-downgrade-image"; },
    revokeObjectUrl(value) { revoked.push(value); },
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const messageInput = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "agent.png" }];
  imageInput.dispatch("change");
  await settleBrowserEvents(1);
  messageInput.value = "Do not lose or reroute this Agent image";

  agentCapability = capabilities();
  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents();
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(browser.document.getElementById("mode-switch").hidden, false,
    "an Agent outage keeps the visible Chat escape path beside the explicitly removable image");
  assert.equal(messageInput.value, "Do not lose or reroute this Agent image");
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:agent-downgrade-image");
  assert.equal(browser.document.getElementById("add-image").hidden, true);
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("remove-image").disabled, false);
  assert.deepEqual(revoked, []);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(agentStarts, 0);
  assert.equal(messageInput.value, "Do not lose or reroute this Agent image");
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.match(browser.document.getElementById("toast").textContent, /remain unsent/iu);
});

test("Agent Search capability refresh never rewrites an unsent selected mode or source limit", async () => {
  const withSearch = (modes, maximumSources) => capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
    search: { enabled: true, modes, maximumSources },
    artifacts: { kinds: ["plot", "table", "markdown", "sources"], schemaVersion: "1" },
  });
  let agentCapability = withSearch(["web", "papers", "both"], 20);
  const browser = harness({
    agent: {
      ...baseAgent(),
      async capabilities() { return agentCapability; },
    },
  });
  await browser.app.initialize();
  browser.document.getElementById("search-toggle").dispatch("click");
  browser.document.getElementById("search-mode").value = "web";
  browser.document.getElementById("search-limit").value = "8";
  browser.document.getElementById("message-input").value = "Preserve this exact Search request";

  agentCapability = withSearch(["papers"], 5);
  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents();
  assert.equal(browser.document.getElementById("search-mode").value, "web");
  assert.equal(browser.document.getElementById("search-limit").value, "8");
  assert.equal(browser.document.getElementById("message-input").value, "Preserve this exact Search request");
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("search-mode").disabled, false,
    "the user can explicitly select a newly supported mode instead of accepting a silent rewrite");
});

test("an active Agent mutation defers the whole resume refresh until its ownership fence is released", async () => {
  const createStarted = Promise.withResolvers();
  const createResult = Promise.withResolvers();
  let restoreReads = 0;
  let agentReads = 0;
  let chatReads = 0;
  let agentCapability = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
  });
  const agent = {
    ...baseAgent(),
    async capabilities() { agentReads += 1; return agentCapability; },
    async createThread() {
      createStarted.resolve();
      return await createResult.promise;
    },
    async startRun() {
      throw Object.assign(new Error("authoritative rejection"), { status: 409, retryable: false });
    },
  };
  const browser = harness({
    async restore() {
      restoreReads += 1;
      return { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" };
    },
    agent,
    chat: baseChat({
      async capabilities() {
        chatReads += 1;
        return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 };
      },
    }),
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Run this exact Agent task";
  const submitting = browser.app.submitMessage({ preventDefault() {} });
  await createStarted.promise;

  agentCapability = capabilities();
  browser.window.dispatch("pageshow", { persisted: true });
  await settleBrowserEvents(1);
  assert.equal(restoreReads, 1, "resume does not even read the session during the owned mutation");
  assert.equal(agentReads, 1);
  assert.equal(chatReads, 1);

  createResult.resolve({ thread: agentThread() });
  await submitting;
  await settleBrowserEvents();
  assert.equal(restoreReads, 2, "the deferred refresh runs once after the mutation settles");
  assert.equal(agentReads, 2);
  assert.equal(chatReads, 2);
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent",
    "capability refresh never reassigns the active conversation mode");
  assert.equal(browser.document.getElementById("message-input").value, "Run this exact Agent task");
});

test("an Agent mutation that begins during capability reads cannot throttle its required deferred refresh", async () => {
  const resumeCapabilityStarted = Promise.withResolvers();
  const resumeCapabilityResult = Promise.withResolvers();
  const createStarted = Promise.withResolvers();
  const createResult = Promise.withResolvers();
  let restoreReads = 0;
  let agentReads = 0;
  let chatReads = 0;
  const enabledCapability = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
  });
  const agent = {
    ...baseAgent(),
    async capabilities() {
      agentReads += 1;
      if (agentReads === 1) return enabledCapability;
      if (agentReads === 2) {
        resumeCapabilityStarted.resolve();
        return await resumeCapabilityResult.promise;
      }
      return capabilities();
    },
    async createThread() {
      createStarted.resolve();
      return await createResult.promise;
    },
    async startRun() {
      throw Object.assign(new Error("authoritative rejection"), { status: 409, retryable: false });
    },
  };
  const browser = harness({
    async restore() {
      restoreReads += 1;
      return { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" };
    },
    agent,
    chat: baseChat({
      async capabilities() {
        chatReads += 1;
        return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 };
      },
    }),
  });
  await browser.app.initialize();

  browser.window.dispatch("pageshow", { persisted: true });
  await resumeCapabilityStarted.promise;
  browser.document.getElementById("message-input").value = "Do not throttle the post-mutation refresh";
  const submitting = browser.app.submitMessage({ preventDefault() {} });
  await createStarted.promise;

  resumeCapabilityResult.resolve(capabilities());
  await settleBrowserEvents();
  assert.equal(agentReads, 2, "the in-flight result stays unapplied while the mutation owns Agent state");
  assert.equal(chatReads, 2);

  createResult.resolve({ thread: agentThread() });
  await submitting;
  await settleBrowserEvents();
  assert.equal(restoreReads, 3, "the session is revalidated again after the newly-started mutation settles");
  assert.equal(agentReads, 3, "an unapplied read never consumes the foreground capability throttle");
  assert.equal(chatReads, 3);
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(browser.document.getElementById("message-input").value,
    "Do not throttle the post-mutation refresh");
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.match(browser.document.getElementById("capability-note").textContent, /Agent unavailable/iu);
});

test("Agent multi-image input preserves an iPhone draft after rejection then accepts the same conversation", async () => {
  const history = await verifiedEvents([
    ["output.delta", { text: "Compared both images" }],
    ["run.completed", {}],
  ]);
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 8, 0, 0, 0, 0, 0xff, 0xd9, 0, 0, 0, 0]);
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const canonicalizations = [];
  const starts = [];
  const revoked = [];
  let objectUrlSerial = 0;
  let threadCreates = 0;
  const agent = {
    ...baseAgent(agentImageCapabilities()),
    async createThread() {
      threadCreates += 1;
      return { thread: agentThread() };
    },
    async startRun(threadId, text, options) {
      starts.push({
        threadId,
        text,
        options: {
          ...options,
          attachments: options.attachments?.map((attachment) => ({ ...attachment })),
        },
      });
      if (starts.length === 1) {
        throw Object.assign(new Error("image request rejected"), { status: 409, retryable: false });
      }
      return { run: run("running") };
    },
    async *streamRunEvents() {
      for (const event of history) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({
    agent,
    async canonicalizeImage(file, options) {
      canonicalizations.push({ file, options });
      const jpeg = file.name.endsWith(".HEIC");
      const bytes = jpeg ? jpegBytes : pngBytes;
      const mediaType = jpeg ? "image/jpeg" : "image/png";
      return Object.freeze({
        attachmentId: jpeg ? "image_iphone_0000000001" : "image_diagram_000000001",
        mediaType,
        byteLength: bytes.byteLength,
        width: jpeg ? 4032 : 640,
        height: jpeg ? 3024 : 480,
        bytes,
        previewBlob: new Blob([bytes], { type: mediaType }),
      });
    },
    createObjectUrl() { objectUrlSerial += 1; return `blob:agent-image-${objectUrlSerial}`; },
    revokeObjectUrl(url) { revoked.push(url); },
  });
  await browser.app.initialize();
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(browser.document.getElementById("add-image").hidden, false);
  assert.match(browser.document.getElementById("capability-note").textContent, /up to four images/u);

  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "IMG_1234.HEIC" }, { name: "diagram.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(canonicalizations.map(({ file }) => file.name), ["IMG_1234.HEIC", "diagram.png"]);
  assert.ok(canonicalizations.every(({ options }) => options.signal && options.timeoutMs === 15_000));
  assert.match(browser.document.getElementById("image-preview-label").textContent, /2 images/u);
  assert.equal(browser.document.getElementById("agent-mode").disabled, true,
    "a staged image draft cannot silently cross modes");

  const input = browser.document.getElementById("message-input");
  input.value = "Compare these two images";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(threadCreates, 1);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].options.attachments.map(({ attachmentId, mediaType, data }) => ({
    attachmentId, mediaType, bytes: [...Buffer.from(data, "base64")],
  })), [
    { attachmentId: "image_iphone_0000000001", mediaType: "image/jpeg", bytes: [...jpegBytes] },
    { attachmentId: "image_diagram_000000001", mediaType: "image/png", bytes: [...pngBytes] },
  ]);
  assert.equal(input.value, "Compare these two images");
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.match(browser.document.getElementById("toast").textContent, /image message was not sent[\s\S]*images are still ready/iu);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.deepEqual(revoked, [], "a definitive rejection retains the exact composer previews");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(threadCreates, 1, "the safe retry continues the already-created Agent conversation");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].options.idempotency, starts[1].options.idempotency);
  assert.deepEqual(
    starts[1].options.attachments.map(({ attachmentId, mediaType, data }) => ({ attachmentId, mediaType, data })),
    starts[0].options.attachments.map(({ attachmentId, mediaType, data }) => ({ attachmentId, mediaType, data })),
  );
  assert.equal(input.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.deepEqual(revoked, ["blob:agent-image-1", "blob:agent-image-2"]);
  assert.match(browser.document.getElementById("messages").textContent, /Compared both images/u);
  const userMessage = browser.document.getElementById("messages").children[0];
  assert.equal(userMessage.children[0].className, "message-attachments");
  assert.equal(userMessage.children[0].children.length, 2);
});

test("Agent empty Resume snapshots the retained-image marker and idempotency for a just-accepted image run", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  const completed = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID,
  });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const resumeCalls = [];
  const agent = {
    ...baseAgent(agentImageCapabilities()),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun(runId, text, options) {
      resumeCalls.push({ runId, text, options });
      if (resumeCalls.length === 1) {
        throw Object.assign(new Error("retained-image ACK was lost"), { retryable: true });
      }
      return { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
    },
    async *streamRunEvents({ runId }) {
      const event = runId === RUN_ID ? failed : completed;
      yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({
    agent,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_resume_000000001",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 640,
        height: 480,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:agent-image-resume"; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "resume.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Inspect this image";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "failed");
  assert.equal(browser.document.getElementById("resume-run").textContent, "Retry");

  await browser.app.resume();
  await browser.app.resume();
  assert.equal(resumeCalls.length, 2);
  assert.equal(resumeCalls.every(({ runId, text }) => runId === RUN_ID && text === undefined), true);
  assert.equal(resumeCalls.every(({ options }) => options.reuseAttachments === true), true);
  assert.equal(new Set(resumeCalls.map(({ options }) => options.idempotency)).size, 1,
    "an ambiguous retained-image retry keeps one exact mutation ticket");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Agent text follow-up inherits image context for its own empty retry", async () => {
  const events = new Map([
    [RUN_ID, await verifiedEvent({
      seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH, runId: RUN_ID,
    })],
    [SECOND_RUN_ID, await verifiedEvent({
      seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH, runId: SECOND_RUN_ID,
    })],
    [THIRD_RUN_ID, await verifiedEvent({
      seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH, runId: THIRD_RUN_ID,
    })],
  ]);
  const resumeCalls = [];
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const browser = harness({
    agent: {
      ...baseAgent(agentImageCapabilities()),
      async createThread() { return { thread: agentThread() }; },
      async startRun() { return { run: run("running") }; },
      async resumeRun(runId, text, options) {
        resumeCalls.push({ runId, text, options });
        return { run: run("running", {
          id: runId === RUN_ID ? SECOND_RUN_ID : THIRD_RUN_ID,
          previousRunId: runId,
        }) };
      },
      async *streamRunEvents({ runId }) {
        const event = events.get(runId);
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_inherited_0000001",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 640,
        height: 480,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:agent-image-inherited"; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "context.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  const input = browser.document.getElementById("message-input");
  input.value = "Inspect this image";
  await browser.app.submitMessage({ preventDefault() {} });
  input.value = "Now compare the important regions";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "failed");

  await browser.app.resume();
  assert.equal(resumeCalls.length, 2);
  assert.deepEqual(
    resumeCalls.map(({ runId, text }) => ({ runId, text })),
    [
      { runId: RUN_ID, text: "Now compare the important regions" },
      { runId: SECOND_RUN_ID, text: undefined },
    ],
  );
  assert.equal(Object.hasOwn(resumeCalls[0].options, "reuseAttachments"), false,
    "a normal text follow-up inherits server context without restaging or reuse transport");
  assert.equal(resumeCalls[1].options.reuseAttachments, true,
    "only the failed inherited run's input-less retry requests attachment reuse");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("corrected Agent Resume carries image context to a successor without reusing bytes", async () => {
  const events = new Map([
    [RUN_ID, await verifiedEvent({
      seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH, runId: RUN_ID,
    })],
    [SECOND_RUN_ID, await verifiedEvent({
      seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH, runId: SECOND_RUN_ID,
    })],
    [THIRD_RUN_ID, await verifiedEvent({
      seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH, runId: THIRD_RUN_ID,
    })],
  ]);
  const resumeCalls = [];
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const browser = harness({
    agent: {
      ...baseAgent(agentImageCapabilities()),
      async createThread() { return { thread: agentThread() }; },
      async startRun() { return { run: run("running") }; },
      async resumeRun(runId, text, options) {
        resumeCalls.push({ runId, text, options });
        return { run: run("running", {
          id: runId === RUN_ID ? SECOND_RUN_ID : THIRD_RUN_ID,
          previousRunId: runId,
        }) };
      },
      async *streamRunEvents({ runId }) {
        const event = events.get(runId);
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_corrected_0000001",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 640,
        height: 480,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl() { return "blob:agent-image-corrected"; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "correct.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  const input = browser.document.getElementById("message-input");
  input.value = "Inspect this image";
  await browser.app.submitMessage({ preventDefault() {} });
  input.value = "Use the upper-left region instead";
  await browser.app.resume();
  assert.equal(browser.document.getElementById("workspace").dataset.status, "failed");
  await browser.app.resume();

  assert.deepEqual(
    resumeCalls.map(({ runId, text }) => ({ runId, text })),
    [
      { runId: RUN_ID, text: "Use the upper-left region instead" },
      { runId: SECOND_RUN_ID, text: undefined },
    ],
  );
  assert.equal(Object.hasOwn(resumeCalls[0].options, "reuseAttachments"), false);
  assert.equal(resumeCalls[1].options.reuseAttachments, true);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("hydrated active image context survives pruned descriptors only for the proven head", async () => {
  const failed = await verifiedEvent({
    seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH, runId: SECOND_RUN_ID,
  });
  const completed = await verifiedEvent({
    seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH, runId: THIRD_RUN_ID,
  });
  const thread = agentThread({
    lastRunId: SECOND_RUN_ID,
    activeImageContext: true,
    replay: { prunedMessageCount: 2, anchorDigest: "c".repeat(64) },
    messages: [
      { id: "msg_pruned_image_context", role: "user", content: "Continue from the retained image", runId: SECOND_RUN_ID },
    ],
  });
  let resumeOptions;
  const browser = harness({
    agent: {
      ...baseAgent(agentImageCapabilities()),
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { thread }; },
      async runStatus() {
        return { run: terminalRun("failed", [failed], {
          id: SECOND_RUN_ID,
          previousRunId: RUN_ID,
        }) };
      },
      async resumeRun(runId, text, options) {
        resumeOptions = options;
        assert.equal(runId, SECOND_RUN_ID);
        assert.equal(text, undefined);
        return { run: run("running", { id: THIRD_RUN_ID, previousRunId: SECOND_RUN_ID }) };
      },
      async *streamRunEvents({ runId }) {
        const event = runId === SECOND_RUN_ID ? failed : completed;
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
  });
  await browser.app.initialize();
  assert.equal(thread.messages.some((message) => message.attachments !== undefined), false,
    "the retained image descriptors are outside this replay suffix");
  await browser.app.resume();
  assert.equal(resumeOptions.reuseAttachments, true);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("absent or false Agent image-context proof never enables empty Resume reuse", async () => {
  for (const activeImageContext of [undefined, false]) {
    const failed = await verifiedEvent({
      seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH, runId: RUN_ID,
    });
    const completed = await verifiedEvent({
      seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH, runId: SECOND_RUN_ID,
    });
    const thread = agentThread({
      lastRunId: RUN_ID,
      ...(activeImageContext === undefined ? {} : { activeImageContext }),
      messages: [
        { id: "msg_inactive_context_head", role: "user", content: "A plain failed task", runId: RUN_ID },
      ],
    });
    let resumeOptions;
    const browser = harness({
      agent: {
        ...baseAgent(agentImageCapabilities()),
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread() { return { thread }; },
        async runStatus() { return { run: terminalRun("failed", [failed]) }; },
        async resumeRun(runId, text, options) {
          resumeOptions = options;
          return { run: run("running", { id: SECOND_RUN_ID, previousRunId: runId }) };
        },
        async *streamRunEvents({ runId }) {
          const event = runId === RUN_ID ? failed : completed;
          yield { event, cursor: { seq: event.seq, hash: event.hash } };
        },
      },
    });
    await browser.app.initialize();
    await browser.app.resume();
    assert.equal(Object.hasOwn(resumeOptions, "reuseAttachments"), false,
      `${activeImageContext === undefined ? "absent" : "false"} proof remains fail closed`);
  }
});

test("Agent image context does not leak when another thread becomes the view owner", async () => {
  const firstCompleted = await verifiedEvent({
    seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH, runId: RUN_ID,
  });
  const secondFailed = await verifiedEvent({
    seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID, threadId: OTHER_THREAD_ID,
  });
  const resumedCompleted = await verifiedEvent({
    seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH,
    runId: THIRD_RUN_ID, threadId: OTHER_THREAD_ID,
  });
  const imageThread = agentThread({
    activeImageContext: true,
    lastRunId: RUN_ID,
    messages: [
      { id: "msg_image_owner_thread", role: "user", content: "Image context owner", runId: RUN_ID },
    ],
  });
  const plainThread = agentThread({
    id: OTHER_THREAD_ID,
    title: "Plain thread",
    lastRunId: SECOND_RUN_ID,
    messages: [
      { id: "msg_plain_other_thread", role: "user", content: "Plain failed task", runId: SECOND_RUN_ID },
    ],
  });
  let resumeOptions;
  const browser = harness({
    agent: {
      ...baseAgent(agentImageCapabilities()),
      async listThreads() {
        return { schemaVersion: "1", threads: [imageThread, plainThread], nextBefore: null };
      },
      async getThread(threadId) {
        return { thread: threadId === THREAD_ID ? imageThread : plainThread };
      },
      async runStatus(runId) {
        return runId === RUN_ID
          ? { run: terminalRun("completed", [firstCompleted]) }
          : { run: terminalRun("failed", [secondFailed], {
              id: SECOND_RUN_ID,
              threadId: OTHER_THREAD_ID,
              previousRunId: null,
            }) };
      },
      async resumeRun(runId, text, options) {
        resumeOptions = options;
        return { run: run("running", {
          id: THIRD_RUN_ID,
          threadId: OTHER_THREAD_ID,
          previousRunId: runId,
        }) };
      },
      async *streamRunEvents({ runId }) {
        const event = runId === RUN_ID
          ? firstCompleted
          : (runId === SECOND_RUN_ID ? secondFailed : resumedCompleted);
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
  });
  await browser.app.initialize();
  await browser.app.openThread(OTHER_THREAD_ID);
  await browser.app.resume();
  assert.equal(Object.hasOwn(resumeOptions, "reuseAttachments"), false);
});

test("Agent history replays retained image descriptors without browser bytes or a Chat attachment read", async () => {
  const history = await verifiedEvents([
    ["output.delta", { text: "Stored description" }],
    ["run.completed", {}],
  ]);
  const descriptor = {
    attachmentId: "image_retained_00000001",
    mediaType: "image/jpeg",
    byteLength: 12_345,
    width: 1_920,
    height: 1_080,
    sha256: "c".repeat(64),
  };
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [
      { id: "msg_agent_image_user_01", role: "user", content: "Describe this image", runId: RUN_ID, attachments: [descriptor] },
      { id: "msg_agent_image_answer1", role: "assistant", content: "Stored description", runId: RUN_ID },
    ],
  });
  let chatAttachmentReads = 0;
  const browser = harness({
    agent: {
      ...baseAgent(agentImageCapabilities()),
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { thread }; },
      async runStatus() { return { run: terminalRun("completed", history) }; },
      async *streamRunEvents() {
        for (const event of history) yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
    chat: baseChat({
      async getAttachment() { chatAttachmentReads += 1; throw new Error("Agent replay must not use Chat storage"); },
    }),
    createObjectUrl() { throw new Error("retained Agent descriptors do not expose browser image bytes"); },
  });
  await browser.app.initialize();

  assert.equal(chatAttachmentReads, 0);
  assert.match(browser.document.getElementById("messages").textContent,
    /Image retained by Agent · JPEG · 1920×1080[\s\S]*Stored description/u);
  const userMessage = browser.document.getElementById("messages").children[0];
  assert.equal(userMessage.dataset.attachmentState, "retained");
  assert.equal(userMessage.children[0].className, "message-attachment-retained");
});

test("Chat and Agent thread hydration both open at the newest message", async () => {
  const messages = [
    chatMessage(1, "user", "Older Chat turn"),
    chatMessage(2, "assistant", "Newest Chat answer"),
  ];
  const storedChatThread = chatThread({
    title: "Hydrated Chat",
    revision: 2,
    ledgerHash: CHAT_HASH_B,
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const chatBrowser = harness({
    chat: baseChat({
      async listThreads() { return { threads: [storedChatThread] }; },
      async getThread() { return { thread: storedChatThread }; },
      async listMessages({ afterRevision, limit }) {
        return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
      },
    }),
  });
  const chatScroll = chatBrowser.document.getElementById("chat-scroll");
  chatScroll.scrollHeight = 1_600;
  chatScroll.clientHeight = 420;
  await chatBrowser.app.initialize();
  assert.equal(chatScroll.scrollTop, 1_600);
  assert.equal(chatBrowser.document.getElementById("go-to-bottom").hidden, true);
  assert.match(chatBrowser.document.getElementById("messages").textContent, /Newest Chat answer/u);

  const history = await verifiedEvents([
    ["output.delta", { text: "Newest Agent answer" }],
    ["run.completed", {}],
  ]);
  const storedAgentThread = agentThread({
    lastRunId: RUN_ID,
    messages: [
      { id: "msg_user_hydration", role: "user", content: "Older Agent turn", runId: RUN_ID },
      { id: "msg_assistant_hydration", role: "assistant", content: "Stored Agent answer", runId: RUN_ID },
    ],
  });
  const agentBrowser = harness({
    agent: {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async listThreads() { return { schemaVersion: "1", threads: [storedAgentThread], nextBefore: null }; },
      async getThread() { return { thread: storedAgentThread }; },
      async runStatus() { return { run: terminalRun("completed", history) }; },
      async *streamRunEvents() {
        for (const event of history) yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
  });
  const agentScroll = agentBrowser.document.getElementById("chat-scroll");
  agentScroll.scrollHeight = 2_100;
  agentScroll.clientHeight = 420;
  await agentBrowser.app.initialize();
  assert.equal(agentScroll.scrollTop, 2_100);
  assert.equal(agentBrowser.document.getElementById("go-to-bottom").hidden, true);
  assert.match(agentBrowser.document.getElementById("messages").textContent, /Newest Agent answer/u);
});

test("Agent streaming follows only a reader already near bottom and the control restores newest position", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "First streamed part" }],
    ["output.delta", { text: " and second streamed part" }],
    ["run.completed", {}],
  ]);
  const firstApplied = Promise.withResolvers();
  const continueStream = Promise.withResolvers();
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Scroll behavior" } }; },
    async startRun() { return { run: run() }; },
    async *streamRunEvents() {
      yield { event: events[0], cursor: { seq: events[0].seq, hash: events[0].hash } };
      firstApplied.resolve();
      await continueStream.promise;
      yield { event: events[1], cursor: { seq: events[1].seq, hash: events[1].hash } };
      yield { event: events[2], cursor: { seq: events[2].seq, hash: events[2].hash } };
    },
  };
  const browser = harness({ agent });
  const scroll = browser.document.getElementById("chat-scroll");
  scroll.scrollHeight = 1_000;
  scroll.clientHeight = 300;
  scroll.scrollTop = 700;
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Stream while I read";
  const sending = browser.app.submitMessage({ preventDefault() {} });
  await firstApplied.promise;
  assert.equal(scroll.scrollTop, 1_000, "a reader at the newest message follows the first delta");

  scroll.scrollHeight = 1_500;
  scroll.scrollTop = 180;
  scroll.dispatch("scroll");
  assert.equal(browser.document.getElementById("go-to-bottom").hidden, false);
  continueStream.resolve();
  await sending;
  assert.equal(scroll.scrollTop, 180, "later deltas do not yank a reader who scrolled up");
  assert.equal(browser.document.getElementById("go-to-bottom").hidden, false);

  browser.document.getElementById("go-to-bottom").dispatch("click");
  assert.equal(scroll.scrollTop, 1_500);
  assert.equal(scroll.scrollCalls.at(-1).behavior, "smooth");
  assert.equal(browser.document.getElementById("go-to-bottom").hidden, true);
});

test("a newest-message animation frame is fenced when its conversation view is replaced", async () => {
  const frames = [];
  const history = await verifiedEvents([["run.completed", {}]]);
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [{ id: "msg_user_frame_fence", role: "user", content: "Old view", runId: RUN_ID }],
  });
  const browser = harness({
    requestAnimationFrame(callback) { frames.push(callback); },
    agent: {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { thread }; },
      async runStatus() { return { run: terminalRun("completed", history) }; },
      async *streamRunEvents() {
        for (const event of history) yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    },
  });
  const scroll = browser.document.getElementById("chat-scroll");
  scroll.scrollHeight = 1_200;
  scroll.clientHeight = 300;
  await browser.app.initialize();
  assert.ok(frames.length > 0);
  browser.document.getElementById("new-thread").dispatch("click");
  for (const frame of frames.splice(0)) frame();
  assert.equal(scroll.scrollCalls.length, 0, "frames owned by the replaced view cannot scroll the new conversation");
  assert.equal(browser.document.getElementById("messages").children.length, 0);
});

test("a new Agent send clears completed activity before dispatch confirmation", async () => {
  const terminal = await verifiedEvent({
    seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH,
  });
  const accepted = Promise.withResolvers();
  const observed = Promise.withResolvers();
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() {
      observed.resolve();
      return await accepted.promise;
    },
    async *streamRunEvents() {
      yield { event: terminal, cursor: { seq: terminal.seq, hash: terminal.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  const plan = browser.document.getElementById("agent-plan");
  const timeline = browser.document.getElementById("agent-timeline");
  const artifacts = browser.document.getElementById("agent-artifacts");
  for (const [target, text] of [[plan, "Old completed plan"], [timeline, "Old completed tool"]]) {
    const item = browser.document.createElement("li");
    item.textContent = text;
    target.appendChild(item);
  }
  const oldArtifact = browser.document.createElement("section");
  oldArtifact.textContent = "Old completed artifact";
  artifacts.appendChild(oldArtifact);
  artifacts.hidden = false;
  browser.document.getElementById("run-state").textContent = "Completed";
  browser.document.getElementById("workspace").dataset.status = "completed";
  browser.document.getElementById("activity-disclosure").open = true;
  browser.document.getElementById("message-input").value = "Start a clean current activity view";

  const sending = browser.app.submitMessage({ preventDefault() {} });
  await observed.promise;
  assert.equal(plan.children.length, 0);
  assert.equal(timeline.children.length, 0);
  assert.equal(artifacts.children.length, 0);
  assert.equal(artifacts.hidden, true);
  assert.equal(browser.document.getElementById("activity-disclosure").open, false);
  assert.equal(browser.document.getElementById("run-state").textContent, "Starting");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "running");

  accepted.resolve({ run: run() });
  await sending;
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
});

test("replacing a conversation restores compact activity and follows the first new Agent turn", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "New conversation answer" }],
    ["run.completed", {}],
  ]);
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread({ title: "Replacement conversation" }) }; },
    async startRun() { return { run: run() }; },
    async *streamRunEvents() {
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  const scroll = browser.document.getElementById("chat-scroll");
  await browser.app.initialize();
  const oldMessage = browser.document.createElement("article");
  oldMessage.textContent = "Old conversation content";
  browser.document.getElementById("messages").appendChild(oldMessage);
  scroll.scrollHeight = 1_200;
  scroll.clientHeight = 300;
  scroll.scrollTop = 100;
  scroll.dispatch("scroll");
  assert.equal(browser.document.getElementById("go-to-bottom").hidden, false);
  browser.document.getElementById("activity-disclosure").open = true;

  browser.document.getElementById("new-thread").dispatch("click");
  assert.equal(browser.document.getElementById("activity-disclosure").open, false);
  assert.equal(browser.document.getElementById("go-to-bottom").hidden, true);

  scroll.scrollHeight = 1_800;
  browser.document.getElementById("message-input").value = "Start at the newest message";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(scroll.scrollTop, 1_800);
  assert.equal(browser.document.getElementById("go-to-bottom").hidden, true);
  assert.match(browser.document.getElementById("messages").textContent, /New conversation answer/u);
});

test("negotiated Agent Search binds one immutable selection to one start mutation", async () => {
  const completed = await verifiedEvent({ seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH });
  const accepted = Promise.withResolvers();
  const observed = Promise.withResolvers();
  const starts = [];
  const capability = capabilities({
    enabled: true,
    actions: { cancel: true, resume: true, retry: false },
    search: { enabled: true, modes: ["web", "papers", "both"], maximumSources: 12 },
    artifacts: { kinds: ["plot", "table", "markdown", "sources"], schemaVersion: "1" },
  });
  const agent = {
    ...baseAgent(capability),
    async createThread() { return { thread: agentThread() }; },
    async startRun(threadId, text, options) {
      starts.push({ threadId, text, options });
      observed.resolve();
      return await accepted.promise;
    },
    async *streamRunEvents() {
      yield { event: completed, cursor: { seq: completed.seq, hash: completed.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  const controls = browser.document.getElementById("search-controls");
  const toggle = browser.document.getElementById("search-toggle");
  const options = browser.document.getElementById("search-options");
  const mode = browser.document.getElementById("search-mode");
  const limit = browser.document.getElementById("search-limit");
  assert.equal(controls.hidden, false);
  assert.equal(options.hidden, true);
  assert.equal(mode.value, "web");
  assert.equal(limit.value, "8");
  assert.equal(limit.max, "12");
  toggle.dispatch("click");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(options.hidden, false);
  mode.value = "both";
  limit.value = "7";
  browser.document.getElementById("message-input").value = "Compare current evidence";
  const sending = browser.app.submitMessage({ preventDefault() {} });
  await observed.promise;
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].options.search, { mode: "both", limit: 7 });
  assert.equal(Object.isFrozen(starts[0].options.search), true);
  assert.match(starts[0].options.idempotency, /^agent_start_/u);
  mode.value = "papers";
  limit.value = "20";
  assert.deepEqual(starts[0].options.search, { mode: "both", limit: 7 }, "DOM changes cannot alter the dispatched ticket");
  accepted.resolve({ run: run() });
  await sending;
  assert.equal(starts.length, 1);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(options.hidden, true);
  toggle.dispatch("click");
  mode.value = "web";
  limit.value = "20";
  const rejectedDraft = "Do not dispatch beyond the capability";
  browser.document.getElementById("message-input").value = rejectedDraft;
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(starts.length, 1);
  assert.equal(browser.document.getElementById("message-input").value, rejectedDraft);
  assert.match(browser.document.getElementById("toast").textContent, /valid Search mode and source limit/u);
});

test("a completed Agent thread continues for three turns through exact resume successors across reload", async () => {
  const prompts = ["Calculate the values", "Now explain the result", "Compare it with the first answer"];
  const runIds = [RUN_ID, SECOND_RUN_ID, THIRD_RUN_ID];
  const histories = new Map();
  for (let index = 0; index < runIds.length; index += 1) {
    histories.set(runIds[index], await verifiedEvents([
      ["output.delta", { text: `Answer ${index + 1}` }],
      ["run.completed", {}],
    ], { runId: runIds[index] }));
  }
  const acceptedTurns = [];
  const starts = [];
  const resumes = [];
  let thread = null;
  const persistAcceptedTurn = (runId, prompt) => {
    acceptedTurns.push({ runId, prompt });
    thread = agentThread({
      title: "Agent calculation",
      lastRunId: runId,
      messages: acceptedTurns.flatMap((turn, index) => [
        { id: `msg_user_multiturn_${index}`, role: "user", content: turn.prompt, runId: turn.runId },
        { id: `msg_assistant_multiturn_${index}`, role: "assistant", content: `Stored answer ${index + 1}`, runId: turn.runId },
      ]),
    });
  };
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: thread ? [thread] : [], nextBefore: null }; },
    async createThread(_body, options) {
      assert.match(options.idempotency, /^agent_thread_[A-Za-z0-9._~-]+$/u);
      thread = agentThread();
      return { thread };
    },
    async getThread(threadId) {
      assert.equal(threadId, THREAD_ID);
      return { thread };
    },
    async startRun(threadId, text, options) {
      starts.push({ threadId, text, options });
      assert.equal(thread.lastRunId, null, "runs/start is reserved for a pristine Agent thread");
      persistAcceptedTurn(RUN_ID, text);
      return { run: run("running", { id: RUN_ID, previousRunId: null }) };
    },
    async resumeRun(previousRunId, text, options) {
      const nextIndex = resumes.length + 1;
      const nextRunId = runIds[nextIndex];
      resumes.push({ previousRunId, text, options });
      assert.equal(previousRunId, runIds[nextIndex - 1]);
      assert.equal(thread.lastRunId, previousRunId, "runs/resume extends only the exact durable head");
      persistAcceptedTurn(nextRunId, text);
      return { run: run("running", { id: nextRunId, previousRunId }) };
    },
    async runStatus(runId) {
      return { run: terminalRun("completed", histories.get(runId), { id: runId }) };
    },
    async *streamRunEvents({ runId }) {
      for (const event of histories.get(runId)) {
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      }
    },
  };

  const firstBrowser = harness({ agent });
  await firstBrowser.app.initialize();
  for (const prompt of prompts.slice(0, 2)) {
    firstBrowser.document.getElementById("message-input").value = prompt;
    await firstBrowser.app.submitMessage({ preventDefault() {} });
    assert.equal(firstBrowser.document.getElementById("workspace").dataset.status, "completed");
    assert.equal(firstBrowser.document.getElementById("message-input").disabled, false);
  }
  assert.equal(starts.length, 1);
  assert.equal(resumes.length, 1);
  assert.match(starts[0].options.idempotency, /^agent_start_[A-Za-z0-9._~-]+$/u);
  assert.match(resumes[0].options.idempotency, /^agent_followup_[A-Za-z0-9._~-]+$/u);
  assert.deepEqual(
    [starts[0].text, resumes[0].text],
    prompts.slice(0, 2),
    "the visible second prompt becomes the exact optional resume input text",
  );

  const reloaded = harness({ agent });
  await reloaded.app.initialize();
  assert.equal(reloaded.document.getElementById("workspace").dataset.status, "completed");
  assert.match(reloaded.document.getElementById("messages").textContent, /Answer 1/u);
  assert.match(reloaded.document.getElementById("messages").textContent, /Answer 2/u);
  reloaded.document.getElementById("message-input").value = prompts[2];
  await reloaded.app.submitMessage({ preventDefault() {} });

  assert.equal(starts.length, 1, "a completed thread is never restarted as a pristine run");
  assert.deepEqual(resumes.map(({ previousRunId, text }) => ({ previousRunId, text })), [
    { previousRunId: RUN_ID, text: prompts[1] },
    { previousRunId: SECOND_RUN_ID, text: prompts[2] },
  ]);
  assert.match(resumes[1].options.idempotency, /^agent_followup_[A-Za-z0-9._~-]+$/u);
  assert.notEqual(resumes[0].options.idempotency, resumes[1].options.idempotency);
  assert.equal(thread.lastRunId, THIRD_RUN_ID);
  assert.equal(reloaded.document.getElementById("workspace").dataset.status, "completed");
  assert.match(reloaded.document.getElementById("messages").textContent, /Answer 3/u);
});

test("Agent follow-up retry reuses one idempotency key and an unconfirmed prompt remains editable", async () => {
  const firstHistory = await verifiedEvents([["run.completed", {}]]);
  const secondHistory = await verifiedEvents([
    ["output.delta", { text: "Confirmed follow-up" }],
    ["run.completed", {}],
  ], { runId: SECOND_RUN_ID });
  const thirdHistory = await verifiedEvents([
    ["output.delta", { text: "Accepted after definitive rejection" }],
    ["run.completed", {}],
  ], { runId: THIRD_RUN_ID });
  const histories = new Map([
    [RUN_ID, firstHistory],
    [SECOND_RUN_ID, secondHistory],
    [THIRD_RUN_ID, thirdHistory],
  ]);
  let thread = agentThread({
    lastRunId: RUN_ID,
    messages: [
      { id: "msg_user_retry_0", role: "user", content: "First turn", runId: RUN_ID },
      { id: "msg_assistant_retry_0", role: "assistant", content: "Stored first answer", runId: RUN_ID },
    ],
  });
  const resumeCalls = [];
  const statusReads = [];
  const streamReads = [];
  const waits = [];
  let threadReads = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { threadReads += 1; return { thread }; },
    async runStatus(runId) {
      statusReads.push(runId);
      const events = histories.get(runId);
      return { run: terminalRun("completed", events, {
        id: runId,
        previousRunId: runId === RUN_ID ? null : (runId === SECOND_RUN_ID ? RUN_ID : SECOND_RUN_ID),
      }) };
    },
    async startRun() { throw new Error("a retained thread must not dispatch runs/start"); },
    async resumeRun(previousRunId, text, options) {
      resumeCalls.push({ previousRunId, text, options });
      if (resumeCalls.length === 1) {
        throw Object.assign(new Error("response lost after dispatch"), { retryable: true });
      }
      if (resumeCalls.length === 2) {
        thread = agentThread({
          lastRunId: SECOND_RUN_ID,
          messages: [
            { id: "msg_user_retry_0", role: "user", content: "First turn", runId: RUN_ID },
            { id: "msg_assistant_retry_0", role: "assistant", content: "Stored first answer", runId: RUN_ID },
            { id: "msg_user_retry_1", role: "user", content: text, runId: SECOND_RUN_ID },
            { id: "msg_assistant_retry_1", role: "assistant", content: "Stored follow-up", runId: SECOND_RUN_ID },
          ],
        });
        return { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
      }
      if (resumeCalls.length === 3) {
        throw Object.assign(new Error("request rejected"), {
          retryable: false,
          status: 409,
        });
      }
      thread = agentThread({
        lastRunId: THIRD_RUN_ID,
        messages: [
          ...thread.messages,
          { id: "msg_user_retry_2", role: "user", content: text, runId: THIRD_RUN_ID },
          { id: "msg_assistant_retry_2", role: "assistant", content: "Stored retry", runId: THIRD_RUN_ID },
        ],
      });
      return { run: run("running", { id: THIRD_RUN_ID, previousRunId: SECOND_RUN_ID }) };
    },
    async *streamRunEvents({ runId }) {
      streamReads.push(runId);
      const events = histories.get(runId);
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({
    agent,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  assert.equal(threadReads, 1);

  browser.document.getElementById("message-input").value = "Retry this exact follow-up";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.deepEqual(waits, [250]);
  assert.equal(resumeCalls.length, 2);
  assert.equal(resumeCalls[0].options.idempotency, resumeCalls[1].options.idempotency);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  const messages = browser.document.getElementById("messages");
  assert.match(messages.textContent, /Confirmed follow-up/u);
  assert.equal(
    messages.textContent.split("Retry this exact follow-up").length - 1,
    1,
    "a same-key transport retry renders its accepted user turn exactly once",
  );

  const rejectedDraft = "Keep this unconfirmed follow-up editable";
  browser.document.getElementById("message-input").value = rejectedDraft;
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(resumeCalls.length, 3, "a definitive rejection is not retried");
  assert.equal(browser.document.getElementById("message-input").value, rejectedDraft);
  assert.equal(browser.document.getElementById("message-input").disabled, false);
  assert.equal(messages.textContent.includes(rejectedDraft), false, "an unaccepted prompt never becomes conversation history");
  assert.match(browser.document.getElementById("toast").textContent, /prompt is still ready/u);
  assert.equal(browser.document.getElementById("send-message").disabled, false,
    "a definitive non-acceptance keeps the same verified thread immediately usable");
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");

  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(threadReads, 1, "a definitive non-acceptance needs no forced thread reopen");
  assert.deepEqual(statusReads, [RUN_ID]);
  assert.deepEqual(streamReads, [RUN_ID, SECOND_RUN_ID, THIRD_RUN_ID]);
  assert.equal(resumeCalls.length, 4);
  assert.notEqual(resumeCalls[2].options.idempotency, resumeCalls[3].options.idempotency,
    "the safe user retry creates a new exact mutation receipt");
  assert.equal(browser.document.getElementById("message-input").value, "");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.match(browser.document.getElementById("messages").textContent, /Accepted after definitive rejection/u);
});

test("an existing Agent continuation honors rollout delay and a repeated rollout stays immediately retryable", async () => {
  const histories = new Map([
    [RUN_ID, await verifiedEvents([["run.completed", {}]])],
    [SECOND_RUN_ID, await verifiedEvents([
      ["output.delta", { text: "Accepted after rollout" }],
      ["run.completed", {}],
    ], { runId: SECOND_RUN_ID })],
    [THIRD_RUN_ID, await verifiedEvents([
      ["output.delta", { text: "Accepted on the next send" }],
      ["run.completed", {}],
    ], { runId: THIRD_RUN_ID })],
  ]);
  let thread = agentThread({
    lastRunId: RUN_ID,
    messages: [
      { id: "msg_rollout_user_0001", role: "user", content: "Initial", runId: RUN_ID },
      { id: "msg_rollout_answer_001", role: "assistant", content: "Initial answer", runId: RUN_ID },
    ],
  });
  const calls = [];
  const waits = [];
  const accept = (runId, previousRunId, text) => {
    thread = agentThread({
      lastRunId: runId,
      messages: [
        ...thread.messages,
        { id: `msg_rollout_user_${calls.length}xxxx`, role: "user", content: text, runId },
        { id: `msg_rollout_answer_${calls.length}xx`, role: "assistant", content: "Stored", runId },
      ],
    });
    return { run: run("running", { id: runId, previousRunId }) };
  };
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async runStatus(runId) {
      return { run: terminalRun("completed", histories.get(runId), { id: runId }) };
    },
    async startRun() { throw new Error("an existing Agent thread must use resume"); },
    async resumeRun(previousRunId, text, options) {
      calls.push({ previousRunId, text, options });
      if (calls.length === 1) throw rolloutAgentError(2_000);
      if (calls.length === 2) return accept(SECOND_RUN_ID, RUN_ID, text);
      if (calls.length === 3) throw rolloutAgentError(1_000);
      if (calls.length === 4) throw rolloutAgentError(4_000);
      return accept(THIRD_RUN_ID, SECOND_RUN_ID, text);
    },
    async *streamRunEvents({ runId }) {
      for (const event of histories.get(runId)) {
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      }
    },
  };
  const browser = harness({ agent, wait: async (milliseconds) => { waits.push(milliseconds); } });
  await browser.app.initialize();

  browser.document.getElementById("message-input").value = "Continue after rollout";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.deepEqual(waits, [2_000]);
  assert.equal(calls[0].options.idempotency, calls[1].options.idempotency);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");

  const retainedDraft = "Keep this continuation ready";
  browser.document.getElementById("message-input").value = retainedDraft;
  await browser.app.submitMessage({ preventDefault() {} });
  assert.deepEqual(waits, [2_000, 1_000], "only the first rollout response schedules one retry");
  assert.equal(calls.length, 4);
  assert.equal(calls[2].options.idempotency, calls[3].options.idempotency);
  assert.equal(browser.document.getElementById("message-input").value, retainedDraft);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.notEqual(browser.document.getElementById("run-state").textContent, "Interrupted");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("toast").textContent, /update is finishing[\s\S]*retry shortly/iu);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(calls.length, 5, "the next same-thread send is not fenced by the rollout");
  assert.equal(calls[4].previousRunId, SECOND_RUN_ID);
  assert.notEqual(calls[4].options.idempotency, calls[3].options.idempotency);
  assert.equal(browser.document.getElementById("message-input").value, "");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.match(browser.document.getElementById("messages").textContent, /Accepted on the next send/u);
});

test("a new Agent thread survives repeated rollout rejection without a pending-create or Interrupted fence", async () => {
  const completed = await verifiedEvents([
    ["output.delta", { text: "New thread accepted" }],
    ["run.completed", {}],
  ]);
  let thread = null;
  let creates = 0;
  const starts = [];
  const waits = [];
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() {
      return { schemaVersion: "1", threads: thread === null ? [] : [thread], nextBefore: null };
    },
    async createThread() {
      creates += 1;
      thread = agentThread();
      return { thread };
    },
    async startRun(threadId, text, options) {
      starts.push({ threadId, text, options });
      if (starts.length <= 2) throw rolloutAgentError(starts.length === 1 ? 3_000 : 5_000);
      if (starts.length === 3) throw rolloutAgentError(2_000);
      return { run: run("running") };
    },
    async *streamRunEvents() {
      for (const event of completed) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent, wait: async (milliseconds) => { waits.push(milliseconds); } });
  await browser.app.initialize();
  const input = browser.document.getElementById("message-input");
  input.value = "Create this Agent conversation";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(creates, 1);
  assert.equal(starts.length, 2);
  assert.deepEqual(waits, [3_000]);
  assert.equal(input.value, "Create this Agent conversation");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "idle");
  assert.equal(browser.document.getElementById("run-state").textContent, "Idle");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(creates, 1, "the already-created empty thread remains usable");
  assert.equal(starts.length, 4);
  assert.deepEqual(waits, [3_000, 2_000]);
  assert.notEqual(starts[2].options.idempotency, starts[1].options.idempotency);
  assert.equal(starts[2].options.idempotency, starts[3].options.idempotency);
  assert.equal(input.value, "");
  assert.match(browser.document.getElementById("messages").textContent, /New thread accepted/u);
});

test("an ambiguous Agent thread create survives later rollout and release fences with one exact ticket", async () => {
  const completed = await verifiedEvents([["run.completed", {}]]);
  const calls = [];
  const waits = [];
  let starts = 0;
  const thread = agentThread();
  const firstAmbiguity = Object.assign(new Error("accepted create response was lost"), { retryable: true });
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread(body, options) {
      calls.push({ body, options });
      if (calls.length === 1) throw firstAmbiguity;
      if (calls.length <= 4) throw rolloutAgentError(1_000);
      if (calls.length === 5) {
        throw new AgintiTransportError("new release is binding", {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: `release-${"f".repeat(64)}`,
        });
      }
      return { thread };
    },
    async startRun() { starts += 1; return { run: run("running") }; },
    async *streamRunEvents() {
      for (const event of completed) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent, wait: async (milliseconds) => { waits.push(milliseconds); } });
  let reloads = 0;
  browser.window.location.reload = () => { reloads += 1; };
  await browser.app.initialize();
  const input = browser.document.getElementById("message-input");
  input.value = "Preserve this exact Agent create";

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(starts, 0);
  assert.match(browser.document.getElementById("toast").textContent, /same exact conversation/u);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(calls.length, 4, "a closed retry receives only the bounded exact-ticket retry");
  assert.deepEqual(waits, [250, 1_000]);
  assert.equal(starts, 0);
  assert.match(browser.document.getElementById("toast").textContent, /same exact conversation/u);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(calls.length, 5);
  assert.equal(reloads, 0, "a later release fence cannot erase an earlier ambiguous create receipt");
  assert.equal(starts, 0);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls.map(({ options }) => options.idempotency)).size, 1);
  assert.deepEqual(calls.map(({ body }) => body), calls.map(() => calls[0].body));
  assert.equal(starts, 1);
  assert.equal(input.value, "");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("an ambiguous Agent run followed by rollout remains fenced until read-only reopen confirms it", async () => {
  const history = await verifiedEvents([
    ["output.delta", { text: "Confirmed without a new mutation key" }],
    ["run.completed", {}],
  ]);
  let thread = agentThread();
  const starts = [];
  const waits = [];
  const prompt = "Run this exact accepted Agent task";
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async startRun(threadId, text, options) {
      starts.push({ threadId, text, options });
      if (starts.length === 1) {
        thread = agentThread({
          lastRunId: RUN_ID,
          messages: [
            { id: "msg_agent_ambiguous_user", role: "user", content: text, runId: RUN_ID },
            { id: "msg_agent_ambiguous_answer", role: "assistant", content: "Stored answer", runId: RUN_ID },
          ],
        });
        throw Object.assign(new Error("accepted run response was lost"), { retryable: true });
      }
      throw rolloutAgentError(1_000);
    },
    async resumeRun() { throw new Error("a pristine thread must use startRun"); },
    async runStatus(runId) { return { run: terminalRun("completed", history, { id: runId }) }; },
    async *streamRunEvents({ runId }) {
      assert.equal(runId, RUN_ID);
      for (const event of history) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent, wait: async (milliseconds) => { waits.push(milliseconds); } });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = prompt;

  await browser.app.submitMessage({ preventDefault() {} });
  assert.deepEqual(waits, [250]);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].options.idempotency, starts[1].options.idempotency);
  assert.equal(browser.document.getElementById("run-state").textContent, "Interrupted");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(starts.length, 2, "the replay fence blocks a new mutation key before reconciliation");
  await browser.app.openThread(THREAD_ID, { mode: "agent" });
  assert.equal(starts.length, 2, "reopen performs only authoritative reads");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.match(browser.document.getElementById("messages").textContent, /Confirmed without a new mutation key/u);
});

test("an ambiguous known-thread Agent run dominates a later release mismatch", async () => {
  const history = await verifiedEvents([["run.completed", {}]]);
  let thread = agentThread();
  const starts = [];
  let reloads = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async startRun(threadId, text, options) {
      starts.push({ threadId, text, options });
      if (starts.length === 1) {
        thread = agentThread({
          lastRunId: RUN_ID,
          messages: [
            { id: "msg_agent_release_user", role: "user", content: text, runId: RUN_ID },
            { id: "msg_agent_release_answer", role: "assistant", content: "Stored", runId: RUN_ID },
          ],
        });
        throw Object.assign(new Error("accepted response was lost"), { retryable: true });
      }
      throw new AgintiTransportError("new release is binding", {
        code: "client_release_mismatch",
        status: 409,
        retryable: false,
        serverRelease: `release-${"d".repeat(64)}`,
      });
    },
    async runStatus(runId) { return { run: terminalRun("completed", history, { id: runId }) }; },
    async *streamRunEvents({ runId }) {
      for (const event of history) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  browser.window.location.reload = () => { reloads += 1; };
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Keep the known-thread receipt fence";

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(starts.length, 2);
  assert.equal(starts[0].options.idempotency, starts[1].options.idempotency);
  assert.equal(reloads, 0);
  assert.equal(browser.document.getElementById("run-state").textContent, "Interrupted");
  await browser.app.openThread(THREAD_ID, { mode: "agent" });
  assert.equal(starts.length, 2);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Agent thread creation retries a lost response with one idempotency key and one accepted user turn", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "Created once" }],
    ["run.completed", {}],
  ]);
  const createCalls = [];
  const waits = [];
  const thread = agentThread();
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread(body, options) {
      createCalls.push({ body, options });
      if (createCalls.length === 1) {
        throw Object.assign(new Error("thread response lost after dispatch"), { retryable: true });
      }
      return { thread };
    },
    async startRun(threadId, text) {
      assert.equal(threadId, THREAD_ID);
      assert.equal(text, "Create this Agent conversation once");
      return { run: run("running") };
    },
    async *streamRunEvents() {
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({
    agent,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  const prompt = "Create this Agent conversation once";
  browser.document.getElementById("message-input").value = prompt;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.deepEqual(waits, [250]);
  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls[0].body, createCalls[1].body);
  assert.equal(createCalls[0].options.idempotency, createCalls[1].options.idempotency);
  assert.match(createCalls[0].options.idempotency, /^agent_thread_[A-Za-z0-9._~-]+$/u);
  assert.equal(browser.document.getElementById("thread-list").children.length, 1);
  const userTurns = browser.document.getElementById("messages").children
    .filter((node) => node.dataset.role === "user");
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0].textContent, prompt);
  assert.equal(browser.document.getElementById("message-input").value, "");
});

test("Agent thread creation keeps one exact ticket after two lost responses and confirms it on a later send", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "Confirmed after interruption" }],
    ["run.completed", {}],
  ]);
  const createCalls = [];
  const startCalls = [];
  const waits = [];
  const thread = agentThread();
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread(body, options) {
      createCalls.push({ body, options });
      if (createCalls.length === 1) {
        throw Object.assign(new Error("thread response remained unavailable"), { retryable: true });
      }
      if (createCalls.length === 2) {
        throw Object.assign(new Error("request aborted after dispatch"), { status: 499, retryable: false });
      }
      return { thread };
    },
    async startRun(threadId, text, options) {
      startCalls.push({ threadId, text, options });
      return { run: run("running") };
    },
    async *streamRunEvents() {
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({
    agent,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  const prompt = "Confirm this interrupted Agent conversation";
  browser.document.getElementById("message-input").value = prompt;

  await browser.app.submitMessage({ preventDefault() {} });

  assert.deepEqual(waits, [250]);
  assert.equal(createCalls.length, 2);
  assert.equal(startCalls.length, 0);
  assert.equal(browser.document.getElementById("message-input").value, prompt);
  assert.equal(browser.document.getElementById("message-input").disabled, false);
  assert.match(browser.document.getElementById("toast").textContent, /same exact conversation/u);
  browser.document.getElementById("new-thread").dispatch("click");
  assert.match(browser.document.getElementById("toast").textContent, /confirm its exact Agent conversation/u);
  browser.app.setMode("chat");
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
  assert.match(browser.document.getElementById("toast").textContent, /before changing modes/u);

  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(createCalls.length, 3);
  assert.deepEqual(createCalls.map(({ body }) => body), [createCalls[0].body, createCalls[0].body, createCalls[0].body]);
  assert.equal(new Set(createCalls.map(({ options }) => options.idempotency)).size, 1);
  assert.match(createCalls[0].options.idempotency, /^agent_thread_[A-Za-z0-9._~-]+$/u);
  assert.equal(startCalls.length, 1);
  assert.deepEqual(
    { threadId: startCalls[0].threadId, text: startCalls[0].text },
    { threadId: THREAD_ID, text: prompt },
  );
  const userTurns = browser.document.getElementById("messages").children
    .filter((node) => node.dataset.role === "user");
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0].textContent, prompt);
  assert.match(browser.document.getElementById("messages").textContent, /Confirmed after interruption/u);
  assert.equal(browser.document.getElementById("message-input").value, "");
});

test("authoritative Agent thread-create rejection clears the ticket and never blocks release recovery", async () => {
  for (const candidate of [
    {
      label: "bounded rejection",
      error: Object.assign(new Error("request rejected"), {
        code: "AGINTI_REQUEST_REJECTED", status: 422, retryable: false,
      }),
      expectedToast: /rejected the new conversation/u,
      updateOffered: false,
    },
    {
      label: "release mismatch",
      error: Object.assign(new Error("stale app"), {
        code: "client_release_mismatch",
        status: 409,
        retryable: false,
        serverRelease: `release-${"f".repeat(64)}`,
      }),
      expectedToast: /stale|newer app release/iu,
      updateOffered: true,
    },
  ]) {
    let creates = 0;
    const agent = {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async createThread() { creates += 1; throw candidate.error; },
      async startRun() { throw new Error("a rejected create cannot start a run"); },
    };
    const browser = harness({ agent });
    await browser.app.initialize();
    browser.document.getElementById("update-banner").hidden = true;
    const prompt = `Keep the ${candidate.label} draft`;
    browser.document.getElementById("message-input").value = prompt;

    await browser.app.submitMessage({ preventDefault() {} });

    assert.equal(creates, 1, `${candidate.label} is not retried`);
    assert.equal(browser.document.getElementById("message-input").value, prompt);
    assert.match(browser.document.getElementById("toast").textContent, candidate.expectedToast);
    assert.equal(browser.document.getElementById("update-banner").hidden, !candidate.updateOffered);
    browser.app.setMode("chat");
    assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat",
      `${candidate.label} leaves no ambiguous-create navigation fence`);
  }
});

test("Agent first run retries a lost response with one idempotency key and one accepted user turn", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "Started once" }],
    ["run.completed", {}],
  ]);
  const startCalls = [];
  const waits = [];
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun(threadId, text, options) {
      startCalls.push({ threadId, text, options });
      if (startCalls.length === 1) {
        throw Object.assign(new Error("start response lost after dispatch"), { retryable: true });
      }
      return { run: run("running") };
    },
    async *streamRunEvents() {
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({
    agent,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  const prompt = "Start this Agent run once";
  browser.document.getElementById("message-input").value = prompt;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.deepEqual(waits, [250]);
  assert.equal(startCalls.length, 2);
  assert.deepEqual(
    startCalls.map(({ threadId, text }) => ({ threadId, text })),
    [
      { threadId: THREAD_ID, text: prompt },
      { threadId: THREAD_ID, text: prompt },
    ],
  );
  assert.equal(startCalls[0].options.idempotency, startCalls[1].options.idempotency);
  assert.match(startCalls[0].options.idempotency, /^agent_start_[A-Za-z0-9._~-]+$/u);
  const userTurns = browser.document.getElementById("messages").children
    .filter((node) => node.dataset.role === "user");
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0].textContent, prompt);
  assert.equal(browser.document.getElementById("message-input").value, "");
});

test("a user-selected Chat workspace survives reload without an automatic Agent handoff changing it", {
  concurrency: false,
}, async (t) => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
    },
  });
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", previousStorage);
  });
  const completed = await verifiedEvent({ seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH });
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run() }; },
    async *streamRunEvents() { yield { event: completed, cursor: { seq: completed.seq, hash: completed.hash } }; },
  };
  const first = harness({ agent });
  await first.app.initialize();
  assert.equal(first.document.getElementById("workspace").dataset.mode, "agent");
  first.app.setMode("chat", { restoreView: false });
  assert.equal(values.get("lazying-agent-workspace-mode"), "chat");
  first.document.getElementById("message-input").value = "Run this Python code\n```python\nprint(1)\n```";
  await first.app.submitMessage({ preventDefault() {} });
  assert.equal(first.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(values.get("lazying-agent-workspace-mode"), "chat", "one execution handoff is not a preference change");

  const reloaded = harness({ agent });
  await reloaded.app.initialize();
  assert.equal(reloaded.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(reloaded.document.getElementById("chat-mode").getAttribute("aria-pressed"), "true");
});

test("explicit plot and code-run prompts in Direct Chat hand off to Agent with unmistakable controls", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "Rendered plot" }],
    ["run.completed", {}],
  ]);
  for (const prompt of [
    "Plot e^x-x^e",
    "Plot and show here?",
    "Run code plot e^x-x",
    "Run this Python code and chart the values\n```python\nprint(1)\n```",
    "Run this Python code and display its graph\n```python\nprint(1)\n```",
    "Run this Python code; I need a plot\n```python\nprint(1)\n```",
    "Kindly run this Python code\n```python\nprint(1)\n```",
    "I'd like you to run this Python code\n```python\nprint(1)\n```",
    "Let's run this Python code\n```python\nprint(1)\n```",
    "请执行下面代码\n```python\nprint('好')\n```",
    "請執行下面的程式碼\n```python\nprint('好')\n```",
    "Run this Python code and show the result\n```python\nprint('javascript is only output text')\n```",
    "Run and show the plot.\n```python\nprint(1)\n```",
    "Run and show the output.\n```python\nprint(1)\n```",
    "Execute and return the result.\n```python\nprint(1)\n```",
    "Execute and show both stdout and messages.\n```python\nprint(1)\n```",
    "Run, show output.\n```python\nprint(1)\n```",
    "Run; then show output.\n```python\nprint(1)\n```",
    "Run, I need a plot.\n```python\nprint(1)\n```",
    "Execute; I would like a graph.\n```python\nprint(1)\n```",
    "执行：\n```python\nprint(1)\n```",
    "執行一下:\n```python\nprint(1)\n```",
  ]) {
    const started = [];
    const agent = {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async createThread() { return { thread: agentThread() }; },
      async startRun(threadId, text) {
        started.push({ threadId, text });
        return { run: run() };
      },
      async *streamRunEvents() {
        for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    };
    const browser = harness({ agent });
    await browser.app.initialize();
    const send = browser.document.getElementById("send-message");
    assert.equal(send.textContent, "Run Agent");
    assert.equal(send.getAttribute("aria-label"), "Run Agent");

    browser.app.setMode("chat", { restoreView: false });
    assert.equal(send.textContent, "Send Chat");
    assert.equal(send.getAttribute("aria-label"), "Send Chat");
    browser.document.getElementById("message-input").value = prompt;
    await browser.app.submitMessage({ preventDefault() {} });

    assert.deepEqual(started, [{ threadId: THREAD_ID, text: prompt }]);
    assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
    assert.equal(send.textContent, "Run Agent");
    assert.equal(send.getAttribute("aria-label"), "Run Agent");
    assert.match(browser.document.getElementById("toast").textContent, /Handed to Agent/iu);
  }
});

test("advertised TeX/PDF file creation requests hand off from Chat to Agent", async () => {
  const completed = await verifiedEvent({ seq: 1, type: "run.completed", payload: {}, previousHash: ZERO_HASH });
  for (const prompt of [
    "Create a LaTeX source and compile it to PDF with one figure.",
    "Write a .tex report and provide the compiled .pdf.",
    "Write a latex of qaoa compile and give me link of pdf with figures",
    "I need a LaTeX source and compiled PDF.",
    "I want the TeX file and the compiled PDF.",
    "Create the report in LaTeX and give me the PDF.",
    "Generate a QAOA paper using LaTeX and return a PDF.",
    "Prepare the TeX manuscript and PDF.",
    "Write the LaTeX and PDF files.",
    "Produce both LaTeX and PDF versions.",
    "Please send me the TeX source and compiled PDF.",
    "I need the .tex and .pdf files.",
    "Give me a LaTeX source and compiled PDF.",
    "Output a TeX source plus compiled PDF.",
    "Use LaTeX to make a PDF with a self-contained figure.",
    "请生成 LaTeX 源文件并编译成 PDF。",
    "请提供 LaTeX 源文件和编译后的 PDF。",
    "我需要 TeX 文件和 PDF 文件。",
    "制作 LaTeX 和 PDF 两种格式。",
  ]) {
    const started = [];
    const agent = {
      ...baseAgent(capabilities({
        enabled: true,
        actions: { cancel: true, resume: true, retry: false },
        artifacts: { kinds: ["plot", "table", "markdown", "file"], schemaVersion: "1" },
      })),
      async createThread() { return { thread: agentThread() }; },
      async startRun(threadId, text) {
        started.push({ threadId, text });
        return { run: run() };
      },
      async *streamRunEvents() {
        yield { event: completed, cursor: { seq: completed.seq, hash: completed.hash } };
      },
    };
    const browser = harness({ agent });
    await browser.app.initialize();
    assert.match(browser.document.getElementById("capability-note").textContent, /TeX\/PDF files/iu);
    browser.app.setMode("chat", { restoreView: false });
    browser.document.getElementById("message-input").value = prompt;
    await browser.app.submitMessage({ preventDefault() {} });

    assert.deepEqual(started, [{ threadId: THREAD_ID, text: prompt }]);
    assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent");
    assert.match(browser.document.getElementById("toast").textContent, /TeX\/PDF creation/iu);
  }
});

test("TeX/PDF wording stays in Chat when file creation is not advertised or not requested", async () => {
  const prompts = [
    "Write a latex of qaoa compile and give me link of pdf with figures",
    "Explain the difference between LaTeX and PDF.",
    "Do not create a LaTeX or PDF file.",
    "I need an explanation of LaTeX and PDF.",
    "How do I use LaTeX to make a PDF?",
    "Provide an explanation of LaTeX and PDF.",
    "Write about LaTeX and PDF.",
    "Write a tutorial about LaTeX and PDF.",
    "Give me advice about LaTeX and PDF.",
    "Compare LaTeX and PDF.",
    "Write prose explaining LaTeX and PDF.",
    "Provide a LaTeX source-code example and explain PDF output.",
    "Do not create files; explain LaTeX and PDF.",
    "Create neither LaTeX nor PDF files.",
  ];
  for (const [index, prompt] of prompts.entries()) {
    const fileCapability = index !== 0;
    const chatRuns = [];
    let agentStarts = 0;
    const agent = {
      ...baseAgent(capabilities({
        enabled: true,
        actions: { cancel: true, resume: true, retry: false },
        ...(fileCapability
          ? { artifacts: { kinds: ["plot", "table", "markdown", "file"], schemaVersion: "1" } }
          : {}),
      })),
      async createThread() { throw new Error("unsupported document wording must not create an Agent thread"); },
      async startRun() { agentStarts += 1; throw new Error("unsupported document wording must not start Agent"); },
    };
    const browser = harness({
      agent,
      chat: terminalTextChat({ onRun(ticket) { chatRuns.push(ticket.content); } }),
    });
    await browser.app.initialize();
    browser.app.setMode("chat", { restoreView: false });
    browser.document.getElementById("message-input").value = prompt;
    await browser.app.submitMessage({ preventDefault() {} });

    assert.deepEqual(chatRuns, [prompt]);
    assert.equal(agentStarts, 0);
    assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat", prompt);
  }
});

test("context-dependent Chat requests are not silently handed to a fresh Agent thread", async () => {
  for (const prompt of [
    "Plot it.",
    "Plot the above data.",
    "Run the previous code.",
    "Create a LaTeX source and PDF from the article above.",
    "Revise it and return the TeX and PDF files.",
  ]) {
    const chatRuns = [];
    let agentThreads = 0;
    let agentStarts = 0;
    const browser = harness({
      agent: {
        ...baseAgent(capabilities({
          enabled: true,
          actions: { cancel: true, resume: true, retry: false },
          artifacts: { kinds: ["plot", "table", "markdown", "file"], schemaVersion: "1" },
        })),
        async createThread() { agentThreads += 1; throw new Error("context guard must not create Agent thread"); },
        async startRun() { agentStarts += 1; throw new Error("context guard must not start Agent"); },
      },
      chat: terminalTextChat({ onRun(ticket) { chatRuns.push(ticket.content); } }),
    });
    await browser.app.initialize();
    browser.app.setMode("chat", { restoreView: false });
    assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat", `mode selection: ${prompt}`);
    browser.document.getElementById("message-input").value = prompt;
    await browser.app.submitMessage({ preventDefault() {} });

    assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat", `after submit: ${prompt}`);
    assert.equal(browser.document.getElementById("message-input").value, prompt);
    assert.equal(agentThreads, 0);
    assert.equal(agentStarts, 0);
    assert.deepEqual(chatRuns, []);
    assert.match(browser.document.getElementById("toast").textContent, /depends on Direct Chat context[\s\S]*nothing was sent/iu);
  }
});

test("Agent handoff rejects negated, instructional, existing-plot, and non-Python runtime wording", async () => {
  const prompts = [
    "Don't plot e^x-x^e.",
    "How do I plot e^x-x^e?",
    "Show me how to plot e^x-x^e.",
    "Explain this existing plot.",
    "Show me what this existing plot means.",
    "Run this JavaScript code and plot e^x-x.",
    "Run Go code and plot e^x-x.",
  ];
  for (const prompt of prompts) {
    const chatRuns = [];
    let agentStarts = 0;
    const browser = harness({
      agent: {
        ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
        async createThread() { throw new Error("excluded wording must not create an Agent thread"); },
        async startRun() { agentStarts += 1; throw new Error("excluded wording must not start Agent"); },
      },
      chat: terminalTextChat({ onRun(ticket) { chatRuns.push(ticket.content); } }),
    });
    await browser.app.initialize();
    browser.app.setMode("chat", { restoreView: false });
    browser.document.getElementById("message-input").value = prompt;
    await browser.app.submitMessage({ preventDefault() {} });

    assert.deepEqual(chatRuns, [prompt]);
    assert.equal(agentStarts, 0);
    assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
    assert.equal(browser.document.getElementById("send-message").textContent, "Send Chat");
    assert.doesNotMatch(browser.document.getElementById("toast").textContent, /Handed to Agent/iu);
  }
});

test("a selected image keeps an explicit plot prompt in Direct Chat", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const descriptor = {
    attachmentId: "image_agent_handoff_00000001",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 128,
    height: 128,
    sha256: "d".repeat(64),
  };
  let agentStarts = 0;
  const browser = harness({
    agent: {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async createThread() { throw new Error("an image prompt must not create an Agent thread"); },
      async startRun() { agentStarts += 1; throw new Error("an image prompt must not start Agent"); },
    },
    chat: terminalVisionChat({ bytes, descriptor }),
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: descriptor.attachmentId,
        mediaType: descriptor.mediaType,
        byteLength: descriptor.byteLength,
        width: descriptor.width,
        height: descriptor.height,
        bytes,
        previewBlob: new Blob([bytes], { type: descriptor.mediaType }),
      });
    },
    createObjectUrl() { return "blob:agent-handoff-image"; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  browser.app.setMode("chat", { restoreView: false });
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "plot.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Plot e^x-x^e";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(agentStarts, 0);
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(browser.document.getElementById("send-message").textContent, "Send Chat");
  assert.match(browser.document.getElementById("messages").textContent, /Vision final answer/u);
  assert.doesNotMatch(browser.document.getElementById("toast").textContent, /Handed to Agent/iu);
});

test("completed Agent reload replays the verified ledger into the existing message and inline artifact without a mutation", async () => {
  const events = await verifiedEvents([
    ["plan.updated", { steps: [{ id: "compute", label: "Compute values", status: "completed" }] }],
    ["tool.completed", {
      callId: "code-call-1",
      publicLabel: "Run calculation",
      publicSummary: "Prepared bounded plot data",
      at: NOW,
    }],
    ["output.delta", { text: "Restored verified answer" }],
    ["artifact.created", { artifact: {
      id: ARTIFACT_ID,
      title: "Restored plot",
      kind: "plot",
      spec: {
        schemaVersion: "1",
        type: "line",
        labels: ["A", "B"],
        series: [{ name: "Value", data: [1, 2] }],
      },
    } }],
    ["artifact.created", { artifact: {
      id: SECOND_ARTIFACT_ID,
      title: "Restored sources",
      kind: "sources",
      spec: {
        schemaVersion: "1",
        sources: [{
          index: 1,
          title: "Verified primary source",
          url: "https://example.test/research",
          snippet: "Evidence restored from the verified run ledger.",
          providers: ["provider-one"],
          kind: "web",
          publishedDate: "2026-08-20",
          doi: null,
        }],
      },
    } }],
    ["output.completed", {}],
    ["run.completed", {}],
  ]);
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [
      { id: "msg_user_reload_0001", role: "user", content: "Calculate", runId: RUN_ID },
      { id: "msg_assistant_reload_0001", role: "assistant", content: "Stored answer", runId: RUN_ID },
    ],
  });
  let statuses = 0;
  let streams = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({
      enabled: true,
      actions: { cancel: true, resume: true, retry: false },
      search: { enabled: true, modes: ["web", "papers", "both"], maximumSources: 20 },
      artifacts: { kinds: ["plot", "table", "markdown", "sources"], schemaVersion: "1" },
    })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(threadId) { assert.equal(threadId, THREAD_ID); return { thread }; },
    async runStatus(runId) {
      statuses += 1;
      assert.equal(runId, RUN_ID);
      return { run: terminalRun("completed", events) };
    },
    async startRun() { starts += 1; throw new Error("terminal restoration must not start a run"); },
    async resumeRun() { resumes += 1; throw new Error("terminal restoration must not resume a run"); },
    async *streamRunEvents(options) {
      streams += 1;
      assert.equal(options.runId, RUN_ID);
      assert.equal(options.threadId, THREAD_ID);
      assert.deepEqual(options.cursor, { seq: 0, hash: ZERO_HASH });
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();

  const messages = browser.document.getElementById("messages");
  assert.equal(messages.children.length, 2, "ledger replay reuses the persisted assistant message");
  const assistant = messages.children.find((node) => node.dataset.role === "assistant");
  assert(assistant);
  assert.equal(assistant.dataset.runId, RUN_ID);
  assert.match(assistant.textContent, /Restored verified answer/u);
  assert.match(assistant.textContent, /Restored plot/u);
  assert.match(assistant.textContent, /Restored sources/u);
  const inlineArtifacts = assistant.children.find((node) => node.className === "message-artifacts");
  assert(inlineArtifacts);
  assert.equal(inlineArtifacts.hidden, false);
  assert.equal(inlineArtifacts.children.length, 2, "ledger replay projects each run-bound artifact exactly once");
  assert.match(browser.document.getElementById("agent-plan").textContent, /Compute values/u);
  assert.match(browser.document.getElementById("agent-timeline").textContent, /Prepared bounded plot data/u);
  assert.equal(browser.document.getElementById("agent-artifacts").children.length, 0);
  assert.equal(browser.document.getElementById("agent-artifacts").hidden, true);
  assert.equal(statuses, 1);
  assert.equal(streams, 1);
  assert.equal(starts, 0);
  assert.equal(resumes, 0);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Agent reload restores every persisted run once and reopening the selected thread preserves its rendered artifacts", async () => {
  const firstEvents = await verifiedEvents([
    ["output.delta", { text: "First restored answer" }],
    ["artifact.created", { artifact: {
      id: ARTIFACT_ID,
      title: "First artifact",
      kind: "plot",
      spec: {
        schemaVersion: "1",
        type: "line",
        labels: ["A", "B"],
        series: [{ name: "Value", data: [1, 2] }],
      },
    } }],
    ["run.completed", {}],
  ]);
  const secondEvents = await verifiedEvents([
    ["output.delta", { text: "Second restored answer" }],
    ["artifact.created", { artifact: {
      id: SECOND_ARTIFACT_ID,
      title: "Second artifact",
      kind: "table",
      spec: {
        schemaVersion: "1",
        columns: [{ key: "value", label: "Value" }],
        rows: [{ value: 2 }],
      },
    } }],
    ["run.completed", {}],
  ], { runId: SECOND_RUN_ID });
  const thread = agentThread({
    lastRunId: SECOND_RUN_ID,
    messages: [
      // Deliberately place the declared current run before an older run. The
      // current run must still restore last; message ordering is not authority.
      { id: "msg_user_history_0002", role: "user", content: "Second", runId: SECOND_RUN_ID },
      { id: "msg_assistant_history_0002", role: "assistant", content: "Stored second", runId: SECOND_RUN_ID },
      { id: "msg_user_history_0001", role: "user", content: "First", runId: RUN_ID },
      { id: "msg_assistant_history_0001", role: "assistant", content: "Stored first", runId: RUN_ID },
    ],
  });
  const histories = new Map([
    [RUN_ID, firstEvents],
    [SECOND_RUN_ID, secondEvents],
  ]);
  const statusReads = [];
  const streamReads = [];
  let threadReads = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { threadReads += 1; return { thread }; },
    async runStatus(runId) {
      statusReads.push(runId);
      return { run: terminalRun("completed", histories.get(runId), { id: runId }) };
    },
    async startRun() { starts += 1; throw new Error("history replay must not start"); },
    async resumeRun() { resumes += 1; throw new Error("history replay must not resume"); },
    async *streamRunEvents(options) {
      streamReads.push({ runId: options.runId, cursor: options.cursor });
      for (const event of histories.get(options.runId)) {
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      }
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();

  assert.equal(threadReads, 1);
  assert.deepEqual(statusReads, [RUN_ID, SECOND_RUN_ID]);
  assert.deepEqual(streamReads, [
    { runId: RUN_ID, cursor: { seq: 0, hash: ZERO_HASH } },
    { runId: SECOND_RUN_ID, cursor: { seq: 0, hash: ZERO_HASH } },
  ]);
  const messages = browser.document.getElementById("messages");
  const originalMessages = [...messages.children];
  const assistants = messages.children
    .filter((node) => node.dataset.role === "assistant");
  assert.equal(assistants.length, 2);
  const firstAssistant = assistants.find((node) => node.dataset.runId === RUN_ID);
  const secondAssistant = assistants.find((node) => node.dataset.runId === SECOND_RUN_ID);
  const firstArtifacts = firstAssistant.children.find((node) => node.className === "message-artifacts");
  const secondArtifacts = secondAssistant.children.find((node) => node.className === "message-artifacts");
  assert.match(firstAssistant.textContent, /First restored answerFirst artifact/u);
  assert.match(secondAssistant.textContent, /Second restored answerSecond artifact/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(threadOpenControls(browser.document)[0].getAttribute("aria-current"), "true");
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);

  await browser.app.openThread(THREAD_ID, { mode: "agent" });

  assert.equal(threadReads, 1, "the settled selected Agent thread is not fetched twice");
  assert.deepEqual(statusReads, [RUN_ID, SECOND_RUN_ID]);
  assert.deepEqual(streamReads, [
    { runId: RUN_ID, cursor: { seq: 0, hash: ZERO_HASH } },
    { runId: SECOND_RUN_ID, cursor: { seq: 0, hash: ZERO_HASH } },
  ]);
  assert.equal(messages.children.length, originalMessages.length);
  originalMessages.forEach((node, index) => assert.equal(messages.children[index], node));
  assert.equal(firstAssistant.children.find((node) => node.className === "message-artifacts"), firstArtifacts);
  assert.equal(secondAssistant.children.find((node) => node.className === "message-artifacts"), secondArtifacts);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("composer").getAttribute("aria-busy"), "false");
  assert.equal(threadOpenControls(browser.document)[0].getAttribute("aria-current"), "true");
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
  assert.equal(starts, 0);
  assert.equal(resumes, 0);
});

test("Agent reload restores an older failed run after its resumed successor completed", async () => {
  const failedEvents = await verifiedEvents([["run.failed", {}]]);
  const completedEvents = await verifiedEvents([
    ["output.delta", { text: "Corrected run completed" }],
    ["artifact.created", { artifact: {
      id: ARTIFACT_ID,
      title: "Corrected plot",
      kind: "plot",
      spec: {
        schemaVersion: "1",
        type: "line",
        labels: ["A", "B"],
        series: [{ name: "Value", data: [1, 2] }],
      },
    } }],
    ["output.completed", {}],
    ["run.completed", {}],
  ], { runId: SECOND_RUN_ID });
  const failureMessage = "Python execution failed. Check the code, then resume.";
  const thread = agentThread({
    lastRunId: SECOND_RUN_ID,
    messages: [
      { id: "msg_user_failed_history_0001", role: "user", content: "Broken code", runId: RUN_ID },
      { id: "msg_user_resumed_history_0002", role: "user", content: "Corrected code", runId: SECOND_RUN_ID },
      { id: "msg_assistant_resumed_history_0002", role: "assistant", content: "Stored corrected answer", runId: SECOND_RUN_ID },
    ],
  });
  const histories = new Map([
    [RUN_ID, failedEvents],
    [SECOND_RUN_ID, completedEvents],
  ]);
  const statusReads = [];
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async runStatus(runId) {
      statusReads.push(runId);
      return { run: terminalRun(runId === RUN_ID ? "failed" : "completed", histories.get(runId), {
        id: runId,
        ...(runId === RUN_ID ? {
          error: { code: "ANALYSIS_EXECUTION_FAILED", message: failureMessage },
        } : {}),
      }) };
    },
    async *streamRunEvents(options) {
      for (const event of histories.get(options.runId)) {
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      }
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();

  assert.deepEqual(statusReads, [RUN_ID, SECOND_RUN_ID]);
  const assistants = browser.document.getElementById("messages").children
    .filter((node) => node.dataset.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants.find((node) => node.dataset.runId === RUN_ID).textContent, failureMessage);
  assert.match(
    assistants.find((node) => node.dataset.runId === SECOND_RUN_ID).textContent,
    /Corrected run completed/u
  );
  assert.deepEqual(
    browser.document.getElementById("messages").children.map((node) => [node.dataset.role, node.dataset.runId]),
    [
      ["user", RUN_ID],
      ["assistant", RUN_ID],
      ["user", SECOND_RUN_ID],
      ["assistant", SECOND_RUN_ID],
    ],
    "a missing failed-run assistant is reserved before the resumed successor chronology"
  );
  const successor = assistants.find((node) => node.dataset.runId === SECOND_RUN_ID);
  assert.equal(successor.children.find((node) => node.className === "message-artifacts")?.children.length, 1);
  assert.match(successor.textContent, /Corrected plot/u);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("a persisted assistant run cannot bypass exact terminal replay by also being lastRunId", async () => {
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [{ id: "msg_assistant_nonterminal_0001", role: "assistant", content: "Stored fallback", runId: RUN_ID }],
  });
  let streams = 0;
  let starts = 0;
  let resumes = 0;
  let cancellations = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async runStatus() { return { run: run("running") }; },
    async startRun() { starts += 1; throw new Error("invalid history must not start"); },
    async resumeRun() { resumes += 1; throw new Error("invalid history must not resume"); },
    async cancelRun() { cancellations += 1; throw new Error("invalid history must not cancel"); },
    async *streamRunEvents() { streams += 1; },
  };
  const browser = harness({ agent });
  await browser.app.initialize();

  assert.equal(streams, 0, "persisted assistant content requires a terminal cursor-bound replay");
  assert.doesNotMatch(
    browser.document.getElementById("messages").textContent,
    /Stored fallback/u,
    "an ancestry-invalid thread fails closed before projecting unverified replay content",
  );
  assert.match(browser.document.getElementById("toast").textContent, /could not be restored safely/u);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  await browser.app.resume();
  await browser.app.stop();
  assert.deepEqual({ starts, resumes, cancellations }, { starts: 0, resumes: 0, cancellations: 0 });
});

test("terminal mutation and status responses remain nonterminal until a verified terminal event", async () => {
  let streams = 0;
  let statuses = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("completed") }; },
    async runStatus() { statuses += 1; return { run: run("completed") }; },
    async *streamRunEvents() {
      streams += 1;
      if (streams > 1) throw Object.assign(new Error("terminal event unavailable"), { retryable: false });
      // A clean EOF, even after two terminal RPC payloads, is not completion.
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Finish immediately";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(streams, 2);
  assert.equal(statuses, 1);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "running");
  assert.notEqual(browser.document.getElementById("run-state").textContent, "Completed");
  assert.match(browser.document.getElementById("toast").textContent, /still owned by AgInTi/u);
});

test("verified Agent failure refreshes and renders its public reason as literal text", async () => {
  const events = await verifiedEvents([["run.failed", {}]]);
  const publicReason = "<img src=x onerror=alert(1)> [retry](javascript:alert(1))";
  let statuses = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async runStatus() {
      statuses += 1;
      return { run: terminalRun("failed", events, {
        error: { code: "ANALYSIS_EXECUTION_FAILED", message: publicReason },
      }) };
    },
    async *streamRunEvents() {
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Run this Python code";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(statuses, 1);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "failed");
  const assistant = browser.document.getElementById("messages").children
    .find((node) => node.dataset.role === "assistant" && node.dataset.runId === RUN_ID);
  const body = assistant.children.find((node) => node.className === "message-content");
  assert.equal(body.children.length, 1);
  assert.equal(body.children[0].tagName, "p");
  assert.equal(body.children[0].className, "agent-run-failure");
  assert.equal(body.textContent, publicReason);
  assert.equal(body.children[0].children[0].tagName, "#text");
});

test("Agent resume binds a new run to the exact failed predecessor before opening its stream", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  const resumedCompleted = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID,
  });
  let streams = 0;
  let resumes = 0;
  let resumeArguments = null;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: true } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun(...args) {
      resumes += 1;
      resumeArguments = args;
      const [runId] = args;
      assert.equal(runId, RUN_ID);
      return { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
    },
    async *streamRunEvents() {
      streams += 1;
      if (streams === 1) yield { event: failed, cursor: { seq: failed.seq, hash: failed.hash } };
      else yield {
        event: resumedCompleted,
        cursor: { seq: resumedCompleted.seq, hash: resumedCompleted.hash },
      };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Fail, then resume safely";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "failed");

  await browser.app.resume();

  assert.equal(resumes, 1);
  assert.equal(resumeArguments[0], RUN_ID);
  assert.equal(resumeArguments[1], undefined, "an empty composer preserves the input-less Resume RPC");
  assert.match(resumeArguments[2].idempotency, /^agent_resume_[A-Za-z0-9._~-]+$/u);
  assert.equal(streams, 2);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(
    browser.document.getElementById("messages").children.filter((node) => node.dataset.role === "user").length,
    1,
    "input-less Resume does not invent a second user message",
  );
});

test("Agent Resume retains one ticket when ambiguity is followed by rollout and release fences", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  const completed = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID,
  });
  const calls = [];
  let streams = 0;
  let reloads = 0;
  const firstAmbiguity = Object.assign(new Error("accepted Resume response was lost"), { retryable: true });
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun(runId, text, options) {
      calls.push({ runId, text, options });
      if (calls.length === 1) throw firstAmbiguity;
      if (calls.length === 2) throw rolloutAgentError(1_000);
      if (calls.length === 3) {
        throw new AgintiTransportError("new release is binding", {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: `release-${"c".repeat(64)}`,
        });
      }
      return { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
    },
    async *streamRunEvents() {
      streams += 1;
      const event = streams === 1 ? failed : completed;
      yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  browser.window.location.reload = () => { reloads += 1; };
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Create a failed run";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("workspace").dataset.status, "failed");
  const corrected = "Use this exact corrected Resume input";
  browser.document.getElementById("message-input").value = corrected;

  await browser.app.resume();
  await browser.app.resume();
  await browser.app.resume();
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(({ options }) => options.idempotency)).size, 1);
  assert.equal(calls.every(({ text }) => text === corrected), true);
  assert.equal(reloads, 0);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);

  await browser.app.resume();
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(({ options }) => options.idempotency)).size, 1);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("message-input").value, "");
});

test("Agent Resume submits a corrected failed or cancelled draft only after its exact successor is accepted", async () => {
  for (const [terminalStatus, terminalType] of [["failed", "run.failed"], ["cancelled", "run.cancelled"]]) {
    const terminal = await verifiedEvent({ seq: 1, type: terminalType, payload: {}, previousHash: ZERO_HASH });
    const completed = await verifiedEvent({
      seq: 1,
      type: "run.completed",
      payload: {},
      previousHash: ZERO_HASH,
      runId: SECOND_RUN_ID,
    });
    const response = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const correctedDraft = "  Run this corrected Python code.  ";
    let streams = 0;
    const agent = {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async createThread() { return { thread: agentThread() }; },
      async startRun() { return { run: run("running") }; },
      async resumeRun(...args) {
        entered.resolve(args);
        return await response.promise;
      },
      async *streamRunEvents() {
        streams += 1;
        const event = streams === 1 ? terminal : completed;
        yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    };
    const browser = harness({ agent });
    await browser.app.initialize();
    browser.document.getElementById("message-input").value = `Create a ${terminalStatus} run`;
    await browser.app.submitMessage({ preventDefault() {} });
    assert.equal(browser.document.getElementById("workspace").dataset.status, terminalStatus);

    const input = browser.document.getElementById("message-input");
    input.value = correctedDraft;
    const resuming = browser.app.resume();
    const resumeArguments = await entered.promise;
    assert.deepEqual(
      resumeArguments.slice(0, 2),
      [RUN_ID, correctedDraft.trim()],
      `${terminalStatus} Resume sends the validated optional replacement input`,
    );
    assert.match(resumeArguments[2].idempotency, /^agent_resume_[A-Za-z0-9._~-]+$/u);
    assert.equal(input.value, correctedDraft, "the draft remains intact while mutation acceptance is unknown");
    assert.equal(
      browser.document.getElementById("messages").children.filter((node) => node.dataset.role === "user").length,
      1,
      "no speculative successor user message is rendered",
    );

    response.resolve({ run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) });
    await resuming;

    const users = browser.document.getElementById("messages").children
      .filter((node) => node.dataset.role === "user");
    assert.equal(input.value, "");
    assert.equal(users.length, 2);
    assert.equal(users.at(-1).dataset.runId, SECOND_RUN_ID);
    assert.equal(users.at(-1).textContent, correctedDraft.trim());
    assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  }
});

test("Agent corrected Resume preserves its exact draft across ambiguous or mismatched acceptance", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  for (const candidate of [
    {
      label: "ambiguous transport",
      resume: async () => { throw Object.assign(new Error("response unavailable"), { retryable: true }); },
    },
    {
      label: "mismatched predecessor",
      resume: async () => ({ run: run("running", { id: SECOND_RUN_ID, previousRunId: null }) }),
    },
  ]) {
    const correctedDraft = `  Correct ${candidate.label}.  `;
    let streams = 0;
    let resumes = 0;
    const agent = {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async createThread() { return { thread: agentThread() }; },
      async startRun() { return { run: run("running") }; },
      async resumeRun(runId, text) {
        resumes += 1;
        assert.deepEqual([runId, text], [RUN_ID, correctedDraft.trim()]);
        return await candidate.resume();
      },
      async *streamRunEvents() {
        streams += 1;
        yield { event: failed, cursor: { seq: failed.seq, hash: failed.hash } };
      },
    };
    const browser = harness({ agent });
    await browser.app.initialize();
    browser.document.getElementById("message-input").value = "Create a failed run";
    await browser.app.submitMessage({ preventDefault() {} });
    const input = browser.document.getElementById("message-input");
    input.value = correctedDraft;

    await browser.app.resume();

    assert.equal(resumes, 1, candidate.label);
    assert.equal(streams, 1, `${candidate.label} never opens an unowned successor stream`);
    assert.equal(input.value, correctedDraft, `${candidate.label} preserves the exact composer draft`);
    assert.equal(
      browser.document.getElementById("messages").children.filter((node) => node.dataset.role === "user").length,
      1,
      `${candidate.label} does not render an unconfirmed user message`,
    );
    assert.match(browser.document.getElementById("toast").textContent, /could not resume/iu, candidate.label);
  }
});

test("Agent corrected Resume retries one ambiguous mutation with the same body and idempotency key", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  const completed = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID,
  });
  const calls = [];
  let streams = 0;
  const agent = {
    ...baseAgent(capabilities({
      enabled: true,
      actions: { cancel: true, resume: true, retry: false },
      search: { enabled: true, modes: ["web", "papers", "both"], maximumSources: 20 },
      artifacts: { kinds: ["plot", "table", "markdown", "sources"], schemaVersion: "1" },
    })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun(...args) {
      calls.push(args);
      if (calls.length === 1) throw Object.assign(new Error("response unavailable"), { retryable: true });
      return { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
    },
    async *streamRunEvents() {
      streams += 1;
      const event = streams === 1 ? failed : completed;
      yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Create a failed run";
  await browser.app.submitMessage({ preventDefault() {} });
  const input = browser.document.getElementById("message-input");
  const correctedDraft = "  Corrected exact request.  ";
  input.value = correctedDraft;
  browser.document.getElementById("search-toggle").dispatch("click");
  browser.document.getElementById("search-mode").value = "papers";
  browser.document.getElementById("search-limit").value = "4";

  await browser.app.resume();

  assert.equal(calls.length, 1);
  assert.equal(input.value, correctedDraft);
  assert.equal(input.disabled, false, "the exact pending correction remains editable");
  assert.equal(browser.document.getElementById("send-message").disabled, true);
  assert.equal(browser.document.getElementById("new-thread").disabled, true);
  assert.equal(browser.document.getElementById("chat-mode").disabled, true);
  const laterDraft = "A later draft must survive acceptance";
  input.value = laterDraft;
  browser.document.getElementById("search-mode").value = "web";
  browser.document.getElementById("search-limit").value = "20";

  await browser.app.resume();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), [RUN_ID, correctedDraft.trim()]);
  assert.deepEqual(calls[1].slice(0, 2), [RUN_ID, correctedDraft.trim()]);
  assert.equal(calls[0][2].idempotency, calls[1][2].idempotency);
  assert.deepEqual(calls[0][2].search, { mode: "papers", limit: 4 });
  assert.deepEqual(calls[1][2].search, { mode: "papers", limit: 4 });
  assert.match(calls[0][2].idempotency, /^agent_resume_[A-Za-z0-9._~-]+$/u);
  assert.equal(input.value, laterDraft, "acceptance never consumes composer work created after the ticket");
  const users = browser.document.getElementById("messages").children
    .filter((node) => node.dataset.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users.at(-1).textContent, correctedDraft.trim());
  assert.equal(users.at(-1).dataset.runId, SECOND_RUN_ID);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
});

test("Agent corrected Resume retains one ticket across a mismatched success response", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  const completed = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID,
  });
  const calls = [];
  let streams = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun(...args) {
      calls.push(args);
      return calls.length === 1
        ? { run: run("running", { id: SECOND_RUN_ID, previousRunId: null }) }
        : { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
    },
    async *streamRunEvents() {
      streams += 1;
      const event = streams === 1 ? failed : completed;
      yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Create a failed run";
  await browser.app.submitMessage({ preventDefault() {} });
  const input = browser.document.getElementById("message-input");
  input.value = "Correct the mismatched run";

  await browser.app.resume();
  await browser.app.resume();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), calls[1].slice(0, 2));
  assert.equal(calls[0][2].idempotency, calls[1][2].idempotency);
  assert.equal(streams, 2, "the mismatched response cannot open an unowned stream");
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("a definitive Agent Resume rejection releases its ticket before a new attempt", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  const completed = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
    runId: SECOND_RUN_ID,
  });
  const calls = [];
  let streams = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun(...args) {
      calls.push(args);
      if (calls.length === 1) {
        throw Object.assign(new Error("resume rejected"), {
          code: "INVALID_REQUEST",
          status: 400,
          retryable: false,
        });
      }
      return { run: run("running", { id: SECOND_RUN_ID, previousRunId: RUN_ID }) };
    },
    async *streamRunEvents() {
      streams += 1;
      const event = streams === 1 ? failed : completed;
      yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Create a failed run";
  await browser.app.submitMessage({ preventDefault() {} });
  const input = browser.document.getElementById("message-input");
  input.value = "Correct after a definitive rejection";

  await browser.app.resume();
  assert.equal(input.disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  await browser.app.resume();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), calls[1].slice(0, 2));
  assert.notEqual(calls[0][2].idempotency, calls[1][2].idempotency);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Agent corrected Resume rejects an invalid non-empty draft before dispatch", async () => {
  const failed = await verifiedEvent({ seq: 1, type: "run.failed", payload: {}, previousHash: ZERO_HASH });
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async resumeRun() { resumes += 1; throw new Error("invalid draft must not dispatch"); },
    async *streamRunEvents() { yield { event: failed, cursor: { seq: failed.seq, hash: failed.hash } }; },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Create a failed run";
  await browser.app.submitMessage({ preventDefault() {} });
  const input = browser.document.getElementById("message-input");
  for (const invalidDraft of ["   \n", "corrected\u0000draft"]) {
    input.value = invalidDraft;

    await browser.app.resume();

    assert.equal(resumes, 0);
    assert.equal(input.value, invalidDraft);
    assert.equal(browser.document.getElementById("resume-run").hidden, false);
    assert.equal(browser.document.getElementById("resume-run").disabled, false);
    assert.match(browser.document.getElementById("toast").textContent, /invalid or too large[\s\S]*no run was resumed/iu);
  }
});

test("terminal cancel response waits for the verified cancelled event without aborting its stream", async () => {
  const [partial, cancelled] = await verifiedEvents([
    ["output.delta", { text: "Partial answer" }],
    ["run.cancelled", {}],
  ]);
  const entered = Promise.withResolvers();
  const failOldStream = Promise.withResolvers();
  const cancelEntered = Promise.withResolvers();
  const cancelResponse = Promise.withResolvers();
  const reconnectEntered = Promise.withResolvers();
  const releaseTerminal = Promise.withResolvers();
  let cancellations = 0;
  let streams = 0;
  let starts = 0;
  const savedCursors = [];
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { starts += 1; return { run: run("running") }; },
    async cancelRun(runId) {
      cancellations += 1;
      assert.equal(runId, RUN_ID);
      cancelEntered.resolve();
      return await cancelResponse.promise;
    },
    async *streamRunEvents({ signal, onCursor }) {
      streams += 1;
      if (streams === 1) {
        await onCursor({ seq: partial.seq, hash: partial.hash });
        yield { event: partial, cursor: { seq: partial.seq, hash: partial.hash } };
        entered.resolve();
        await failOldStream.promise;
        throw Object.assign(new Error("old reader ended during cancellation"), { retryable: false });
      }
      assert.equal(onCursor, undefined, "forced zero-cursor cancellation replay must not roll back the durable live cursor");
      reconnectEntered.resolve();
      await releaseTerminal.promise;
      assert.equal(signal.aborted, false, "the replacement read-only stream remains owned");
      yield { event: partial, cursor: { seq: partial.seq, hash: partial.hash } };
      yield { event: cancelled, cursor: { seq: cancelled.seq, hash: cancelled.hash } };
    },
  };
  const browser = harness({
    agent,
    cursorStore: { async save(value) { savedCursors.push(value.cursor); } },
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Cancel safely";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await entered.promise;
  const stopping = browser.app.stop();
  await cancelEntered.promise;
  await browser.app.stop();
  assert.equal(cancellations, 1, "Stop is single-flight before its RPC response");
  failOldStream.resolve();
  await submission;
  browser.app.setMode("chat");
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "agent", "navigation stays fenced while cancellation is unresolved");
  browser.document.getElementById("message-input").value = "Must remain a draft";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(starts, 1, "the pending cancellation cannot dispatch new Agent work");
  assert.equal(browser.document.getElementById("message-input").value, "Must remain a draft");

  cancelResponse.resolve({ run: run("cancelled") });
  await stopping;
  await reconnectEntered.promise;

  assert.equal(cancellations, 1);
  assert.equal(streams, 2, "a fresh read-only ledger stream replaces the failed reader");
  assert.deepEqual(savedCursors, [{ seq: partial.seq, hash: partial.hash }]);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "running");
  assert.equal(browser.document.getElementById("run-state").textContent, "Cancelling");
  releaseTerminal.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("workspace").dataset.status, "cancelled");
  assert.equal(browser.document.getElementById("run-state").textContent, "Cancelled");
});

test("corrupt cancellation replay fails closed but releases read-only reopen without exposing mutations", async () => {
  const entered = Promise.withResolvers();
  let streams = 0;
  let starts = 0;
  let cancellations = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { starts += 1; return { run: run("running") }; },
    async cancelRun() { cancellations += 1; return { run: run("cancelled") }; },
    async resumeRun() { resumes += 1; throw new Error("corrupt cancellation history must not resume"); },
    async *streamRunEvents({ signal }) {
      streams += 1;
      if (streams === 1) {
        entered.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return;
      }
      yield { event: Object.freeze({}), cursor: { seq: 1, hash: "f".repeat(64) } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Cancel then corrupt";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await entered.promise;
  await browser.app.stop();
  await submission;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(streams, 2);
  assert.match(browser.document.getElementById("toast").textContent, /Reopen this conversation.*no run was resumed/u);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(threadOpenControls(browser.document)[0].disabled, false, "read-only reopen remains available");
  browser.document.getElementById("new-thread").dispatch("click");
  assert.match(browser.document.getElementById("toast").textContent, /Reopen an Agent conversation/u);
  browser.document.getElementById("message-input").value = "Must remain a draft";
  await browser.app.submitMessage({ preventDefault() {} });
  await browser.app.resume();
  await browser.app.stop();
  assert.equal(browser.document.getElementById("message-input").value, "Must remain a draft");
  assert.deepEqual({ starts, cancellations, resumes }, { starts: 1, cancellations: 1, resumes: 0 });
});

test("a verified terminal event wins over a later cancellation RPC rejection", async () => {
  const cancelled = await verifiedEvent({ seq: 1, type: "run.cancelled", payload: {}, previousHash: ZERO_HASH });
  const streamEntered = Promise.withResolvers();
  const releaseTerminal = Promise.withResolvers();
  const cancelEntered = Promise.withResolvers();
  const cancelResponse = Promise.withResolvers();
  let cancellations = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun() { return { run: run("running") }; },
    async cancelRun() {
      cancellations += 1;
      cancelEntered.resolve();
      return await cancelResponse.promise;
    },
    async *streamRunEvents() {
      streamEntered.resolve();
      await releaseTerminal.promise;
      yield { event: cancelled, cursor: { seq: cancelled.seq, hash: cancelled.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Race cancellation";
  const submission = browser.app.submitMessage({ preventDefault() {} });
  await streamEntered.promise;
  const stopping = browser.app.stop();
  await cancelEntered.promise;
  releaseTerminal.resolve();
  await submission;
  assert.equal(browser.document.getElementById("workspace").dataset.status, "cancelled");

  cancelResponse.reject(new Error("late cancellation response lost"));
  await stopping;
  assert.equal(cancellations, 1);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "cancelled");
  assert.equal(browser.document.getElementById("run-state").textContent, "Cancelled");
  assert.equal(browser.document.getElementById("stop-run").hidden, true);
  assert.doesNotMatch(browser.document.getElementById("toast").textContent, /cancellation could not be confirmed/iu);
});

test("terminal status payload plus truncated EOF is not completion and cannot expose any Agent mutation", async () => {
  const events = await verifiedEvents([
    ["run.status", { status: "completed" }],
  ]);
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [{ id: "msg_assistant_truncated_0001", role: "assistant", content: "Stored safe answer", runId: RUN_ID }],
  });
  let starts = 0;
  let resumes = 0;
  let cancellations = 0;
  let threadReads = 0;
  let streams = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { threadReads += 1; return { thread }; },
    async runStatus() { return { run: terminalRun("completed", events) }; },
    async startRun() { starts += 1; throw new Error("failed replay must not start"); },
    async resumeRun() { resumes += 1; throw new Error("failed replay must not resume"); },
    async cancelRun() { cancellations += 1; throw new Error("failed replay must not cancel"); },
    async *streamRunEvents() {
      streams += 1;
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
      // A clean but truncated EOF is not a terminal ledger event.
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();

  assert.deepEqual({ threadReads, streams }, { threadReads: 1, streams: 1 });
  assert.match(browser.document.getElementById("toast").textContent, /Reopen this conversation.*no run was resumed/u);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("messages").textContent, /Stored safe answer/u);
  await browser.app.openThread(THREAD_ID, { mode: "agent" });
  assert.deepEqual({ threadReads, streams }, { threadReads: 2, streams: 2 },
    "a failed current replay remains explicitly reopenable");
  await browser.app.resume();
  await browser.app.stop();
  browser.document.getElementById("message-input").value = "Must remain a draft";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("message-input").value, "Must remain a draft");
  assert.deepEqual({ starts, resumes, cancellations }, { starts: 0, resumes: 0, cancellations: 0 });
});

test("an in-progress read-only terminal restoration blocks start, resume, and cancellation races", async () => {
  const events = await verifiedEvents([["run.completed", {}]]);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [{ id: "msg_assistant_restore_race_0001", role: "assistant", content: "Stored answer", runId: RUN_ID }],
  });
  let starts = 0;
  let resumes = 0;
  let cancellations = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async runStatus() { return { run: terminalRun("completed", events) }; },
    async startRun() { starts += 1; throw new Error("restoration must not start"); },
    async resumeRun() { resumes += 1; throw new Error("restoration must not resume"); },
    async cancelRun() { cancellations += 1; throw new Error("restoration must not cancel"); },
    async *streamRunEvents() {
      entered.resolve();
      await release.promise;
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  const initializing = browser.app.initialize();
  await entered.promise;

  await browser.app.resume();
  await browser.app.stop();
  browser.document.getElementById("message-input").value = "Preserved while restoring";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("message-input").value, "Preserved while restoring");
  assert.deepEqual({ starts, resumes, cancellations }, { starts: 0, resumes: 0, cancellations: 0 });

  release.resolve();
  await initializing;
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
});

test("Agent hydration is mutation-locked before its thread list resolves", async () => {
  const listEntered = Promise.withResolvers();
  const releaseList = Promise.withResolvers();
  let creates = 0;
  let starts = 0;
  let resumes = 0;
  let cancellations = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { listEntered.resolve(); return await releaseList.promise; },
    async createThread() { creates += 1; throw new Error("hydration must not create"); },
    async startRun() { starts += 1; throw new Error("hydration must not start"); },
    async resumeRun() { resumes += 1; throw new Error("hydration must not resume"); },
    async cancelRun() { cancellations += 1; throw new Error("hydration must not cancel"); },
  };
  const browser = harness({ agent });
  const initializing = browser.app.initialize();
  await listEntered.promise;
  browser.document.getElementById("message-input").value = "Keep this draft";
  await browser.app.submitMessage({ preventDefault() {} });
  await browser.app.resume();
  await browser.app.stop();
  assert.equal(browser.document.getElementById("message-input").value, "Keep this draft");
  assert.deepEqual({ creates, starts, resumes, cancellations }, { creates: 0, starts: 0, resumes: 0, cancellations: 0 });

  releaseList.resolve({ schemaVersion: "1", threads: [], nextBefore: null });
  await initializing;
});

test("a buffered event from an abandoned Agent view cannot mutate the successor Chat view", async () => {
  const stale = await verifiedEvent({ seq: 1, type: "output.delta", payload: { text: "STALE PRIVATE OUTPUT" }, previousHash: ZERO_HASH });
  const streamEntered = Promise.withResolvers();
  const releaseStale = Promise.withResolvers();
  const thread = agentThread({
    status: "running",
    lastRunId: RUN_ID,
    messages: [{ id: "msg_user_stale_0001", role: "user", content: "Old work", runId: RUN_ID }],
  });
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async runStatus() { return { run: run("running") }; },
    async *streamRunEvents() {
      streamEntered.resolve();
      await releaseStale.promise;
      yield { event: stale, cursor: { seq: stale.seq, hash: stale.hash } };
    },
  };
  const browser = harness({ agent });
  const initializing = browser.app.initialize();
  await streamEntered.promise;
  browser.app.setMode("chat");
  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  releaseStale.resolve();
  await initializing;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.document.getElementById("workspace").dataset.mode, "chat");
  assert.doesNotMatch(browser.document.getElementById("messages").textContent, /STALE PRIVATE OUTPUT/u);
  assert.equal(browser.document.getElementById("stop-run").hidden, true);
});

test("terminal Agent replay rejects status, sequence, and hash mismatches against runStatus", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "Unbound output" }],
    ["run.completed", {}],
  ]);
  const exact = terminalRun("completed", events);
  const cases = [
    { label: "status", run: terminalRun("failed", events) },
    { label: "sequence", run: { ...exact, eventCursor: { ...exact.eventCursor, lastSeq: exact.eventCursor.lastSeq + 1 } } },
    { label: "hash", run: { ...exact, eventCursor: { ...exact.eventCursor, lastHash: "f".repeat(64) } } },
  ];
  for (const candidate of cases) {
    const thread = agentThread({
      lastRunId: RUN_ID,
      messages: [{ id: `msg_assistant_${candidate.label}_0001`, role: "assistant", content: "Stored fallback", runId: RUN_ID }],
    });
    let resumes = 0;
    const agent = {
      ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { thread }; },
      async runStatus() { return { run: candidate.run }; },
      async resumeRun() { resumes += 1; throw new Error("mismatched replay must not resume"); },
      async *streamRunEvents() {
        for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
      },
    };
    const browser = harness({ agent });
    await browser.app.initialize();
    assert.match(browser.document.getElementById("toast").textContent, /could not be restored safely/u, candidate.label);
    assert.equal(browser.document.getElementById("resume-run").hidden, true, candidate.label);
    assert.match(browser.document.getElementById("messages").textContent, /Stored fallback/u, candidate.label);
    assert.doesNotMatch(browser.document.getElementById("messages").textContent, /Unbound output/u, candidate.label);
    await browser.app.resume();
    assert.equal(resumes, 0, candidate.label);
  }
});

test("live Agent artifacts render inline beneath their exact assistant run", async () => {
  const events = await verifiedEvents([
    ["output.delta", { text: "Live answer" }],
    ["artifact.created", { artifact: {
      id: ARTIFACT_ID,
      title: "Live table",
      kind: "table",
      spec: {
        schemaVersion: "1",
        columns: [{ key: "value", label: "Value" }],
        rows: [{ value: 2 }],
      },
    } }],
    ["run.completed", {}],
  ]);
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: agentThread() }; },
    async startRun(threadId) { starts += 1; assert.equal(threadId, THREAD_ID); return { run: run() }; },
    async resumeRun() { resumes += 1; throw new Error("live completion must not resume"); },
    async *streamRunEvents() {
      for (const event of events) yield { event, cursor: { seq: event.seq, hash: event.hash } };
    },
  };
  const browser = harness({ agent });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Calculate live";
  await browser.app.submitMessage({ preventDefault() {} });

  const messages = browser.document.getElementById("messages");
  assert.equal(messages.children.length, 2);
  const assistant = messages.children.find((node) => (
    node.dataset.role === "assistant" && node.dataset.runId === RUN_ID
  ));
  assert(assistant);
  assert.match(assistant.textContent, /Live answer/u);
  assert.match(assistant.textContent, /Live table/u);
  assert.equal(starts, 1);
  assert.equal(resumes, 0);
});

test("completed Agent reload rejects a run from a different thread before event replay", async () => {
  const thread = agentThread({
    lastRunId: RUN_ID,
    messages: [{ id: "msg_user_mismatch_0001", role: "user", content: "Calculate", runId: RUN_ID }],
  });
  let streams = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread() { return { thread }; },
    async runStatus() {
      return { run: { ...run("completed"), threadId: "thr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
    },
    async startRun() { starts += 1; throw new Error("mismatched restoration must not start"); },
    async resumeRun() { resumes += 1; throw new Error("mismatched restoration must not resume"); },
    async *streamRunEvents() { streams += 1; },
  };
  const browser = harness({ agent });
  await browser.app.initialize();

  assert.equal(streams, 0);
  assert.equal(starts, 0);
  assert.equal(resumes, 0);
  assert.match(browser.document.getElementById("toast").textContent, /could not be restored safely/u);
  assert.equal(browser.document.getElementById("agent-artifacts").children.length, 0);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, true);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
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
  assert.deepEqual(images.map((image) => image.alt), ["Attached image 1", "Attached image 2"]);
});

test("a superseded non-cooperative gallery read cannot strand two-image previews after same-thread chat", async () => {
  const observer = intersectionHarness();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const descriptors = [1, 2].map((value) => Object.freeze({
    attachmentId: `image_followup_${value}_xxxxxxxxxx`,
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 2,
    height: 2,
    sha256: String(value).repeat(64),
  }));
  const hashes = [CHAT_HASH_A, CHAT_HASH_B, "c".repeat(64), "d".repeat(64)];
  const followupGenerationId = "generation_followup_xxxxxxxxxxxxx";
  const messages = [
    chatMessage(1, "user", "Compare both images", {
      messageHash: hashes[0],
      attachments: descriptors,
    }),
    chatMessage(2, "assistant", "Both images compared", {
      previousHash: hashes[0],
      messageHash: hashes[1],
    }),
  ];
  let thread = chatThread({
    revision: 2,
    ledgerHash: hashes[1],
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const staleRead = Promise.withResolvers();
  const staleReadStarted = Promise.withResolvers();
  const attachmentReads = [];
  let staleSignal;
  let createdUrls = 0;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment({ attachment, signal }) {
      attachmentReads.push(attachment.attachmentId);
      if (attachmentReads.length === 1) {
        staleSignal = signal;
        staleReadStarted.resolve();
        return await staleRead.promise;
      }
      return { bytes, descriptor: attachment };
    },
    prepareRun(request) {
      return Object.freeze({
        ...request,
        generationId: followupGenerationId,
        idempotencyKey: "run_followup_gallery_xxxxxxxxxxx",
      });
    },
    async startRun(ticket) {
      messages.push(
        chatMessage(3, "user", ticket.content, {
          previousHash: hashes[1],
          messageHash: hashes[2],
        }),
        chatMessage(4, "assistant", "Blue", {
          previousHash: hashes[2],
          messageHash: hashes[3],
          generationId: followupGenerationId,
        }),
      );
      thread = chatThread({
        revision: 4,
        ledgerHash: hashes[3],
        messageCount: 4,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
      });
      return {
        request: ticket,
        generation: chatGeneration({
          generationId: followupGenerationId,
          status: "completed",
          terminal: true,
        }),
      };
    },
  });
  const browser = harness({
    chat,
    IntersectionObserver: observer.IntersectionObserver,
    createObjectUrl() { createdUrls += 1; return `blob:followup-gallery-${createdUrls}`; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const originalItems = [...observer.latest().targets];
  assert.equal(originalItems.length, 2);
  observer.latest().enter(originalItems[0]);
  observer.latest().enter(originalItems[1]);
  await staleReadStarted.promise;

  browser.document.getElementById("message-input").value = "What color was the first object?";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(staleSignal.aborted, true, "the old cosmetic read is fenced before the exact follow-up mutation");
  assert.match(browser.document.getElementById("messages").textContent,
    /Compare both images[\s\S]*Both images compared[\s\S]*What color was the first object\?[\s\S]*Blue/u);

  await new Promise((resolve) => setImmediate(resolve));
  const currentItems = [...observer.latest().targets];
  assert.equal(currentItems.length, 2, "the completed same-thread snapshot registers both stored images again");
  observer.latest().enter(currentItems[0]);
  observer.latest().enter(currentItems[1]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const currentImages = currentItems.map((item) => item.children[0]);
  assert.deepEqual(attachmentReads, [
    descriptors[0].attachmentId,
    descriptors[0].attachmentId,
    descriptors[1].attachmentId,
  ], "a stale unresolved task cannot retain the successor restoration slot");
  assert.deepEqual(currentImages.map((image) => image.dataset.previewState), ["ready", "ready"]);
  assert.deepEqual(currentImages.map((image) => image.alt), ["Attached image 1", "Attached image 2"]);

  staleRead.resolve({ bytes, descriptor: descriptors[0] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(currentImages.map((image) => image.dataset.previewState), ["ready", "ready"],
    "the late superseded response cannot replace the current DOM previews");
  assert.equal(createdUrls, 2, "the superseded private bytes never receive an object URL");
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
  threadOpenControls(browser.document)[0].dispatch("click");
  await sidebarReadStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(browser.document.getElementById("new-thread").disabled, false);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);

  listedThreads = [newerThread, thread];
  threadOpenControls(browser.document)[0].dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    threadOpenControls(browser.document).map((button) => button.dataset.threadId),
    [newerThread.threadId, thread.threadId],
  );

  sidebarRead.resolve({ threads: [thread] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    threadOpenControls(browser.document).map((button) => button.dataset.threadId),
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
  threadOpenControls(browser.document)[1].dispatch("click");
  await replacementReadStarted.promise;
  decodeGate.reject(new Error("stale image decode"));
  await initialization;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(revokedUrls, ["blob:stale-restored-image"]);
  assert.match(browser.document.getElementById("toast").textContent, /could not be restored safely/iu);
});

test("a confirmed logout suppresses a stale Direct Chat history failure without restoring private UI", async () => {
  const messages = [
    chatMessage(1, "user", "Private question"),
    chatMessage(2, "assistant", "Private answer"),
  ];
  const thread = chatThread({
    revision: 2,
    ledgerHash: CHAT_HASH_B,
    messageCount: 2,
    ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
  });
  const finalRead = Promise.withResolvers();
  const finalReadStarted = Promise.withResolvers();
  let guardedRead = 0;
  let deferSnapshot = false;
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() {
      if (deferSnapshot && ++guardedRead === 2) {
        finalReadStarted.resolve();
        return await finalRead.promise;
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
  });
  const browser = harness({ chat });
  await browser.app.initialize();
  const toast = browser.document.getElementById("toast");
  toast.textContent = "signed-out sentinel";
  toast.hidden = true;
  deferSnapshot = true;

  const opening = browser.app.openThread(CHAT_THREAD_ID);
  await finalReadStarted.promise;
  await browser.app.logout();
  finalRead.reject(new DirectChatTransportError("Direct Chat request was not accepted.", {
    code: "authentication_required",
    status: 401,
    retryable: false,
  }));
  await opening;

  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("app-view").hidden, true);
  assert.equal(browser.document.getElementById("messages").children.length, 0);
  assert.equal(toast.hidden, true, "a stale owner cannot surface a post-logout history error");
  assert.equal(toast.textContent, "signed-out sentinel");
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

test("a rollout-gated multi-image Chat send waits once and succeeds without an ambiguity status probe", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const attachmentIds = ["image_rollout_success_0000001", "image_rollout_success_0000002"];
  let thread = null;
  let messages = [];
  let preparedRun;
  let starts = 0;
  let retries = 0;
  let statusReads = 0;
  const waits = [];
  const accept = (ticket) => {
    messages = [
      chatMessage(1, "user", ticket.content),
      chatMessage(2, "assistant", "Accepted after the update"),
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
  };
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_rollout_success_0001" });
    },
    async createThread(ticket) {
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread === null ? [] : [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparedRun = request;
      return Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_rollout_success_000001",
      });
    },
    async startRun() {
      starts += 1;
      throw rolloutChatError(5_000);
    },
    async retryRun(ticket) {
      retries += 1;
      return accept(ticket);
    },
    async getRunStatus() {
      statusReads += 1;
      throw new Error("a definitive rollout rejection must not be status-probed");
    },
  });
  let objectUrlSerial = 0;
  const browser = harness({
    chat,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    async canonicalizeImage(file) {
      const index = file.name.endsWith("one.png") ? 0 : 1;
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
    createObjectUrl(blob) {
      objectUrlSerial += 1;
      return `blob:rollout-success-${blob.size}-${objectUrlSerial}`;
    },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  imageInput.files = [{ name: "one.png" }, { name: "two.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  browser.document.getElementById("message-input").value = "Describe both rollout images";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(starts, 1);
  assert.equal(retries, 1);
  assert.equal(statusReads, 0);
  assert.deepEqual(waits, [5_000]);
  assert.deepEqual(preparedRun.attachments.map(({ attachmentId }) => attachmentId), attachmentIds);
  assert.equal(browser.document.getElementById("message-input").value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("messages").textContent, /Accepted after the update/u);
});

test("repeated rollout rejection restores an exact two-image Chat composer and the same thread accepts the next send", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const attachmentIds = ["image_rollout_retry_00000001", "image_rollout_retry_00000002"];
  const draft = "  Keep both rollout images ready.\n  ";
  let thread = null;
  let messages = [];
  let creates = 0;
  let starts = 0;
  let retries = 0;
  let statusReads = 0;
  let preparations = 0;
  const prepared = [];
  const waits = [];
  const accept = (ticket) => {
    messages = [
      chatMessage(1, "user", ticket.content),
      chatMessage(2, "assistant", "Accepted on the same thread"),
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
      generation: chatGeneration({
        generationId: ticket.generationId,
        status: "completed",
        terminal: true,
      }),
    };
  };
  const chat = baseChat({
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread({ title }) {
      return Object.freeze({ threadId: CHAT_THREAD_ID, title, idempotencyKey: "thread_rollout_retry_00001" });
    },
    async createThread(ticket) {
      creates += 1;
      thread = chatThread({ title: ticket.title });
      return { request: ticket, thread };
    },
    async listThreads() { return { threads: thread === null ? [] : [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      preparations += 1;
      prepared.push(request);
      return Object.freeze({
        ...request,
        generationId: preparations === 1 ? CHAT_GENERATION_ID : "generation_rollout_retry_000002",
        idempotencyKey: `run_rollout_retry_00000${preparations}`,
      });
    },
    async startRun(ticket) {
      starts += 1;
      throw rolloutChatError(starts === 1 ? 2_000 : 1_000);
    },
    async retryRun(ticket) {
      retries += 1;
      if (retries === 1) throw rolloutChatError(4_000);
      return accept(ticket);
    },
    async getRunStatus() {
      statusReads += 1;
      throw new Error("a definitive rollout rejection must not be status-probed");
    },
  });
  let objectUrlSerial = 0;
  const browser = harness({
    chat,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    async canonicalizeImage(file) {
      const index = file.name.endsWith("one.png") ? 0 : 1;
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
    createObjectUrl() { objectUrlSerial += 1; return `blob:rollout-retry-${objectUrlSerial}`; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const imageInput = browser.document.getElementById("image-input");
  const input = browser.document.getElementById("message-input");
  imageInput.files = [{ name: "one.png" }, { name: "two.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  input.value = draft;
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.equal(retries, 1);
  assert.equal(statusReads, 0);
  assert.deepEqual(waits, [2_000], "the second rollout does not start another automatic retry");
  assert.equal(input.value, draft);
  assert.equal(browser.document.getElementById("image-preview").hidden, false);
  assert.match(browser.document.getElementById("image-preview-label").textContent, /2 images/u);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.match(browser.document.getElementById("toast").textContent, /prompt and images are still ready[\s\S]*retry shortly/iu);

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(creates, 1, "the rollout-created thread remains selected and usable");
  assert.equal(starts, 2);
  assert.equal(retries, 2);
  assert.equal(statusReads, 0);
  assert.deepEqual(waits, [2_000, 1_000]);
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared[1].attachments.map(({ attachmentId }) => attachmentId), attachmentIds);
  assert.equal(prepared[1].attachments[0].bytes, bytes);
  assert.equal(prepared[1].attachments[1].bytes, bytes);
  assert.equal(input.value, "");
  assert.equal(browser.document.getElementById("image-preview").hidden, true);
  assert.match(browser.document.getElementById("messages").textContent, /Accepted on the same thread/u);
});

test("Direct Chat ambiguity dominates later rollout and release fences until Resume confirms the exact ticket", async () => {
  let thread = chatThread();
  let messages = [];
  let prepared;
  const dispatches = [];
  const waits = [];
  const firstAmbiguity = Object.assign(new Error("accepted response was lost"), { retryable: true });
  const chat = baseChat({
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    prepareRun(request) {
      prepared = Object.freeze({
        ...request,
        generationId: CHAT_GENERATION_ID,
        idempotencyKey: "run_ambiguity_before_rollout_x",
      });
      return prepared;
    },
    async startRun(ticket) {
      dispatches.push(ticket);
      throw firstAmbiguity;
    },
    async retryRun(ticket) {
      dispatches.push(ticket);
      if (dispatches.length <= 4) throw rolloutChatError(1_000);
      if (dispatches.length === 5) {
        throw new DirectChatTransportError("new release is binding", {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: `release-${"e".repeat(64)}`,
        });
      }
      messages = [
        chatMessage(1, "user", ticket.content),
        chatMessage(2, "assistant", "Confirmed exact-ticket result"),
      ];
      thread = chatThread({
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
  const browser = harness({ chat, wait: async (milliseconds) => { waits.push(milliseconds); } });
  let reloads = 0;
  browser.window.location.reload = () => { reloads += 1; };
  await browser.app.initialize();
  const input = browser.document.getElementById("message-input");
  input.value = "Preserve this ambiguous Direct Chat turn";

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(dispatches.length, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(browser.document.getElementById("send-message").disabled, true);

  await browser.app.resume();
  assert.equal(dispatches.length, 4, "Resume makes only one bounded retry while rollout remains closed");
  assert.deepEqual(waits, [250, 1_000]);
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(browser.document.getElementById("send-message").disabled, true);

  await browser.app.resume();
  assert.equal(dispatches.length, 5);
  assert.equal(reloads, 0, "a later release mismatch cannot replace an older ambiguous receipt");
  assert.equal(browser.document.getElementById("resume-run").hidden, false);
  assert.equal(browser.document.getElementById("send-message").disabled, true);

  await browser.app.resume();
  assert.equal(dispatches.length, 6);
  assert.equal(dispatches.every((ticket) => ticket === prepared), true);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(browser.document.getElementById("send-message").disabled, false);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.match(browser.document.getElementById("messages").textContent, /Confirmed exact-ticket result/u);
});

test("not-sent image failures retain safe diagnostics and give a concise reason and recovery action", async (t) => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const cases = [
    {
      name: "expired sign-in",
      point: "snapshot",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "authentication_required", status: 401, retryable: false,
      }),
      diagnostic: ["authentication", "authentication_required", "snapshot"],
      expected: /sign-in expired[\s\S]*still ready[\s\S]*Sign in again/iu,
    },
    {
      name: "oversized upload",
      point: "run",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "request_too_large", status: 413, retryable: false,
      }),
      diagnostic: ["body_rejection", "request_too_large", "run_dispatch"],
      expected: /upload was too large[\s\S]*still ready[\s\S]*(Remove an image|smaller files)/iu,
    },
    {
      name: "rejected image format",
      point: "run",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "invalid_attachment", status: 422, retryable: false,
      }),
      diagnostic: ["body_rejection", "invalid_attachment", "run_dispatch"],
      expected: /image format or file was rejected[\s\S]*Replace the affected image/iu,
    },
    {
      name: "stale conversation revision",
      point: "run",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "conflict", status: 409, retryable: false,
      }),
      diagnostic: ["authoritative_conflict", "conflict", "run_dispatch"],
      expected: /conversation changed[\s\S]*Reopen this conversation/iu,
    },
    {
      name: "network timeout",
      point: "snapshot",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "request_timeout", status: 504, retryable: true,
      }),
      diagnostic: ["network_timeout", "request_timeout", "snapshot"],
      expected: /request timed out[\s\S]*Check your connection/iu,
    },
    {
      name: "conversation refresh failure",
      point: "snapshot",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "request_failed", status: 500, retryable: false,
      }),
      diagnostic: ["snapshot", "snapshot_unavailable", "snapshot"],
      expected: /conversation could not be refreshed[\s\S]*Check your connection[\s\S]*reopen it/iu,
    },
    {
      name: "service rejection",
      point: "run",
      error: () => new DirectChatTransportError("SERVER_INTERNAL_PRIVATE_MARKER", {
        code: "content_rejected", status: 422, retryable: false,
      }),
      diagnostic: ["authoritative_rejection", "request_rejected", "run_dispatch"],
      expected: /service rejected it before it ran[\s\S]*Edit it or retry/iu,
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const thread = chatThread();
      let failureEnabled = false;
      const chat = baseChat({
        async capabilities() {
          return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
        },
        async listThreads() { return { threads: [thread] }; },
        async getThread() {
          if (failureEnabled && candidate.point === "snapshot") throw candidate.error();
          return { thread };
        },
        async listMessages() { return { messages: [] }; },
        prepareRun(request) {
          return Object.freeze({
            ...request,
            generationId: CHAT_GENERATION_ID,
            idempotencyKey: "run_start_safe_failure_reason_x",
          });
        },
        async startRun() {
          if (candidate.point === "run") throw candidate.error();
          throw new Error("a snapshot failure cannot dispatch a run");
        },
      });
      const browser = harness({
        chat,
        async canonicalizeImage() {
          return Object.freeze({
            attachmentId: "image_safe_failure_reason_0001",
            mediaType: "image/png",
            byteLength: bytes.byteLength,
            width: 80,
            height: 80,
            bytes,
            previewBlob: new Blob([bytes], { type: "image/png" }),
          });
        },
        createObjectUrl() { return `blob:safe-failure-${candidate.name}`; },
        revokeObjectUrl() {},
      });
      await browser.app.initialize();
      const input = browser.document.getElementById("image-input");
      input.files = [{ name: "private.png" }];
      input.dispatch("change");
      await new Promise((resolve) => setImmediate(resolve));
      const draft = `Keep ${candidate.name} prompt and image`;
      browser.document.getElementById("message-input").value = draft;
      failureEnabled = true;

      await browser.app.submitMessage({ preventDefault() {} });

      const toast = browser.document.getElementById("toast").textContent;
      assert.match(toast, /image message was not sent[\s\S]*still ready/iu);
      assert.match(toast, candidate.expected);
      assert.doesNotMatch(toast, /SERVER_INTERNAL_PRIVATE_MARKER/u);
      assert.equal(browser.document.getElementById("message-input").value, draft);
      assert.equal(browser.document.getElementById("image-preview").hidden, false);
      assert.deepEqual(
        [
          browser.document.getElementById("workspace").dataset.failureStage,
          browser.document.getElementById("workspace").dataset.failureCode,
          browser.document.getElementById("workspace").dataset.failureOperation,
        ],
        candidate.diagnostic,
      );
    });
  }
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
  assert.equal(browser.document.getElementById("connection-state").textContent, "Request not sent · Conversation changed");
  assert.equal(browser.document.getElementById("workspace").dataset.failureStage, "authoritative_conflict");
  assert.equal(browser.document.getElementById("workspace").dataset.failureCode, "conflict");
  assert.equal(browser.document.getElementById("workspace").dataset.failureOperation, "run_dispatch");
  assert.match(browser.document.getElementById("toast").textContent,
    /not sent[\s\S]*conversation changed[\s\S]*prompt is still ready[\s\S]*Reopen/iu);
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
  const imageAction = browser.document.getElementById("add-image");
  assert.equal(imageAction.disabled, true);
  assert.equal(imageAction.textContent, "Preparing images…");
  assert.equal(imageAction.getAttribute("aria-label"), "Preparing images…");

  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(preparedRun, null, "a programmatic form submission cannot bypass the pending guard");
  assert.equal(message.value, "Keep this text-only prompt", "the blocked submission preserves typed text");
  assert.equal(send.disabled, false, "cancelling the pending selection releases the composer");
  assert.equal(imageAction.textContent, "Images");
  assert.equal(imageAction.getAttribute("aria-label"), "Add images");

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

test("slow image preparation is visible and cancellation or failure preserves the prior image draft", async () => {
  const pending = Promise.withResolvers();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const prepared = (serial) => Object.freeze({
    attachmentId: `image_prior_${serial}_xxxxxxxxxxxx`,
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 96,
    height: 96,
    bytes,
    previewBlob: new Blob([bytes], { type: "image/png" }),
  });
  let call = 0;
  let secondSignal;
  let objectUrls = 0;
  const browser = harness({
    chat: baseChat({
      async capabilities() {
        return {
          visionInput: true,
          visionMediaTypes: ["image/jpeg", "image/png"],
          maximumImageBytes: 4 * 1024 * 1024,
        };
      },
    }),
    canonicalizeImage(file, options) {
      call += 1;
      if (call === 1) return Promise.resolve(prepared("first"));
      if (call === 2) {
        secondSignal = options.signal;
        return pending.promise;
      }
      return Promise.reject(new TypeError("synthetic decoder failure"));
    },
    createObjectUrl() { objectUrls += 1; return `blob:prior-${objectUrls}`; },
    revokeObjectUrl() {},
  });
  await browser.app.initialize();
  const input = browser.document.getElementById("image-input");
  const message = browser.document.getElementById("message-input");
  const imageAction = browser.document.getElementById("add-image");
  const preview = browser.document.getElementById("image-preview");

  input.files = [{ name: "first.png" }];
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  message.value = "Keep this exact draft and first image";
  assert.equal(preview.hidden, false);
  assert.equal(browser.document.getElementById("image-preview-thumbnail").src, "blob:prior-1");

  input.files = [{ name: "slow-second.heic" }];
  input.dispatch("change");
  assert.equal(imageAction.textContent, "Preparing images…");
  assert.equal(imageAction.getAttribute("aria-label"), "Preparing images…");
  assert.equal(preview.hidden, false, "the already-prepared image stays visible during another decode");
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(secondSignal.aborted, true);
  assert.equal(message.value, "Keep this exact draft and first image");
  assert.equal(preview.hidden, false);
  assert.equal(imageAction.textContent, "Images");

  pending.resolve(prepared("stale-second"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(objectUrls, 1, "the cancelled late decode cannot attach a second preview");
  assert.match(browser.document.getElementById("image-preview-label").textContent, /96×96/u);

  input.files = [{ name: "broken-third.heic" }];
  input.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(message.value, "Keep this exact draft and first image");
  assert.equal(preview.hidden, false, "a later preparation failure does not discard the prior image");
  assert.equal(objectUrls, 1);
  assert.equal(imageAction.textContent, "Images");
  assert.match(browser.document.getElementById("toast").textContent, /could not be prepared safely/u);
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
  const preparationSignals = [];
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
    canonicalizeImage(file, options) {
      const deferred = pending[canonicalizations];
      assert.equal(options.timeoutMs, 15_000);
      preparationSignals.push(options.signal);
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
  assert.equal(preparationSignals[0].aborted, true);
  pending[0].resolve(selected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("image-preview").hidden, true);

  browser.app.setMode("chat", { restoreView: false });
  input.files = [{ name: "clear-race.png" }];
  input.dispatch("change");
  assert.equal(send.disabled, true);
  browser.document.getElementById("remove-image").dispatch("click");
  assert.equal(preparationSignals[1].aborted, true);
  assert.equal(send.disabled, false);
  pending[1].resolve(selected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.document.getElementById("image-preview").hidden, true);

  input.files = [{ name: "logout-race.png" }];
  input.dispatch("change");
  assert.equal(send.disabled, true);
  browser.document.getElementById("message-input").value = "private draft for this account only";
  await browser.app.logout();
  assert.equal(preparationSignals[2].aborted, true);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, true);
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
  assert.equal(threadOpenControls(browser.document)[0].disabled, false);
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
    maxAutomaticAgentReconnects: 7,
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

test("Agent reconnect exhausts a finite automatic budget then continues the same run and cursor read-only", async () => {
  const first = await verifiedEvent({
    seq: 1,
    type: "output.delta",
    payload: { text: "Only once" },
    previousHash: ZERO_HASH,
  });
  const terminal = await verifiedEvent({
    seq: 2,
    type: "run.completed",
    payload: {},
    previousHash: first.hash,
  });
  const streamCursors = [];
  const waits = [];
  let streams = 0;
  let statuses = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Reconnect exactly" } }; },
    async startRun() { starts += 1; return { run: run() }; },
    async resumeRun() { resumes += 1; throw new Error("a stream reconnect must never resume a run"); },
    async runStatus() { statuses += 1; return { run: run() }; },
    async *streamRunEvents(options) {
      streams += 1;
      streamCursors.push(options.cursor);
      if (streams === 1) yield { event: first, cursor: { seq: first.seq, hash: first.hash } };
      if (streams === 3) yield { event: terminal, cursor: { seq: terminal.seq, hash: terminal.hash } };
    },
  };
  const browser = harness({
    agent,
    maxAutomaticAgentReconnects: 1,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Reconnect this exact run";
  await browser.app.submitMessage({ preventDefault() {} });

  const reconnect = browser.document.getElementById("resume-run");
  assert.equal(streams, 2, "one initial stream plus one automatic reconnect exhausts the finite budget");
  assert.equal(statuses, 2, "each nonterminal boundary is authoritatively status-probed");
  assert.deepEqual(waits, [250]);
  assert.equal(reconnect.hidden, false);
  assert.equal(reconnect.textContent, "Reconnect");
  assert.equal(browser.document.getElementById("run-state").textContent, "Interrupted");
  assert.deepEqual(streamCursors.map((cursor) => cursor.seq), [0, 1]);

  await browser.app.resume();

  assert.equal(starts, 1);
  assert.equal(resumes, 0, "Reconnect is a read-only same-run operation, never runs/resume");
  assert.equal(statuses, 3, "the explicit reconnect probes the exact run before opening its stream");
  assert.equal(streams, 3);
  assert.deepEqual(streamCursors.map((cursor) => cursor.seq), [0, 1, 1]);
  assert.equal(
    browser.document.getElementById("messages").textContent.split("Only once").length - 1,
    1,
    "cursor continuation does not duplicate already-rendered output",
  );
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(reconnect.hidden, true);
  assert.equal(reconnect.textContent, "Resume");
});

test("a terminal status at the reconnect boundary receives one final verified ledger drain", async () => {
  const terminal = await verifiedEvent({
    seq: 1,
    type: "run.completed",
    payload: {},
    previousHash: ZERO_HASH,
  });
  const waits = [];
  let streams = 0;
  let statuses = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Terminal drain" } }; },
    async startRun() { starts += 1; return { run: run() }; },
    async resumeRun() { resumes += 1; throw new Error("a terminal drain must never resume a run"); },
    async runStatus() {
      statuses += 1;
      return { run: statuses === 2 ? terminalRun("completed", [terminal]) : run() };
    },
    async *streamRunEvents() {
      streams += 1;
      if (streams === 3) yield { event: terminal, cursor: { seq: terminal.seq, hash: terminal.hash } };
    },
  };
  const browser = harness({
    agent,
    maxAutomaticAgentReconnects: 1,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Finish at the boundary";
  await browser.app.submitMessage({ preventDefault() {} });

  assert.equal(starts, 1);
  assert.equal(resumes, 0);
  assert.equal(statuses, 2);
  assert.equal(streams, 3, "the terminal status permits exactly one additional read-only stream");
  assert.deepEqual(waits, [250, 250]);
  assert.equal(browser.document.getElementById("workspace").dataset.status, "completed");
  assert.equal(browser.document.getElementById("run-state").textContent, "Completed");
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
});

test("an authentication reset rejects an in-flight stale Agent reconnect descriptor", async () => {
  const first = await verifiedEvent({
    seq: 1,
    type: "output.delta",
    payload: { text: "Before sign-out" },
    previousHash: ZERO_HASH,
  });
  const reconnectProbe = Promise.withResolvers();
  const reconnectProbeStarted = Promise.withResolvers();
  let streams = 0;
  let statuses = 0;
  let starts = 0;
  let resumes = 0;
  const agent = {
    ...baseAgent(capabilities({ enabled: true, actions: { cancel: true, resume: true, retry: false } })),
    async createThread() { return { thread: { id: THREAD_ID, title: "Stale reconnect" } }; },
    async startRun() { starts += 1; return { run: run() }; },
    async resumeRun() { resumes += 1; throw new Error("stale reconnect must never mutate"); },
    async runStatus() {
      statuses += 1;
      if (statuses === 2) {
        reconnectProbeStarted.resolve();
        return await reconnectProbe.promise;
      }
      return { run: run() };
    },
    async *streamRunEvents() {
      streams += 1;
      if (streams === 1) yield { event: first, cursor: { seq: first.seq, hash: first.hash } };
    },
  };
  const browser = harness({ agent, maxAutomaticAgentReconnects: 0 });
  await browser.app.initialize();
  browser.document.getElementById("message-input").value = "Fence this reconnect";
  await browser.app.submitMessage({ preventDefault() {} });
  assert.equal(browser.document.getElementById("resume-run").textContent, "Reconnect");

  const reconnecting = browser.app.resume();
  await reconnectProbeStarted.promise;
  await browser.app.logout();
  reconnectProbe.resolve({ run: run() });
  await reconnecting;

  assert.equal(starts, 1);
  assert.equal(resumes, 0);
  assert.equal(statuses, 2);
  assert.equal(streams, 1, "the descriptor cannot open a stream after its session/view ownership is reset");
  assert.equal(browser.document.getElementById("login-view").hidden, false);
  assert.equal(browser.document.getElementById("resume-run").hidden, true);
  assert.equal(browser.document.getElementById("resume-run").textContent, "Resume");
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
  const releaseReload = /function replaceWithRelease\([^)]*\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? "";
  assert.match(releaseReload, /purgeAttachmentMemory\(\)/u, "release navigation purges private in-memory attachment state");
  assert.match(source, /addEventListener\?\.\("pagehide", \(event\) => \{[\s\S]*?event\?\.persisted !== true[\s\S]*?purgeAttachmentMemory\(\)/u);
});
