import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

import {
  AGENT_WEB_CACHE_PREFIX,
  AGENT_WEB_EMERGENCY_PREDECESSOR_DIGESTS,
  AGENT_WEB_MODULE_ROUTES,
  AGENT_WEB_RELEASE_ROOT,
  BRIGHT_APP_CSS,
  agentWebCacheName,
  agentWebScopeIdentity,
  applyTheme,
  createBrowserRuntimeConfig,
  createAppShellHtml,
  createPwaManifest,
  normalizeAgentWebBasePath,
  offerPasswordManagerSave,
  rememberWorkspaceMode,
  restoreTheme,
  restoreWorkspaceMode,
  versionedAgentWebAsset,
} from "../src/web/pwa-assets.js";
import { createBrowserApp } from "../src/web/browser-app.js";
import {
  STANDALONE_ROOT_CONTENT_SECURITY_POLICY,
  STANDALONE_SHELL_SECURITY_HEADERS,
  createStandaloneAssetMap,
  verifyStandaloneAssetMap,
} from "../src/web/asset-map.js";
import { createSafeRenderer } from "../src/web/safe-rendering.js";
import { canonicalJson, verifyAgentEvent } from "../src/web/aginti-protocol.js";
import { DirectChatProtocolError, DirectChatTransportError } from "../src/web/direct-chat-client.js";

const ARTIFACT_ID = `art_${"a".repeat(64)}`;
const CURRENT_RELEASE = `release-${"a".repeat(64)}`;
const NEXT_RELEASE = `release-${"b".repeat(64)}`;
const LATER_RELEASE = `release-${"c".repeat(64)}`;
const OLD_RELEASE = `release-${"0".repeat(64)}`;
const BOOTSTRAP_IMPORTS = `
  import katex from "./katex.mjs";
  import { createBrowserApp } from "./browser-app.js";
  import { AgintiBrowserClient } from "./aginti-client.js";
  import { CloudSessionClient } from "./cloud-session-client.js";
  import { DirectChatBrowserClient } from "./direct-chat-client.js";
  import { createSafeRenderer } from "./safe-rendering.js";
  void [katex, createBrowserApp, AgintiBrowserClient, CloudSessionClient, DirectChatBrowserClient, createSafeRenderer];
`;

async function productionMap({
  label = "test",
  marker = "",
  basePath = "/",
  bootstrapSource,
  title,
  loginPath,
  name,
  shortName,
} = {}) {
  return await createStandaloneAssetMap({
    bootstrapSource: bootstrapSource ?? `${BOOTSTRAP_IMPORTS}\n// ${marker}`,
    versionLabel: label,
    basePath,
    ...(title === undefined ? {} : { title }),
    ...(loginPath === undefined ? {} : { loginPath }),
    ...(name === undefined ? {} : { name }),
    ...(shortName === undefined ? {} : { shortName }),
  });
}

class ClassList {
  constructor(owner) { this.owner = owner; }
  add(...names) {
    const values = new Set(this.owner.className.split(/\s+/u).filter(Boolean));
    names.forEach((name) => values.add(name));
    this.owner.className = [...values].join(" ");
  }
  contains(name) { return this.owner.className.split(/\s+/u).includes(name); }
}

class DomNode {
  constructor(tagName, text = "") {
    this.tagName = tagName;
    this.nodeValue = text;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.classList = new ClassList(this);
    this.dataset = {};
    this.style = {};
    this.href = "";
    this.rel = "";
    this.target = "";
    this.scope = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.listeners = new Map();
  }
  appendChild(child) {
    if (child.tagName === "#fragment") {
      for (const entry of [...child.children]) this.appendChild(entry);
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  focus() { this.focused = true; }
  get textContent() {
    return this.tagName === "#text" ? this.nodeValue : this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) { this.children = [new DomNode("#text", String(value))]; }
  walk() {
    const result = [];
    const visit = (node) => { result.push(node); node.children.forEach(visit); };
    this.children.forEach(visit);
    return result;
  }
}

class DomDocument {
  constructor() {
    this.documentElement = new DomNode("html");
    this.ids = new Map();
    this.metas = new Map();
    this.visibilityState = "visible";
    this.listeners = new Map();
  }
  createElement(name) { return new DomNode(name.toLowerCase()); }
  createElementNS(unused, name) { return new DomNode(name.toLowerCase()); }
  createTextNode(value) { return new DomNode("#text", String(value)); }
  createDocumentFragment() { return new DomNode("#fragment"); }
  getElementById(id) { return this.ids.get(id) ?? null; }
  querySelector(selector) {
    const match = /^meta\[name="([A-Za-z0-9._~-]+)"\]$/u.exec(selector);
    return match ? this.metas.get(match[1]) ?? null : null;
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const APP_IDS = [
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

function appDocument({ basePath = "/", releaseId = CURRENT_RELEASE } = {}) {
  const document = new DomDocument();
  APP_IDS.forEach((id) => document.ids.set(id, new DomNode(id === "login-form" || id === "composer" ? "form" : "div")));
  const scope = normalizeAgentWebBasePath(basePath);
  const workerPath = scope === "/" ? "/sw.js" : `${scope.slice(0, -1)}/sw.js`;
  for (const [name, content] of [
    ["lazying-agent-release", releaseId],
    ["lazying-agent-base-path", scope],
    ["lazying-agent-service-worker", workerPath],
  ]) {
    const meta = new DomNode("meta");
    meta.setAttribute("content", content);
    document.metas.set(name, meta);
  }
  document.getElementById("app-view").hidden = true;
  document.getElementById("update-banner").hidden = true;
  document.getElementById("login-submit").disabled = true;
  document.getElementById("login-submit").textContent = "Preparing secure sign-in…";
  document.getElementById("login-form").setAttribute("aria-busy", "true");
  document.getElementById("logout").disabled = true;
  document.getElementById("remember-session").checked = true;
  return document;
}

function artifact(kind, spec) {
  return { id: ARTIFACT_ID, title: "Safe result", kind, spec };
}

function threadOpenControl(row) {
  return row?.className === "thread-row" ? row.children[0] : row;
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      const current = listeners.get(name) ?? [];
      current.push(listener);
      listeners.set(name, current);
    },
    dispatch(name, event = {}) {
      for (const listener of listeners.get(name) ?? []) listener(event);
    },
  };
}

function workerVm(source, {
  cacheStores = new Map(),
  assetMap,
  networkPrefix = "network",
  responseOverride,
  clock = { value: 1_000 },
  operations = [],
  windowClients = [],
  clientClaim = () => undefined,
  workerSetTimeout = setTimeout,
  workerClearTimeout = clearTimeout,
} = {}) {
  const listeners = new Map();
  let online = true;
  let skipWaitingCalls = 0;
  let claimCalls = 0;

  class FakeResponse {
    constructor(value, {
      ok = true,
      status = ok ? 200 : 500,
      type = "basic",
      url = "",
      redirected = false,
      headers = {},
      contentType,
    } = {}) {
      this.value = value;
      this.bytes = value instanceof Uint8Array ? value.slice() : new TextEncoder().encode(String(value));
      this.ok = ok;
      this.status = status;
      this.type = type;
      this.url = url;
      this.redirected = redirected;
      this.headerValues = new Map();
      if (typeof headers?.forEach === "function") headers.forEach((entry, name) => this.headerValues.set(name.toLowerCase(), String(entry)));
      else for (const [name, entry] of Object.entries(headers)) this.headerValues.set(name.toLowerCase(), String(entry));
      if (contentType) this.headerValues.set("content-type", contentType);
      this.headers = { get: (name) => this.headerValues.get(String(name).toLowerCase()) ?? null };
    }
    clone() {
      return new FakeResponse(this.bytes, {
        ok: this.ok, status: this.status, type: this.type, url: this.url, redirected: this.redirected,
        headers: Object.fromEntries(this.headerValues),
      });
    }
    async arrayBuffer() { return this.bytes.slice().buffer; }
    async json() { return JSON.parse(new TextDecoder().decode(this.bytes)); }
    static error() { return new FakeResponse("error", { ok: false, type: "error" }); }
  }

  class FakeRequest {
    constructor(value, options = {}) {
      this.url = new URL(typeof value === "string" ? value : value.url, "https://llm.lazying.art/").href;
      this.method = options.method ?? value.method ?? "GET";
      this.mode = options.mode ?? value.mode ?? "cors";
      this.redirect = options.redirect ?? value.redirect ?? "follow";
      const supplied = options.headers ?? value.headers;
      this.headers = {
        has(name) { return supplied?.has?.(name) ?? false; },
        get(name) { return supplied?.get?.(name) ?? null; },
      };
    }
  }

  class FakeCache {
    constructor(name) { this.name = name; this.values = new Map(); }
    key(value) {
      const raw = typeof value === "string" ? value : value.url;
      const url = new URL(raw, "https://llm.lazying.art/");
      return url.pathname + url.search;
    }
    async put(key, value) { this.values.set(this.key(key), value); }
    async match(key) { return this.values.get(this.key(key)); }
  }

  const caches = {
    async open(name) {
      if (!cacheStores.has(name)) cacheStores.set(name, new FakeCache(name));
      return cacheStores.get(name);
    },
    async keys() { return [...cacheStores.keys()]; },
    async delete(name) { operations.push(`delete:${name}`); return cacheStores.delete(name); },
    async match(key) {
      for (const cache of cacheStores.values()) {
        const value = await cache.match(key);
        if (value !== undefined) return value;
      }
      return undefined;
    },
  };

  const self = {
    location: { origin: "https://llm.lazying.art" },
    clients: {
      claim() { claimCalls += 1; operations.push("claim"); return clientClaim(); },
      async matchAll(options) {
        operations.push(`matchAll:${options?.type ?? ""}:${options?.includeUncontrolled === true}`);
        return windowClients;
      },
    },
    async skipWaiting() { skipWaitingCalls += 1; },
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  class FakeDate extends Date { static now() { const value = clock.value; clock.value += 1; return value; } }
  const context = vm.createContext({
    crypto: globalThis.crypto,
    Date: FakeDate,
    URL,
    Request: FakeRequest,
    Response: FakeResponse,
    caches,
    self,
    setTimeout: workerSetTimeout,
    clearTimeout: workerClearTimeout,
    fetch: async (request) => {
      if (!online) throw new Error("offline");
      const url = new URL(request.url);
      const route = url.pathname + url.search;
      const entry = assetMap?.get(route);
      let response = entry
        ? new FakeResponse(entry.body, { url: url.href, headers: entry.headers, contentType: entry.contentType })
        : new FakeResponse(`${networkPrefix}:${route}`, { url: url.href, contentType: "text/plain" });
      if (responseOverride) response = responseOverride({ request, route, entry, response, FakeResponse }) ?? response;
      return response;
    },
  });
  new vm.Script(source).runInContext(context);

  async function dispatch(type, data = {}) {
    let lifetime;
    let response;
    let responded = false;
    const event = {
      ...data,
      waitUntil(value) { lifetime = Promise.resolve(value); },
      respondWith(value) { responded = true; response = Promise.resolve(value); },
    };
    listeners.get(type)?.(event);
    if (lifetime) await lifetime;
    return { responded, response: response ? await response : undefined };
  }

  return {
    caches,
    cacheStores,
    dispatch,
    FakeRequest,
    FakeResponse,
    setOnline(value) { online = value; },
    snapshot() {
      return [...cacheStores.entries()].map(([name, cache]) => [name, [...cache.values.keys()].sort()]).sort();
    },
    operations,
    get skipWaitingCalls() { return skipWaitingCalls; },
    get claimCalls() { return claimCalls; },
  };
}

function updateEnvironment({
  waiting = true,
  waitingReleaseId = NEXT_RELEASE,
  respondToReleaseQuery = true,
  controlled = true,
  activeReleaseId = CURRENT_RELEASE,
  respondToActiveReleaseQuery = true,
  onUpdate = async () => {},
  registerPromise,
} = {}) {
  const workerMessages = [];
  const workerReleaseQueries = [];
  let serviceWorker;
  const makeWorker = (releaseId = NEXT_RELEASE, { respond = true } = {}) => Object.assign(eventTarget(), {
    releaseId,
    throwOnPost: false,
    postMessage(value, transfer = []) {
      if (this.throwOnPost) throw new Error("postMessage failed");
      if (value?.type === "GET_LAZYING_AGENT_RELEASE") {
        workerReleaseQueries.push({ worker: this, releaseId: this.releaseId });
        if (!respond) return;
        const response = { type: "LAZYING_AGENT_RELEASE", releaseId: this.releaseId };
        if (transfer[0]?.postMessage) transfer[0].postMessage(response);
        else serviceWorker.dispatch("message", { data: response, source: this });
        return;
      }
      workerMessages.push(value);
    },
  });
  const waitingWorker = makeWorker(waitingReleaseId, { respond: respondToReleaseQuery });
  const registration = Object.assign(eventTarget(), {
    waiting: waiting ? waitingWorker : null,
    installing: null,
    active: null,
    updateCalls: 0,
    async update() { this.updateCalls += 1; await onUpdate(this.updateCalls); },
  });
  let controllerNumber = 0;
  const makeController = (releaseId = null, { respond = true } = {}) => Object.assign(eventTarget(), {
    scriptURL: `https://llm.lazying.art/sw.js#controller-${controllerNumber += 1}`,
    releaseId,
    messages: [],
    postMessage(value, transfer = []) {
      this.messages.push(value);
      if (value?.type !== "GET_LAZYING_AGENT_RELEASE" || !respond || this.releaseId === null) return;
      const response = { type: "LAZYING_AGENT_RELEASE", releaseId: this.releaseId };
      if (transfer[0]?.postMessage) transfer[0].postMessage(response);
      else serviceWorker.dispatch("message", { data: response, source: this });
    },
  });
  const activeController = controlled
    ? makeController(activeReleaseId, { respond: respondToActiveReleaseQuery })
    : null;
  registration.active = activeController;
  serviceWorker = Object.assign(eventTarget(), {
    controller: activeController,
    registerCalls: [],
    async register(path, options) {
      this.registerCalls.push([path, options]);
      if (registerPromise) return await registerPromise;
      return registration;
    },
  });
  const transitionController = (releaseId = null, { respond = true } = {}) => {
    const controller = makeController(releaseId, { respond });
    registration.active = controller;
    serviceWorker.controller = controller;
    serviceWorker.dispatch("controllerchange");
    return controller;
  };
  return { registration, serviceWorker, waitingWorker, workerMessages, workerReleaseQueries, makeWorker, transitionController };
}

class FakeMessageChannel {
  constructor() {
    let receive = null;
    this.port1 = {
      addEventListener(name, listener) { if (name === "message") receive = listener; },
      start() {},
      close() { receive = null; },
    };
    this.port2 = {
      postMessage(value) { receive?.({ data: value }); },
      close() {},
    };
  }
}

function updateControllerHarness({
  waiting = true,
  controlled = true,
  now = () => 0,
  online = true,
  onUpdate = async () => {},
  basePath = "/",
  releaseId = CURRENT_RELEASE,
  environment,
  registerPromise,
  restore = async () => ({ authenticated: false }),
  login = async () => ({ authenticated: false }),
  locationHref,
  agent,
  chat,
  renderer,
  canonicalizeImage,
  createObjectUrl,
  revokeObjectUrl,
  updateHandoffStore,
  confirmThreadDeletion,
  wait,
} = {}) {
  const document = appDocument({ basePath, releaseId });
  const shared = environment ?? updateEnvironment({ waiting, controlled, onUpdate, registerPromise });
  const { registration, serviceWorker, waitingWorker, workerMessages } = shared;
  let reloads = 0;
  const replacements = [];
  const historyReplacements = [];
  let nextTimer = 1;
  const timers = new Map();
  const window = Object.assign(eventTarget(), {
    MessageChannel: FakeMessageChannel,
    location: {
      protocol: "https:", href: locationHref ?? `https://llm.lazying.art${normalizeAgentWebBasePath(basePath)}`,
      reload() { reloads += 1; },
      replace(value) { replacements.push(String(value)); this.href = String(value); },
    },
    setTimeout(callback, delay) { const id = nextTimer; nextTimer += 1; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  window.history = {
    state: null,
    replaceState(value, unused, target) {
      this.state = value;
      historyReplacements.push(String(target));
      window.location.href = new URL(String(target), window.location.href).href;
    },
  };
  const navigator = { onLine: online, serviceWorker };
  let restoreCalls = 0;
  const app = createBrowserApp({
    document,
    window,
    navigator,
    sessionClient: {
      async restore() { restoreCalls += 1; return await restore(); },
      async login(input) { return await login(input); },
      async logout() { return { signedOut: true, agentCancellationPending: false }; },
    },
    createAgentClient() {
      if (!agent) throw new Error("signed-out initialization must not create Agent client");
      return agent;
    },
    createChatClient() {
      if (!chat) throw new Error("signed-out initialization must not create Chat client");
      return {
        prepareThreadDeletion() { throw new Error("unexpected Direct Chat deletion"); },
        async deleteThread() { throw new Error("unexpected Direct Chat deletion"); },
        async retryDeleteThread() { throw new Error("unexpected Direct Chat deletion retry"); },
        ...chat,
      };
    },
    renderer: renderer ?? {
      renderMarkdown(target, value) { target.textContent = value; },
      renderArtifact() { return false; },
    },
    credentialSaver: async () => false,
    now,
    ...(canonicalizeImage === undefined ? {} : { canonicalizeImage }),
    ...(createObjectUrl === undefined ? {} : { createObjectUrl }),
    ...(revokeObjectUrl === undefined ? {} : { revokeObjectUrl }),
    ...(updateHandoffStore === undefined ? {} : { updateHandoffStore }),
    ...(confirmThreadDeletion === undefined ? {} : { confirmThreadDeletion }),
    ...(wait === undefined ? {} : { wait }),
  });
  return {
    app,
    document,
    registration,
    navigator,
    window,
    serviceWorker,
    makeWorker: shared.makeWorker,
    transitionController: shared.transitionController,
    waitingWorker,
    workerMessages,
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (delay === undefined || timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get timers() { return [...timers.values()].map((timer) => timer.delay); },
    get restoreCalls() { return restoreCalls; },
    get reloads() { return reloads; },
    get replacements() { return [...replacements]; },
    get historyReplacements() { return [...historyReplacements]; },
  };
}

function memoryUpdateHandoffStore(initial = []) {
  const records = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  const calls = { save: 0, take: 0, discard: 0 };
  let savedResolve;
  const saved = new Promise((resolve) => { savedResolve = resolve; });
  return {
    calls,
    records,
    saved,
    async save(record) {
      calls.save += 1;
      records.set(`${record.scope}\u0000${record.handoffId}`, structuredClone(record));
      savedResolve();
    },
    async take(scope, handoffId) {
      calls.take += 1;
      const key = `${scope}\u0000${handoffId}`;
      const record = records.get(key);
      records.delete(key);
      return record === undefined ? null : structuredClone(record);
    },
    async discard(scope, handoffId) {
      calls.discard += 1;
      records.delete(`${scope}\u0000${handoffId}`);
    },
  };
}

function canonicalPngHeader(width = 64, height = 64) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function completedAgentRun({ id, threadId, previousRunId = null, createdAt, lastHash, output = "Done" }) {
  return Object.freeze({
    id,
    threadId,
    previousRunId,
    status: "completed",
    createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    cancelRequestedAt: null,
    output,
    error: null,
    authority: Object.freeze({
      kind: "aginti",
      snapshotHash: "d".repeat(64),
      runtimeRevision: 1,
      contextDigest: "e".repeat(64),
    }),
    eventCursor: Object.freeze({ firstSeq: 1, lastSeq: 1, lastHash, prunedThroughSeq: 0 }),
  });
}

function idleAuthenticatedPwaClients(mutationCalls = { prepareThread: 0, createThread: 0, startRun: 0 }) {
  const agent = {
    async capabilities() {
      return {
        schemaVersion: "1",
        enabled: false,
        agent: { kind: "aginti", label: "AgInTi Agent" },
        model: { label: "LocalLLM" },
        actions: { cancel: false, resume: false, retry: false },
        attachments: { enabled: false },
        artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
      };
    },
    async listThreads() { return { threads: [] }; },
    async *streamRunEvents() {},
  };
  const chat = {
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread() { mutationCalls.prepareThread += 1; throw new Error("must not prepare during restore"); },
    async createThread() { mutationCalls.createThread += 1; throw new Error("must not create during restore"); },
    async retryCreateThread() { throw new Error("must not retry during restore"); },
    async listThreads() { return { threads: [] }; },
    async getThread() { throw new Error("no thread exists"); },
    prepareThreadDeletion() { throw new Error("must not prepare deletion during restore"); },
    async deleteThread() { throw new Error("must not delete during restore"); },
    async retryDeleteThread() { throw new Error("must not retry deletion during restore"); },
    async listMessages() { return { messages: [] }; },
    async getAttachment() { throw new Error("no attachment exists"); },
    prepareRun() { throw new Error("must not prepare a run during restore"); },
    async startRun() { mutationCalls.startRun += 1; throw new Error("must not send during restore"); },
    async retryRun() { throw new Error("must not retry during restore"); },
    async getRunStatus() { throw new Error("no run exists"); },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("no run exists"); },
    async cancelRun() { throw new Error("no run exists"); },
  };
  return { agent, chat, mutationCalls };
}

async function stageEncryptedTextUpdateHandoff() {
  const clients = idleAuthenticatedPwaClients();
  const store = memoryUpdateHandoffStore();
  const environment = updateEnvironment();
  const source = updateControllerHarness({
    environment,
    now: () => 20_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: clients.agent,
    chat: clients.chat,
    updateHandoffStore: store,
  });
  await source.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  source.document.getElementById("message-input").value = "private handoff draft";
  source.document.getElementById("apply-update").dispatch("click");
  await store.saved;
  await new Promise((resolve) => setImmediate(resolve));
  environment.registration.waiting = null;
  environment.transitionController(NEXT_RELEASE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.replacements.length, 1);
  return { href: source.replacements[0], record: [...store.records.entries()][0] };
}

async function legacyV2DraftHandoff({
  draft = "Continue the exact TeX and PDF task",
  createdAt = 50_000,
} = {}) {
  const encoder = new TextEncoder();
  const handoffId = "7".repeat(64);
  const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const keyText = Buffer.from(keyBytes).toString("base64url");
  const accountDigest = createHash("sha256")
    .update(encoder.encode("lazying-agent-update-account\u0000account-user"))
    .digest("hex");
  const encode = (value) => {
    const metadata = encoder.encode(JSON.stringify(value));
    const bytes = new Uint8Array(4 + metadata.byteLength);
    new DataView(bytes.buffer).setUint32(0, metadata.byteLength);
    bytes.set(metadata, 4);
    return bytes;
  };
  const unsigned = {
    schemaVersion: "2",
    scope: "/",
    sourceRelease: CURRENT_RELEASE,
    targetRelease: NEXT_RELEASE,
    createdAt,
    accountDigest,
    threadId: null,
    draft,
    images: [],
  };
  const record = {
    ...unsigned,
    digest: createHash("sha256").update(encode(unsigned)).digest("hex"),
  };
  const envelope = {
    schemaVersion: "2",
    scope: "/",
    handoffId,
    sourceRelease: CURRENT_RELEASE,
    targetRelease: NEXT_RELEASE,
    createdAt,
    expiresAt: createdAt + 5 * 60 * 1_000,
  };
  const iv = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: encoder.encode(JSON.stringify(envelope)),
    tagLength: 128,
  }, key, encode(record)));
  const stored = { ...envelope, iv, ciphertext };
  return {
    href: `https://llm.lazying.art/?v=${NEXT_RELEASE}#lazying-update-handoff=${handoffId}.${keyText}`,
    storageEntry: [`/\u0000${handoffId}`, stored],
  };
}

async function currentV3AgentDraftHandoff({
  draft,
  threadId,
  search,
  mode = "agent",
  createdAt = 60_000,
} = {}) {
  const encoder = new TextEncoder();
  const handoffId = "8".repeat(64);
  const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
  const keyText = Buffer.from(keyBytes).toString("base64url");
  const encode = (value) => {
    const metadata = encoder.encode(JSON.stringify(value));
    const bytes = new Uint8Array(4 + metadata.byteLength);
    new DataView(bytes.buffer).setUint32(0, metadata.byteLength);
    bytes.set(metadata, 4);
    return bytes;
  };
  const unsigned = {
    schemaVersion: "3",
    scope: "/",
    sourceRelease: CURRENT_RELEASE,
    targetRelease: NEXT_RELEASE,
    createdAt,
    accountDigest: createHash("sha256")
      .update(encoder.encode("lazying-agent-update-account\u0000account-user"))
      .digest("hex"),
    threadId,
    draft,
    mode,
    search: mode === "agent" ? search : null,
    images: [],
  };
  const record = {
    ...unsigned,
    digest: createHash("sha256").update(encode(unsigned)).digest("hex"),
  };
  const envelope = {
    schemaVersion: "2",
    scope: "/",
    handoffId,
    sourceRelease: CURRENT_RELEASE,
    targetRelease: NEXT_RELEASE,
    createdAt,
    expiresAt: createdAt + 5 * 60 * 1_000,
  };
  const iv = Uint8Array.from({ length: 12 }, (_, index) => 0xb0 + index);
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: encoder.encode(JSON.stringify(envelope)),
    tagLength: 128,
  }, key, encode(record)));
  return {
    href: `https://llm.lazying.art/?v=${NEXT_RELEASE}#lazying-update-handoff=${handoffId}.${keyText}`,
    storageEntry: [`/\u0000${handoffId}`, { ...envelope, iv, ciphertext }],
  };
}

function enabledAgentPwaCapability({ imageInput = false } = {}) {
  return Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: imageInput
      ? Object.freeze({
          enabled: true,
          transport: "inline-base64",
          acceptedMediaTypes: Object.freeze(["image/png", "image/jpeg"]),
          maximumCount: 4,
          maximumBytesEach: 4 * 1024 * 1024,
          maximumBytesTotal: 16 * 1024 * 1024,
          requestTimeoutMs: 515_000,
          model: "localllm-vision",
          persistence: "retained-reference-v1",
        })
      : Object.freeze({ enabled: false }),
    search: Object.freeze({
      enabled: true,
      modes: Object.freeze(["web", "papers", "both"]),
      maximumSources: 20,
    }),
    artifacts: Object.freeze({
      kinds: Object.freeze(["plot", "table", "markdown", "sources"]),
      schemaVersion: "1",
    }),
  });
}

function emptyAgentPwaThread({ id, title, instant = "2026-08-25T15:00:00.000Z" }) {
  return Object.freeze({
    id,
    title,
    status: "idle",
    revision: 1,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: null,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: "9".repeat(64),
      lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([]),
  });
}

async function settlePwaActions(turns = 2) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function settlePwaUntil(predicate, turns = 100) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

test("content-addressed PWA shell is bright and has safe session/password-manager semantics", async () => {
  const map = await productionMap({ label: "shell" });
  const rootDescriptor = map.get("/");
  const versionedRoot = map.get(`/?v=${map.releaseVersion}`);
  const html = rootDescriptor.body;
  const manifest = JSON.parse(map.get(`/manifest.webmanifest?v=${map.releaseVersion}`).body);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#f7faf9");
  assert.equal(versionedRoot.body, rootDescriptor.body);
  assert.deepEqual(versionedRoot.headers, rootDescriptor.headers);
  assert(html.indexOf('id="update-banner"') < html.indexOf('id="login-view"'));
  assert.match(html, /<html lang="en" data-theme="bright">/u);
  assert.match(html, /autocomplete="username"/u);
  assert.match(html, /autocomplete="current-password"/u);
  assert.match(html, /<form id="login-form"[^>]*method="post"[^>]*action="\/api\/login"/u);
  assert.match(html, /<form id="login-form"[^>]*aria-busy="true"/u);
  assert.match(html, /<button id="login-submit"[^>]*type="submit"[^>]*disabled>Preparing secure sign-in…<\/button>/u);
  assert.equal([...html.matchAll(/id="login-submit"/gu)].length, 1);
  assert.match(html, /<button id="logout"[^>]*type="button"[^>]*disabled>Sign out<\/button>/u);
  assert.match(html, new RegExp(`href="${map.releaseNamespace}/app\\.css"`, "u"));
  assert.match(html, new RegExp(`src="${map.releaseNamespace}/app\\.js"`, "u"));
  assert.match(html, /meta name="lazying-agent-base-path" content="\/"/u);
  assert.match(html, /meta name="lazying-agent-service-worker" content="\/sw\.js"/u);
  assert.match(html, /id="remember-session"[^>]*checked/u);
  assert.match(html, /Password saving is handled only by your browser or password manager/u);
  assert.match(html, /id="agent-mode"[^>]*aria-pressed="false"/u);
  assert.match(html, /id="mode-switch"[^>]*hidden/u);
  assert.match(html, /<aside id="activity-panel"[^>]*hidden>[\s\S]*<details id="activity-disclosure" class="activity-disclosure">/u);
  assert.match(html, /<summary><strong>Agent activity<\/strong><span id="run-state">Idle<\/span><\/summary>/u);
  assert.doesNotMatch(html, /<details id="activity-disclosure"[^>]*\sopen(?:\s|>)/u);
  assert.match(html, /<button id="send-message"[^>]*aria-label="Send Chat"[^>]*>Send Chat<\/button>/u);
  assert.match(html, /<div id="chat-bottom"[^>]*aria-hidden="true"><\/div>[\s\S]*<button id="go-to-bottom"[^>]*aria-label="Go to newest message"[^>]*hidden>↓<\/button>/u);
  assert.match(html, /id="capability-note"[^>]*>Chat · LocalLLM text only · no tools, file creation, or web search\.<\/p>/u);
  assert.match(html, /<details class="topbar-info">[\s\S]*<summary aria-label="Show app and capability information">Info<\/summary>[\s\S]*id="capability-note"[\s\S]*<\/details>[\s\S]*<\/header>/u);
  assert.doesNotMatch(html, /class="footer-note"/u);
  assert.doesNotMatch(html, /name="(?:model|provider|runtime|tools|cwd|sandbox)/iu);
  assert.doesNotMatch(html, /value="[^"\n]*(?:password|token|secret)/iu);
  assert.match(BRIGHT_APP_CSS, /^:root \{[\s\S]*--bg: #f4f7f6/u);
  assert.match(BRIGHT_APP_CSS, /:root\[data-theme="dark"\]/u);
  assert.equal(rootDescriptor.headers["content-security-policy"], STANDALONE_ROOT_CONTENT_SECURITY_POLICY);
  for (const [name, value] of Object.entries(STANDALONE_SHELL_SECURITY_HEADERS)) {
    assert.equal(rootDescriptor.headers[name], value);
  }
});

test("the shell deterministically modulepreloads the complete immutable module graph", async () => {
  const [first, repeated, subpath] = await Promise.all([
    productionMap({ label: "preload", marker: "same" }),
    productionMap({ label: "preload", marker: "same" }),
    productionMap({ label: "preload", marker: "subpath", basePath: "/agent-ui/" }),
  ]);
  const preloadHrefs = (html) => [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/gu)]
    .map((match) => match[1]);
  const expectedRoot = AGENT_WEB_MODULE_ROUTES.map((route) => versionedAgentWebAsset(route, first.releaseVersion));
  const expectedSubpath = AGENT_WEB_MODULE_ROUTES.map((route) => (
    `/agent-ui${versionedAgentWebAsset(route, subpath.releaseVersion)}`
  ));
  assert.deepEqual(preloadHrefs(first.get("/").body), expectedRoot);
  assert.deepEqual(preloadHrefs(repeated.get("/").body), expectedRoot);
  assert.deepEqual(preloadHrefs(subpath.get("/agent-ui/").body), expectedSubpath);
  assert.equal(new Set(expectedRoot).size, AGENT_WEB_MODULE_ROUTES.length);
  for (const route of expectedRoot) assert.equal(first.has(route), true, route);
});

test("the conversation sidebar gives the thread list one bounded scroll region", () => {
  assert.match(
    BRIGHT_APP_CSS,
    /\.sidebar \{[^}]*height: 100dvh;[^}]*min-height: 0;[^}]*overflow: hidden;/u,
  );
  assert.match(
    BRIGHT_APP_CSS,
    /\.thread-list \{[^}]*min-height: 0;[^}]*flex: 1 1 0;[^}]*align-content: start;[^}]*overflow-y: auto;/u,
  );
  assert.match(BRIGHT_APP_CSS, /\.sidebar footer \{[^}]*flex: 0 0 auto;/u);
  assert.doesNotMatch(BRIGHT_APP_CSS, /\.sidebar footer \{[^}]*margin-top: auto;/u);
});

test("Agent activity is a collapsed in-flow disclosure that cannot overlay chat or the composer", () => {
  const panelRule = /\.activity-panel \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const detailsRule = /\.activity-details \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(panelRule);
  assert.ok(detailsRule);
  assert.match(panelRule[1], /grid-area:\s*activity;/u);
  assert.match(panelRule[1], /overflow:\s*hidden;/u);
  assert.doesNotMatch(panelRule[1], /position\s*:/u);
  assert.match(detailsRule[1], /max-height:\s*min\(30dvh, 20rem\);/u);
  assert.match(detailsRule[1], /overflow-y:\s*auto;/u);
  assert.match(BRIGHT_APP_CSS, /\.activity-disclosure > summary \{[^}]*min-height:\s*48px;[^}]*cursor:\s*pointer;/u);
  assert.match(BRIGHT_APP_CSS, /\.activity-disclosure > summary::after \{[^}]*content:\s*"Show details ⌄";/u);
  assert.match(BRIGHT_APP_CSS, /\.activity-disclosure\[open\] > summary::after \{ content: "Hide details ⌃"; \}/u);
  assert.match(BRIGHT_APP_CSS, /@media \(max-width: 760px\) \{[\s\S]*\.activity-details \{ max-height: min\(24dvh, 14rem\); \}/u);
});

test("the newest-message control is an accessible touch target over only the chat grid row", () => {
  const controlRule = /\.go-to-bottom \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(controlRule);
  assert.match(controlRule[1], /grid-area:\s*chat;/u);
  assert.match(controlRule[1], /align-self:\s*end;/u);
  assert.match(controlRule[1], /justify-self:\s*end;/u);
  assert.match(controlRule[1], /min-width:\s*46px;/u);
  assert.match(controlRule[1], /min-height:\s*46px;/u);
  assert.match(BRIGHT_APP_CSS, /\.chat-scroll \{[^}]*scroll-padding-block-end:\s*4rem;/u);
});

test("the compact topbar is one row with an ellipsized title and collapsed capability Info", () => {
  const topbarRule = /\.topbar \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const metaRule = /\.conversation-meta \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const titleRule = /#conversation-title \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const infoRule = /\.topbar-info \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const summaryRule = /\.topbar-info > summary \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const noteRule = /(?:^|\n)\.capability-note \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(topbarRule && metaRule && titleRule && infoRule && summaryRule && noteRule);
  assert.match(topbarRule[1], /min-height:\s*56px;/u);
  assert.match(topbarRule[1], /flex-wrap:\s*nowrap;/u);
  assert.match(topbarRule[1], /white-space:\s*nowrap;/u);
  assert.match(metaRule[1], /min-width:\s*0;/u);
  assert.match(metaRule[1], /overflow:\s*hidden;/u);
  assert.match(titleRule[1], /overflow:\s*hidden;/u);
  assert.match(titleRule[1], /text-overflow:\s*ellipsis;/u);
  assert.match(titleRule[1], /white-space:\s*nowrap;/u);
  assert.match(infoRule[1], /position:\s*relative;/u);
  assert.match(summaryRule[1], /min-width:\s*44px;/u);
  assert.match(summaryRule[1], /min-height:\s*44px;/u);
  assert.match(noteRule[1], /position:\s*absolute;/u);
  assert.match(noteRule[1], /white-space:\s*normal;/u);
});

test("toasts never block controls and move below the one-row mobile header", () => {
  const toastRule = /(?:^|\n)\.toast \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(toastRule);
  assert.match(toastRule[1], /bottom:\s*1rem;/u);
  assert.match(toastRule[1], /width:\s*max-content;/u);
  assert.match(toastRule[1], /max-width:\s*min\(calc\(100% - 2rem\), 36rem\);/u);
  assert.match(toastRule[1], /overflow-wrap:\s*anywhere;/u);
  assert.match(toastRule[1], /pointer-events:\s*none;/u);
  assert.match(toastRule[1], /white-space:\s*normal;/u);

  const mobileStart = BRIGHT_APP_CSS.indexOf("@media (max-width: 760px)");
  const mobileEnd = BRIGHT_APP_CSS.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
  assert.ok(mobileStart >= 0);
  assert.ok(mobileEnd > mobileStart);
  const mobileCss = BRIGHT_APP_CSS.slice(mobileStart, mobileEnd);
  const mobileToastRule = /\.toast \{([^}]*)\}/u.exec(mobileCss);
  assert.ok(mobileToastRule);
  assert.match(
    mobileToastRule[1],
    /top:\s*calc\(max\(56px, env\(safe-area-inset-top\) \+ 48px\) \+ \.5rem\);/u,
  );
  assert.match(mobileToastRule[1], /bottom:\s*auto;/u);
  assert.match(mobileToastRule[1], /max-width:\s*calc\(100% - 1rem\);/u);
});

test("mobile thread rows reserve non-overlapping title and full Delete control rectangles", () => {
  const rowRule = /\.thread-row \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const openRule = /\.thread-open \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const deleteRule = /\.thread-delete \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(rowRule);
  assert.ok(openRule);
  assert.ok(deleteRule);
  assert.match(rowRule[1], /display:\s*grid;/u);
  assert.match(
    rowRule[1],
    /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(4\.5rem, max-content\);/u,
  );
  assert.match(deleteRule[1], /width:\s*100%;/u);
  assert.match(deleteRule[1], /min-width:\s*4\.5rem;/u);
  assert.match(deleteRule[1], /min-height:\s*44px;/u);
  assert.match(openRule[1], /width:\s*100%;/u);
  assert.match(openRule[1], /min-height:\s*44px;/u);
  assert.doesNotMatch(rowRule[1], /position:\s*(?:absolute|fixed)/u);
  assert.doesNotMatch(openRule[1], /position:\s*(?:absolute|fixed)/u);
  assert.doesNotMatch(deleteRule[1], /position:\s*(?:absolute|fixed)/u);
});

test("the install action stays in the sidebar footer without covering mobile controls", async () => {
  const map = await productionMap({ label: "sidebar-install" });
  const html = map.get("/").body;
  const sidebarStart = html.indexOf('<aside id="sidebar"');
  const sidebarEnd = html.indexOf("</aside>", sidebarStart);
  const footerStart = html.indexOf("<footer>", sidebarStart);
  const footerEnd = html.indexOf("</footer>", footerStart);
  const installButton = html.indexOf('id="install-app"');

  assert.equal([...html.matchAll(/id="install-app"/gu)].length, 1);
  assert.ok(sidebarStart >= 0);
  assert.ok(sidebarStart < footerStart);
  assert.ok(footerStart < installButton);
  assert.ok(installButton < footerEnd);
  assert.ok(footerEnd < sidebarEnd);

  const installRule = /\.install-app \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(installRule);
  assert.match(installRule[1], /\bwidth:\s*100%;/u);
  assert.doesNotMatch(installRule[1], /\bposition:\s*fixed;/u);
  assert.doesNotMatch(installRule[1], /\b(?:right|bottom):/u);
});

test("the mobile workspace keeps the image action inside the dynamic viewport", () => {
  assert.match(
    BRIGHT_APP_CSS,
    /\.app-view \{[^}]*height: 100vh;[^}]*height: 100dvh;[^}]*min-height: 0;[^}]*overflow: hidden;/u,
  );
  assert.match(
    BRIGHT_APP_CSS,
    /\.workspace \{[^}]*min-height: 0;[^}]*height: 100%;[^}]*overflow: hidden;[^}]*grid-template-areas: "topbar" "offline" "context" "chat" "activity" "composer";[^}]*grid-template-rows: auto auto auto minmax\(0, 1fr\) auto auto;[^}]*grid-template-columns: minmax\(0, 1fr\);/u,
  );
  for (const [selector, area] of [
    [".topbar", "topbar"],
    ["#offline-banner", "offline"],
    [".context-indicator", "context"],
    [".chat-scroll", "chat"],
    [".activity-panel", "activity"],
    [".composer", "composer"],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(BRIGHT_APP_CSS, new RegExp(`${escaped} \\{[^}]*grid-area: ${area};`, "u"));
  }
  assert.match(BRIGHT_APP_CSS, /\.chat-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto;/u);
  assert.match(BRIGHT_APP_CSS, /\.composer \{[^}]*padding:[^;}]*max\(\.8rem, env\(safe-area-inset-bottom\)\);/u);
  assert.match(
    BRIGHT_APP_CSS,
    /@media \(max-width: 760px\) \{[\s\S]*\.composer \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*padding:[^;}]*max\(\.6rem, env\(safe-area-inset-bottom\)\);/u,
  );
  assert.doesNotMatch(BRIGHT_APP_CSS, /grid-area:\s*footer;/u);
});

test("the iPhone multi-image composer and retained Agent gallery cannot overlap their controls", () => {
  const previewRule = /\.image-preview \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const labelRule = /\.image-preview span \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const removeRule = /\.image-preview button \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const retainedRule = /\.message-attachment-retained \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(previewRule && labelRule && removeRule && retainedRule);
  assert.match(previewRule[1], /min-width:\s*0;/u);
  assert.match(labelRule[1], /min-width:\s*0;/u);
  assert.match(labelRule[1], /flex:\s*1 1 auto;/u);
  assert.match(labelRule[1], /text-overflow:\s*ellipsis;/u);
  assert.match(removeRule[1], /min-height:\s*44px;/u);
  assert.match(removeRule[1], /flex:\s*0 0 auto;/u);
  assert.match(retainedRule[1], /overflow-wrap:\s*anywhere;/u);

  const mobileStart = BRIGHT_APP_CSS.indexOf("@media (max-width: 760px)");
  const mobileEnd = BRIGHT_APP_CSS.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
  const mobileCss = BRIGHT_APP_CSS.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.composer > \.image-button, \.composer > \.image-preview, \.composer > \.search-controls \{ grid-column: 1 \/ -1; \}/u);
  assert.match(mobileCss, /\.image-preview \{ max-width: 100%; \}/u);
  assert.match(mobileCss, /\.message-attachments \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
});

test("mobile sidebar and send controls expose comfortable touch targets", () => {
  const mobileStart = BRIGHT_APP_CSS.indexOf("@media (max-width: 760px)");
  const mobileEnd = BRIGHT_APP_CSS.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
  assert.ok(mobileStart >= 0);
  assert.ok(mobileEnd > mobileStart);
  const mobileCss = BRIGHT_APP_CSS.slice(mobileStart, mobileEnd);
  const touchTargetRule = /#open-sidebar,\s*#send-message\s*\{([^}]*)\}/u.exec(mobileCss);
  assert.ok(touchTargetRule);
  assert.match(touchTargetRule[1], /min-width:\s*48px;/u);
  assert.match(touchTargetRule[1], /min-height:\s*48px;/u);
  assert.match(BRIGHT_APP_CSS, /\.topbar-info > summary \{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/u);
  assert.match(BRIGHT_APP_CSS, /\.mode-switch button \{[^}]*min-height:\s*44px;/u);
});

test("Agent plots keep the workspace track and use readable desktop and iPhone geometry", () => {
  const workspaceRule = /\.workspace \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const assistantRule = /\.message\[data-role="assistant"\] \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const plotRule = /\.artifact-plot \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const legendRule = /\.artifact-legend \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const legendItemRule = /\.artifact-legend li \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(workspaceRule);
  assert.ok(assistantRule);
  assert.ok(plotRule);
  assert.ok(legendRule);
  assert.ok(legendItemRule);
  assert.match(workspaceRule[1], /grid-column:\s*2;/u);
  assert.match(assistantRule[1], /width:\s*min\(100%, 760px\);/u);
  assert.match(assistantRule[1], /max-width:\s*min\(100%, 760px\);/u);
  assert.match(plotRule[1], /width:\s*100%;/u);
  assert.match(plotRule[1], /height:\s*auto;/u);
  assert.match(plotRule[1], /max-width:\s*100%;/u);
  assert.match(plotRule[1], /aspect-ratio:\s*720 \/ 390;/u);
  assert.match(legendRule[1], /flex-wrap:\s*wrap;/u);
  assert.match(legendItemRule[1], /min-width:\s*0;/u);
  assert.match(legendItemRule[1], /max-width:\s*100%;/u);
  assert.match(legendItemRule[1], /overflow-wrap:\s*anywhere;/u);
  assert.match(BRIGHT_APP_CSS, /\.plot-grid, \.plot-axis, \.plot-series path \{[^}]*vector-effect:\s*non-scaling-stroke;/u);

  const mobileStart = BRIGHT_APP_CSS.indexOf("@media (max-width: 760px)");
  const mobileEnd = BRIGHT_APP_CSS.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
  const mobileCss = BRIGHT_APP_CSS.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.workspace \{[^}]*grid-column:\s*1;/u);
  assert.match(mobileCss, /\.message\[data-role="assistant"\] \{[^}]*width:\s*94%;[^}]*max-width:\s*94%;/u);
  assert.match(mobileCss, /\.plot-tick \{[^}]*font-size:\s*24px;/u);
  assert.match(mobileCss, /\.plot-axis-label \{[^}]*font-size:\s*24px;/u);
  assert.match(mobileCss, /\.plot-label-wide \{[^}]*display:\s*none;/u);
  assert.match(mobileCss, /\.plot-label-compact \{[^}]*display:\s*inline;/u);
  assert.match(mobileCss, /\.artifact-legend \{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 9rem\), 1fr\)\);/u);

  const desktopWorkspace = 1_280 - 280;
  const desktopTranscript = desktopWorkspace - 2 * Math.max(16, (desktopWorkspace - 850) / 2);
  const desktopMessage = Math.min(desktopTranscript, 760);
  const desktopPlot = desktopMessage - 2 * 16 - 2;
  const iphoneTranscript = 390 - 2 * 16;
  const iphoneMessage = iphoneTranscript * 0.94;
  const iphonePlot = iphoneMessage - 2 * 16 - 2;
  assert.equal(desktopMessage, 760);
  assert.ok(desktopPlot > 720 && desktopPlot <= desktopMessage);
  assert.ok(iphonePlot > 300 && iphonePlot < iphoneTranscript);
  assert.ok(iphonePlot / (720 / 390) > 160, "iPhone plot retains a readable aspect height");
  assert.ok(24 * iphonePlot / 720 >= 10, "responsive iPhone tick text stays readable");
});

test("Direct Chat deletion confirms, locks unsafe rows, retries one ticket, and clears only after authority", async () => {
  const now = "2026-08-24T08:00:00.000Z";
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const resolved = {
    threadId: "chat_delete_resolved_xxxxxxxxxxxx",
    title: "Resolved history",
    modelAlias: "local-default",
    revision: 2,
    ledgerHash: hashB,
    messageCount: 2,
    ledgerBytes: 22,
    currentGenerationId: null,
    createdAt: now,
    updatedAt: now,
  };
  const active = {
    ...resolved,
    threadId: "chat_delete_active_xxxxxxxxxxxxxx",
    title: "Generating now",
    revision: 1,
    ledgerHash: hashA,
    messageCount: 1,
    currentGenerationId: "generation_delete_active_xxxxxxxxx",
  };
  const messages = [
    {
      threadId: resolved.threadId,
      messageId: "message_delete_user_xxxxxxxxxxxxx",
      revision: 1,
      role: "user",
      content: "Please answer",
      contentBytes: 13,
      previousHash: null,
      messageHash: hashA,
      generationId: null,
      createdAt: now,
    },
    {
      threadId: resolved.threadId,
      messageId: "message_delete_assistant_xxxxxxx",
      revision: 2,
      role: "assistant",
      content: "Done safely",
      contentBytes: 11,
      previousHash: hashA,
      messageHash: hashB,
      generationId: "generation_delete_resolved_xxxxxxx",
      createdAt: now,
    },
  ];
  let preparedTicket = null;
  const deleteTickets = [];
  const retryTickets = [];
  let resolveDeletion;
  const authoritativeDeletion = new Promise((resolve) => { resolveDeletion = resolve; });
  const chat = {
    async capabilities() { return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }; },
    prepareThread() { throw new Error("unexpected create"); },
    async createThread() { throw new Error("unexpected create"); },
    async retryCreateThread() { throw new Error("unexpected create retry"); },
    async listThreads() { return { threads: [resolved, active] }; },
    async getThread(threadId) {
      if (threadId !== resolved.threadId) throw new Error("unexpected active restoration");
      return { thread: resolved };
    },
    async listMessages({ threadId, afterRevision, limit }) {
      assert.equal(threadId, resolved.threadId);
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment() { throw new Error("unexpected attachment read"); },
    prepareThreadDeletion(value) {
      preparedTicket = Object.freeze({ ...value, idempotencyKey: "thread_delete_ui_exact_0001" });
      return preparedTicket;
    },
    async deleteThread(ticket) {
      deleteTickets.push(ticket);
      throw Object.assign(new Error("response interrupted"), { retryable: true });
    },
    async retryDeleteThread(ticket) {
      retryTickets.push(ticket);
      return await authoritativeDeletion;
    },
    prepareRun() { throw new Error("unexpected run"); },
    async startRun() { throw new Error("unexpected run"); },
    async retryRun() { throw new Error("unexpected run retry"); },
    async getRunStatus() { throw new Error("unexpected run status"); },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("unexpected cancellation"); },
    async cancelRun() { throw new Error("unexpected cancellation"); },
  };
  let agentDeleteCalls = 0;
  const agent = {
    async capabilities() {
      return {
        schemaVersion: "1",
        enabled: false,
        agent: { kind: "aginti", label: "AgInTi Agent" },
        model: { label: "LocalLLM" },
        actions: { cancel: false, resume: false, retry: false },
        attachments: { enabled: false },
        artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
      };
    },
    async listThreads() { return { threads: [] }; },
    async deleteThread() { agentDeleteCalls += 1; },
    async *streamRunEvents() {},
  };
  const confirmations = [false, true];
  const confirmationMessages = [];
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "csrf-token-value-long-enough",
    }),
    agent,
    chat,
    wait: async () => {},
    confirmThreadDeletion(message) {
      confirmationMessages.push(message);
      return confirmations.shift();
    },
  });
  await harness.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const threadList = harness.document.getElementById("thread-list");
  assert.equal(threadList.children.length, 2);
  assert.equal(threadList.children[0].className, "thread-row");
  assert.equal(threadList.children[0].children.length, 2);
  assert.equal(threadList.children[0].children[1].textContent, "Delete");
  assert.match(threadList.children[0].children[1].getAttribute("aria-label"), /Resolved history/u);
  assert.equal(threadList.children[1].children[1].disabled, true, "an active generation has no enabled delete control");
  assert.equal(harness.document.getElementById("messages").children.length, 2);

  const cancelledDeleteControl = threadList.children[0].children[1];
  assert.equal(await harness.app.deleteChatThread(resolved.threadId), false, "cancelled confirmation is read-only");
  assert.equal(threadList.children[0].children[1], cancelledDeleteControl, "cancelling preserves keyboard and VoiceOver focus ownership");
  assert.equal(preparedTicket, null);
  assert.equal(await harness.app.deleteChatThread(active.threadId), false, "active history is rejected before confirmation");
  assert.equal(confirmationMessages.length, 1);

  harness.document.getElementById("message-input").value = "Keep this unsent draft";
  const deletion = harness.app.deleteChatThread(resolved.threadId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteTickets.length, 1);
  assert.equal(retryTickets.length, 1);
  assert.equal(deleteTickets[0], preparedTicket);
  assert.equal(retryTickets[0], preparedTicket, "the ambiguous retry must reuse the identical prepared ticket");
  assert.equal(harness.document.getElementById("messages").children.length, 2, "history remains until authoritative success");
  resolveDeletion({ deleted: true, threadId: resolved.threadId, request: preparedTicket });
  assert.equal(await deletion, true);
  assert.equal(harness.document.getElementById("messages").children.length, 0);
  assert.equal(harness.document.getElementById("conversation-title").textContent, "New conversation");
  assert.equal(harness.document.getElementById("message-input").value, "Keep this unsent draft");
  assert.equal(threadList.children.length, 1);
  assert.equal(threadList.children[0].dataset.threadId, active.threadId);
  await Promise.resolve();
  assert.equal(threadList.children[0].children[0].focused, true, "focus moves to the next conversation after removal");
  assert.equal(agentDeleteCalls, 0, "Direct Chat deletion never calls the Agent client");
});

test("Agent conversation cleanup uses only the Agent delete API and clears the selected presentation", async () => {
  const threadId = "thr_11111111-2222-4333-8444-555555555555";
  const thread = emptyAgentPwaThread({ id: threadId, title: "Disposable Agent test" });
  const deletions = [];
  const confirmationMessages = [];
  const agent = {
    async capabilities() { return enabledAgentPwaCapability(); },
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(requestedThreadId) {
      assert.equal(requestedThreadId, threadId);
      return { schemaVersion: "1", thread };
    },
    async deleteThread(requestedThreadId, options) {
      deletions.push({ requestedThreadId, options });
      return { schemaVersion: "1", deleted: true, threadId };
    },
    async *streamRunEvents() {},
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "csrf-token-value-long-enough",
    }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    confirmThreadDeletion(message) {
      confirmationMessages.push(message);
      return true;
    },
  });
  await harness.app.initialize();
  await settlePwaActions();

  const list = harness.document.getElementById("thread-list");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, "thread-row");
  assert.equal(list.children[0].dataset.mode, "agent");
  assert.equal(list.children[0].children[0].getAttribute("aria-current"), "true");
  assert.equal(list.children[0].children[1].textContent, "Delete");
  assert.match(list.children[0].children[1].getAttribute("aria-label"), /Agent conversation Disposable Agent test/u);

  assert.equal(await harness.app.deleteAgentThread(threadId), true);
  assert.equal(confirmationMessages.length, 1);
  assert.match(confirmationMessages[0], /messages, execution history, and artifacts/u);
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].requestedThreadId, threadId);
  assert.match(deletions[0].options.idempotency, /^agent_delete_/u);
  assert.equal(list.children.length, 0);
  assert.equal(harness.document.getElementById("messages").children.length, 0);
  assert.equal(harness.document.getElementById("conversation-title").textContent, "New conversation");
  assert.match(harness.document.getElementById("toast").textContent, /Agent conversation deleted/u);
});

test("ambiguous Agent cleanup retains one idempotency key until an exact manual retry succeeds", async () => {
  const threadId = "thr_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const thread = emptyAgentPwaThread({ id: threadId, title: "Interrupted Agent cleanup" });
  const idempotencyKeys = [];
  let deleteCalls = 0;
  let confirmations = 0;
  const agent = {
    async capabilities() { return enabledAgentPwaCapability(); },
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(requestedThreadId) {
      assert.equal(requestedThreadId, threadId);
      return { schemaVersion: "1", thread };
    },
    async deleteThread(requestedThreadId, options) {
      assert.equal(requestedThreadId, threadId);
      deleteCalls += 1;
      idempotencyKeys.push(options.idempotency);
      if (deleteCalls < 3) throw Object.assign(new Error("response interrupted"), { retryable: true });
      return { schemaVersion: "1", deleted: true, threadId };
    },
    async *streamRunEvents() {},
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "csrf-token-value-long-enough",
    }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    wait: async () => {},
    confirmThreadDeletion() { confirmations += 1; return true; },
  });
  await harness.app.initialize();
  await settlePwaActions();

  assert.equal(await harness.app.deleteAgentThread(threadId), false);
  const list = harness.document.getElementById("thread-list");
  assert.equal(list.children[0].children[1].textContent, "Retry");
  assert.equal(list.children[0].children[0].disabled, true);
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  assert.equal(confirmations, 1);
  assert.equal(deleteCalls, 2);
  assert.equal(new Set(idempotencyKeys).size, 1);

  assert.equal(await harness.app.deleteAgentThread(threadId), true);
  assert.equal(confirmations, 1, "manual retry does not repeat destructive confirmation for the same request");
  assert.equal(deleteCalls, 3);
  assert.equal(new Set(idempotencyKeys).size, 1, "every retry reuses the exact accepted idempotency key");
  assert.equal(list.children.length, 0);
});

function completedDeletionRaceFixture() {
  const now = "2026-08-26T18:00:00.000Z";
  const threadId = "chat_delete_completed_race_xxxxxxx";
  const generationId = "generation_delete_completed_race_x";
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const stale = Object.freeze({
    threadId,
    title: "Completed image answer",
    modelAlias: "local-default",
    revision: 0,
    ledgerHash: null,
    messageCount: 0,
    ledgerBytes: 0,
    currentGenerationId: null,
    createdAt: now,
    updatedAt: now,
  });
  const completed = Object.freeze({
    ...stale,
    revision: 2,
    ledgerHash: hashB,
    messageCount: 2,
    ledgerBytes: 35,
  });
  const sibling = Object.freeze({
    ...stale,
    threadId: "chat_delete_sibling_xxxxxxxxxxxxx",
    title: "Keep this conversation",
  });
  const messages = Object.freeze([
    Object.freeze({
      threadId,
      messageId: "message_delete_race_user_xxxxxxxx",
      revision: 1,
      role: "user",
      content: "Describe both images",
      contentBytes: 20,
      previousHash: null,
      messageHash: hashA,
      generationId: null,
      createdAt: now,
    }),
    Object.freeze({
      threadId,
      messageId: "message_delete_race_answer_xxxxxx",
      revision: 2,
      role: "assistant",
      content: "Both are visible",
      contentBytes: 15,
      previousHash: hashA,
      messageHash: hashB,
      generationId,
      createdAt: now,
    }),
  ]);
  const generation = Object.freeze({
    threadId,
    generationId,
    status: "completed",
    terminal: true,
    finalRevision: completed.revision,
    finalHash: completed.ledgerHash,
  });
  let created = false;
  let authoritative = stale;
  let listCalls = 0;
  let retryDeleteCalls = 0;
  const exactThreadReads = [];
  const preparedTickets = [];
  const deleteTickets = [];
  const chat = {
    async capabilities() { return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }; },
    prepareThread({ title }) {
      return Object.freeze({ threadId, title, idempotencyKey: "thread_create_delete_race_0001" });
    },
    async createThread(ticket) {
      created = true;
      authoritative = stale;
      return { request: ticket, thread: stale };
    },
    async retryCreateThread() { throw new Error("unexpected create retry"); },
    async listThreads() {
      listCalls += 1;
      return { threads: created ? [stale, sibling] : [] };
    },
    async getThread(requestedThreadId) {
      exactThreadReads.push(requestedThreadId);
      assert.equal(requestedThreadId, threadId, "refresh stays bound to the completed conversation");
      return { thread: authoritative };
    },
    async listMessages({ threadId: requestedThreadId, afterRevision, limit }) {
      assert.equal(requestedThreadId, threadId);
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment() { throw new Error("unexpected attachment read"); },
    prepareThreadDeletion(value) {
      const ticket = Object.freeze({
        ...value,
        idempotencyKey: `thread_delete_completed_race_${preparedTickets.length + 1}`,
      });
      preparedTickets.push(ticket);
      return ticket;
    },
    async deleteThread(ticket) {
      deleteTickets.push(ticket);
      if (ticket.threadId !== threadId
          || ticket.expectedRevision !== authoritative.revision
          || ticket.expectedHash !== authoritative.ledgerHash
          || authoritative.currentGenerationId !== null) {
        throw new DirectChatTransportError("stale or active deletion cursor", {
          status: 409,
          retryable: false,
        });
      }
      return { deleted: true, threadId, request: ticket };
    },
    async retryDeleteThread() {
      retryDeleteCalls += 1;
      throw new Error("an authoritative 409 must not retry the stale ticket");
    },
    prepareRun(value) {
      return Object.freeze({
        ...value,
        generationId,
        idempotencyKey: "run_start_delete_race_0001",
      });
    },
    async startRun(ticket) {
      authoritative = completed;
      return { request: ticket, generation };
    },
    async retryRun() { throw new Error("unexpected run retry"); },
    async getRunStatus() { return { generation }; },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("unexpected cancellation"); },
    async cancelRun() { throw new Error("unexpected cancellation"); },
  };
  return {
    chat,
    completed,
    sibling,
    threadId,
    preparedTickets,
    deleteTickets,
    exactThreadReads,
    get listCalls() { return listCalls; },
    get retryDeleteCalls() { return retryDeleteCalls; },
    setAuthoritative(thread) { authoritative = Object.freeze(thread); },
  };
}

async function finishDeletionRaceConversation(fixture) {
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "csrf-token-value-long-enough",
    }),
    agent: idleAuthenticatedPwaClients().agent,
    chat: fixture.chat,
    wait: async () => {},
    confirmThreadDeletion: () => true,
  });
  await harness.app.initialize();
  harness.document.getElementById("message-input").value = "Describe both images";
  await harness.app.submitMessage({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.document.getElementById("workspace").dataset.status, "completed");
  assert.match(harness.document.getElementById("messages").textContent, /Both are visible/u);
  return harness;
}

test("post-completion deletion refreshes one stale sidebar cursor and deletes only its bound thread", async () => {
  const fixture = completedDeletionRaceFixture();
  const harness = await finishDeletionRaceConversation(fixture);
  const listCallsBeforeDeletion = fixture.listCalls;
  const readsBeforeDeletion = fixture.exactThreadReads.length;

  assert.equal(await harness.app.deleteChatThread(fixture.threadId), true);
  assert.equal(fixture.preparedTickets.length, 2, "the rejected stale cursor is replaced exactly once");
  assert.deepEqual(fixture.preparedTickets.map((ticket) => [ticket.threadId, ticket.expectedRevision, ticket.expectedHash]), [
    [fixture.threadId, 0, null],
    [fixture.threadId, fixture.completed.revision, fixture.completed.ledgerHash],
  ]);
  assert.equal(fixture.deleteTickets.length, 2);
  assert.equal(fixture.retryDeleteCalls, 0, "the stale idempotency ticket is never replayed with a changed body");
  assert.equal(fixture.listCalls, listCallsBeforeDeletion, "cursor repair uses one exact thread read, not a broad list read");
  assert.deepEqual(fixture.exactThreadReads.slice(readsBeforeDeletion), [fixture.threadId]);
  const rows = harness.document.getElementById("thread-list").children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.threadId, fixture.sibling.threadId, "the unrelated conversation remains visible");
  assert.equal(harness.document.getElementById("messages").children.length, 0);
  assert.match(harness.document.getElementById("toast").textContent, /Conversation deleted/u);
});

test("post-completion deletion never rebases onto newly active work", async () => {
  const fixture = completedDeletionRaceFixture();
  const harness = await finishDeletionRaceConversation(fixture);
  const active = Object.freeze({
    ...fixture.completed,
    revision: 3,
    ledgerHash: "c".repeat(64),
    messageCount: 3,
    currentGenerationId: "generation_delete_new_work_xxxxxxx",
  });
  fixture.setAuthoritative(active);
  const readsBeforeDeletion = fixture.exactThreadReads.length;

  assert.equal(await harness.app.deleteChatThread(fixture.threadId), false);
  assert.equal(fixture.preparedTickets.length, 1, "active work cannot mint a replacement deletion ticket");
  assert.equal(fixture.deleteTickets.length, 1);
  assert.equal(fixture.retryDeleteCalls, 0);
  assert.deepEqual(fixture.exactThreadReads.slice(readsBeforeDeletion), [fixture.threadId]);
  const rows = harness.document.getElementById("thread-list").children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.threadId, fixture.threadId);
  assert.equal(rows[0].children[1].disabled, true, "the refreshed active conversation cannot be deleted");
  assert.equal(rows[1].dataset.threadId, fixture.sibling.threadId);
  assert.match(harness.document.getElementById("messages").textContent, /Both are visible/u,
    "a rejected deletion never hides the rendered conversation");
  assert.match(harness.document.getElementById("toast").textContent, /changed or still has unresolved work/u);
});

test("ambiguous deletion retains one exact ticket through malformed and lost responses", async () => {
  const now = "2026-08-24T10:00:00.000Z";
  const thread = {
    threadId: "chat_delete_ambiguous_xxxxxxxxxx",
    title: "Ambiguous deletion",
    modelAlias: "local-default",
    revision: 0,
    ledgerHash: null,
    messageCount: 0,
    ledgerBytes: 0,
    currentGenerationId: null,
    createdAt: now,
    updatedAt: now,
  };
  let prepareCalls = 0;
  let confirmationCalls = 0;
  const tickets = [];
  const ticket = Object.freeze({
    threadId: thread.threadId,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: "thread_delete_ambiguous_exact_0001",
  });
  const chat = {
    async capabilities() { return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }; },
    prepareThread() { throw new Error("unexpected create"); },
    async createThread() { throw new Error("unexpected create"); },
    async retryCreateThread() { throw new Error("unexpected create retry"); },
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    async listMessages() { return { messages: [] }; },
    async getAttachment() { throw new Error("unexpected attachment read"); },
    prepareThreadDeletion(value) {
      prepareCalls += 1;
      assert.deepEqual(value, {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        expectedHash: thread.ledgerHash,
      });
      return ticket;
    },
    async deleteThread(value) {
      tickets.push(value);
      throw new DirectChatProtocolError("committed response was truncated");
    },
    async retryDeleteThread(value) {
      tickets.push(value);
      if (tickets.length === 2) {
        throw new DirectChatTransportError("retry response was lost", { status: 503, retryable: true });
      }
      return { deleted: true, threadId: thread.threadId, request: value };
    },
    prepareRun() { throw new Error("unexpected run"); },
    async startRun() { throw new Error("unexpected run"); },
    async retryRun() { throw new Error("unexpected run retry"); },
    async getRunStatus() { throw new Error("unexpected run status"); },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("unexpected cancellation"); },
    async cancelRun() { throw new Error("unexpected cancellation"); },
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idleAuthenticatedPwaClients().agent,
    chat,
    wait: async () => {},
    confirmThreadDeletion() { confirmationCalls += 1; return true; },
  });
  await harness.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await harness.app.deleteChatThread(thread.threadId), false);
  const threadList = harness.document.getElementById("thread-list");
  assert.equal(threadList.children[0].children[1].textContent, "Retry");
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  assert.equal(prepareCalls, 1);
  assert.equal(confirmationCalls, 1);
  assert.equal(tickets.length, 2);
  assert.equal(tickets.every((value) => value === ticket), true);

  assert.equal(await harness.app.deleteChatThread(thread.threadId), true);
  assert.equal(prepareCalls, 1, "manual confirmation retry never generates a new idempotency key");
  assert.equal(confirmationCalls, 1, "the irreversible confirmation is not repeated for the same ticket");
  assert.equal(tickets.length, 3);
  assert.equal(tickets.every((value) => value === ticket), true);
  assert.equal(threadList.children.length, 0);
});

test("authenticated deletion 404 is treated as desired multi-tab absence", async () => {
  const thread = {
    threadId: "chat_delete_other_tab_xxxxxxxxxx",
    title: "Deleted elsewhere",
    modelAlias: "local-default",
    revision: 0,
    ledgerHash: null,
    messageCount: 0,
    ledgerBytes: 0,
    currentGenerationId: null,
    createdAt: "2026-08-24T10:05:00.000Z",
    updatedAt: "2026-08-24T10:05:00.000Z",
  };
  let retryCalls = 0;
  const chat = {
    ...idleAuthenticatedPwaClients().chat,
    async listThreads() { return { threads: [thread] }; },
    async getThread() { return { thread }; },
    prepareThreadDeletion(value) { return Object.freeze({ ...value, idempotencyKey: "thread_delete_other_tab_0001" }); },
    async deleteThread() {
      throw new DirectChatTransportError("already absent", { status: 404, retryable: false });
    },
    async retryDeleteThread() { retryCalls += 1; throw new Error("must not retry an authenticated 404"); },
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idleAuthenticatedPwaClients().agent,
    chat,
    confirmThreadDeletion: () => true,
  });
  await harness.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await harness.app.deleteChatThread(thread.threadId), true);
  assert.equal(retryCalls, 0);
  assert.equal(harness.document.getElementById("thread-list").children.length, 0);
});

test("inline Agent artifacts contain wide tables inside the assistant message", () => {
  assert.match(BRIGHT_APP_CSS, /\.message \{[^}]*min-width: 0;/u);
  assert.match(BRIGHT_APP_CSS, /\.message-artifacts \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/u);
  assert.match(BRIGHT_APP_CSS, /\.artifact, \.artifact > div \{[^}]*min-width: 0;/u);
  assert.match(BRIGHT_APP_CSS, /\.table-scroll, \.artifact-table-scroll \{[^}]*overflow-x: auto;/u);
});

test("file artifact controls remain tappable and wrap instead of overflowing an iPhone viewport", () => {
  assert.match(BRIGHT_APP_CSS, /\.artifact-file-controls \{[^}]*flex-wrap:\s*wrap;[^}]*gap:/u);
  assert.match(BRIGHT_APP_CSS, /\.artifact-file-action \{[^}]*min-width:\s*min\(100%, 7\.5rem\);[^}]*min-height:\s*44px;/u);
  assert.match(BRIGHT_APP_CSS, /\.artifact-file-privacy \{[^}]*overflow-wrap:\s*anywhere;/u);
});

test("content digest deterministically owns release, cache, routes, and final-map verification", async () => {
  const first = await productionMap({ label: "stable", marker: "same" });
  const repeated = await productionMap({ label: "stable", marker: "same" });
  const changed = await productionMap({ label: "stable", marker: "one-byte-change" });
  const relabeled = await productionMap({ label: "human", marker: "same" });
  const changedTitle = await productionMap({ label: "stable", marker: "same", title: "Different title" });
  const changedManifest = await productionMap({ label: "stable", marker: "same", name: "Different app name" });
  const changedLogin = await productionMap({ label: "stable", marker: "same", loginPath: "/account/login" });
  assert.equal(first.contentDigest, repeated.contentDigest);
  assert.equal(first.releaseVersion, repeated.releaseVersion);
  assert.equal(first.finalMapDigest, repeated.finalMapDigest);
  assert.notEqual(first.contentDigest, changed.contentDigest);
  assert.notEqual(first.releaseVersion, changed.releaseVersion);
  assert.notEqual(first.cacheName, changed.cacheName);
  assert.notEqual(first.releaseNamespace, changed.releaseNamespace);
  assert.notEqual(first.get(first.serviceWorkerRoute).body, changed.get(changed.serviceWorkerRoute).body);
  assert.notEqual(first.contentDigest, changedTitle.contentDigest);
  assert.notEqual(first.contentDigest, changedManifest.contentDigest);
  assert.notEqual(first.contentDigest, changedLogin.contentDigest);
  assert.equal(first.contentDigest, relabeled.contentDigest, "a human label is not a second content authority");
  assert(first.releaseVersion.endsWith(first.contentDigest));
  assert.equal(first.cacheName, `${AGENT_WEB_CACHE_PREFIX}${agentWebScopeIdentity("/")}-${first.releaseVersion}`);
  assert.equal(verifyStandaloneAssetMap(first), first);
  await assert.rejects(() => createStandaloneAssetMap({ bootstrapSource: BOOTSTRAP_IMPORTS, version: "manual" }), /unsupported field/u);

  const forged = Object.create(Object.getPrototypeOf(first));
  Object.defineProperties(forged, {
    releaseVersion: { value: first.releaseVersion, enumerable: true },
    contentDigest: { value: first.contentDigest, enumerable: true },
    finalMapDigest: { value: first.finalMapDigest, enumerable: true },
    routes: { value: first.routes, enumerable: true },
    get: { value: (route) => route.endsWith("/app.js") ? { ...first.get(route), body: "changed" } : first.get(route) },
  });
  assert.throws(() => verifyStandaloneAssetMap(forged), /factory-authenticated/u);
  const DiscoveredConstructor = Object.getPrototypeOf(first).constructor;
  assert.throws(() => new DiscoveredConstructor(undefined, [], {}), /only be created by the production factory/u);
});

test("release derivation is identical across process locale settings", () => {
  const script = `
    import { createStandaloneAssetMap } from "./src/web/asset-map.js";
    const map = await createStandaloneAssetMap({ bootstrapSource: ${JSON.stringify(BOOTSTRAP_IMPORTS)}, versionLabel: "locale" });
    process.stdout.write(map.releaseVersion);
  `;
  const releaseFor = (locale) => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.equal(releaseFor("C"), releaseFor("da_DK.UTF-8"));
});

test("root and subpath factories bind an injection-safe scope to distinct caches, routes, HTML, and worker registration", async () => {
  const [root, alpha, sibling] = await Promise.all([
    productionMap({ label: "scope", marker: "root" }),
    productionMap({ label: "scope", marker: "alpha", basePath: "/agent-ui/" }),
    productionMap({ label: "scope", marker: "sibling", basePath: "/agent-ui-2/" }),
  ]);
  assert.equal(root.serviceWorkerRoute, "/sw.js");
  assert.equal(alpha.serviceWorkerRoute, "/agent-ui/sw.js");
  assert.equal(alpha.basePath, "/agent-ui/");
  assert(alpha.releaseNamespace.startsWith("/agent-ui/assets/r/"));
  assert.notEqual(alpha.scopeIdentity, sibling.scopeIdentity);
  assert.notEqual(alpha.cacheName, sibling.cacheName);
  assert.match(alpha.get("/agent-ui/").body, /meta name="lazying-agent-base-path" content="\/agent-ui\/"/u);
  assert.match(alpha.get("/agent-ui/").body, /meta name="lazying-agent-service-worker" content="\/agent-ui\/sw\.js"/u);

  const harness = updateControllerHarness({ waiting: false, basePath: "/agent-ui/" });
  await harness.app.initialize();
  await Promise.resolve();
  assert.deepEqual(harness.serviceWorker.registerCalls, [[
    "/agent-ui/sw.js",
    { scope: "/agent-ui/", updateViaCache: "none" },
  ]]);

  for (const unsafe of ["//", "/a//b", "/a/../b", "/safe\"><script>", "/a?token=x", "https://x.invalid/"]) {
    assert.throws(() => normalizeAgentWebBasePath(unsafe), /basePath/u);
    assert.throws(() => createAppShellHtml({ basePath: unsafe }), /basePath/u);
    assert.throws(() => createPwaManifest({ basePath: unsafe }), /basePath/u);
  }
  assert.throws(() => createBrowserApp({
    document: appDocument({ basePath: "/agent-ui/" }),
    window: { location: { protocol: "https:" } },
    navigator: {},
    serviceWorkerPath: "/sibling/sw.js",
    sessionClient: { restore() {}, login() {}, logout() {} },
    createAgentClient() {},
    createChatClient() {},
    renderer: { renderMarkdown() {}, renderArtifact() {} },
  }), /bound to serviceWorkerScope/u);
});

test("official ESM lexer closes minified, comment, export-from, and dynamic-import graph escapes", async () => {
  const minified = 'import k from"./katex.mjs";import/*a*/"./browser-app.js";export{AgintiBrowserClient}from"./aginti-client.js";import("./safe-rendering.js");void k';
  const map = await productionMap({ label: "lexer", bootstrapSource: minified });
  for (const route of map.moduleRoutes) assert.equal(map.has(route), true, route);
  await assert.rejects(() => productionMap({
    bootstrapSource: `${BOOTSTRAP_IMPORTS}\nimport{x}from"../escape.js"`,
  }), /outside its immutable release namespace/u);
  await assert.rejects(() => productionMap({
    bootstrapSource: `${BOOTSTRAP_IMPORTS}\nexport{x}from"https://mixed.invalid/x.js"`,
  }), /non-relative module import/u);
  await assert.rejects(() => productionMap({
    bootstrapSource: `${BOOTSTRAP_IMPORTS}\nimport(getSpecifier())`,
  }), /non-literal dynamic import/u);
  await assert.rejects(() => createStandaloneAssetMap({ bootstrapSource: BOOTSTRAP_IMPORTS, katexSource: "not pinned" }), /exactly match installed pinned KaTeX/u);
});

test("integrity worker caches the complete offline graph and rejects mismatched install responses", async () => {
  const map = await productionMap({ label: "integrity", basePath: "/agent-ui/" });
  const source = map.get(map.serviceWorkerRoute).body;
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/u);
  assert.match(source, /response\.redirected/u);
  assert.match(source, /response\.url !== expected/u);
  assert.match(source.match(/self\.addEventListener\("install"[\s\S]*?\n\}\);/u)[0], /emergencyPredecessor/u);
  assert.match(source, /if \(await emergencyPredecessor\(\)\) await self\.skipWaiting\(\)/u);
  const worker = workerVm(source, { assetMap: map });
  await worker.dispatch("install");
  worker.setOnline(false);
  const offlineRoot = await worker.dispatch("fetch", { request: new worker.FakeRequest("/agent-ui/", { mode: "navigate" }) });
  assert.equal(offlineRoot.responded, true);
  const offlineVersionedRoot = await worker.dispatch("fetch", {
    request: new worker.FakeRequest(`/agent-ui/?v=${map.releaseVersion}`, { mode: "navigate" }),
  });
  assert.equal(offlineVersionedRoot.responded, true);
  assert.equal(offlineVersionedRoot.response.value, map.get("/agent-ui/").body);
  for (const [name, value] of Object.entries(map.get("/agent-ui/").headers)) {
    assert.equal(offlineRoot.response.headers.get(name), value, `offline root preserves ${name}`);
  }
  for (const route of map.moduleRoutes) {
    const offline = await worker.dispatch("fetch", { request: new worker.FakeRequest(route) });
    assert.equal(offline.responded, true, route);
    assert.equal(offline.response.type, "basic", route);
  }

  const appRoute = map.moduleRoutes.find((route) => route.endsWith("/app.js"));
  const corruptions = [
    ({ response, FakeResponse }) => new FakeResponse(response.bytes, { url: response.url, contentType: "text/html" }),
    ({ response, FakeResponse }) => new FakeResponse(response.bytes, { url: response.url, contentType: response.headers.get("content-type"), redirected: true }),
    ({ response, FakeResponse }) => new FakeResponse(response.bytes, { url: `${response.url}?redirected`, contentType: response.headers.get("content-type") }),
    ({ response, FakeResponse }) => new FakeResponse("one byte changed", { url: response.url, contentType: response.headers.get("content-type") }),
    ({ response, FakeResponse }) => new FakeResponse(response.bytes, {
      url: response.url,
      contentType: response.headers.get("content-type"),
      headers: { ...map.get(appRoute).headers, "cross-origin-resource-policy": "cross-origin" },
    }),
  ];
  for (const corrupt of corruptions) {
    const stores = new Map();
    const rejected = workerVm(source, {
      assetMap: map,
      cacheStores: stores,
      responseOverride(context) { return context.route === appRoute ? corrupt(context) : context.response; },
    });
    await assert.rejects(() => rejected.dispatch("install"), /PWA asset (?:response contract|integrity) mismatch/u);
    assert.equal(stores.has(map.cacheName), false, "a mismatched graph must never create an activatable cache");
  }
  const releaseMessages = [];
  await worker.dispatch("message", {
    data: { type: "GET_LAZYING_AGENT_RELEASE" },
    source: { postMessage(value) { releaseMessages.push(value); } },
  });
  assert.equal(releaseMessages.length, 1);
  assert.equal(releaseMessages[0].type, "LAZYING_AGENT_RELEASE");
  assert.equal(releaseMessages[0].releaseId, map.releaseVersion);
});

test("emergency worker takeover is exact-release gated, navigates stale windows, and bounds unresponsive clients", async () => {
  const map = await productionMap({ label: "emergency" });
  const source = map.get(map.serviceWorkerRoute).body;
  const vulnerableDigest = AGENT_WEB_EMERGENCY_PREDECESSOR_DIGESTS.find((digest) => digest.startsWith("9496cadb"));
  assert.equal(vulnerableDigest?.length, 64);
  const oldRelease = `release-${vulnerableDigest}`;
  const metaKey = `/.lazying-agent-cache-${map.scopeIdentity}.json`;
  const stateCacheName = `${AGENT_WEB_CACHE_PREFIX}state-${map.scopeIdentity}`;
  const activeKey = `/.lazying-agent-active-${map.scopeIdentity}.json`;
  const seedRelease = async (worker, releaseId, installedAt = 1) => {
    const cacheName = agentWebCacheName(releaseId);
    const contentDigest = releaseId.slice("release-".length);
    await (await worker.caches.open(cacheName)).put(metaKey, new worker.FakeResponse(JSON.stringify({
      cacheName,
      contentDigest,
      scopeId: map.scopeIdentity,
      installedAt,
    }), { contentType: "application/json" }));
    return cacheName;
  };

  const fresh = workerVm(source, { assetMap: map });
  await fresh.dispatch("install");
  assert.equal(fresh.skipWaitingCalls, 0, "a fresh install never forces activation");

  const navigations = [];
  const staleClient = {
    url: `https://llm.lazying.art/?v=${oldRelease}`,
    async navigate(value) { navigations.push(String(value)); return this; },
  };
  const legacy = workerVm(source, { assetMap: map, windowClients: [staleClient] });
  await seedRelease(legacy, oldRelease);
  await legacy.dispatch("install");
  assert.equal(legacy.skipWaitingCalls, 1, "a validated very old cache without a pointer escapes the legacy trap");
  await legacy.dispatch("activate");
  assert.deepEqual(navigations, [`https://llm.lazying.art/?v=${map.releaseVersion}`]);

  const stuckNavigations = [];
  const timeoutDelays = [];
  const pendingTimers = new Set();
  const workerSetTimeout = (callback, delay) => {
    timeoutDelays.push(delay);
    const timer = setImmediate(() => {
      pendingTimers.delete(timer);
      callback();
    });
    pendingTimers.add(timer);
    return timer;
  };
  const workerClearTimeout = (timer) => {
    pendingTimers.delete(timer);
    clearImmediate(timer);
  };
  const never = new Promise(() => {});
  const stuck = workerVm(source, {
    assetMap: map,
    clientClaim: () => never,
    windowClients: [{
      url: `https://llm.lazying.art/?v=${oldRelease}`,
      navigate(value) { stuckNavigations.push(String(value)); return never; },
    }],
    workerSetTimeout,
    workerClearTimeout,
  });
  const stuckOldCache = await seedRelease(stuck, oldRelease);
  await stuck.dispatch("install");
  await stuck.dispatch("activate");
  assert.equal(stuck.claimCalls, 1);
  assert.deepEqual(stuckNavigations, [`https://llm.lazying.art/?v=${map.releaseVersion}`], "takeover navigation is triggered without waiting for claim");
  assert.deepEqual(timeoutDelays, [2_000, 2_000, 2_000]);
  assert.equal(pendingTimers.size, 0);
  assert.equal(stuck.cacheStores.has(stuckOldCache), false, "activation continues through pruning after client-operation timeouts");

  const safeCurrentRelease = `release-${"e".repeat(64)}`;
  const safeNavigations = [];
  const safe = workerVm(source, {
    assetMap: map,
    windowClients: [{
      url: "https://llm.lazying.art/",
      async navigate(value) { safeNavigations.push(String(value)); },
    }],
  });
  const vulnerableCache = await seedRelease(safe, oldRelease);
  const safeCurrentCache = await seedRelease(safe, safeCurrentRelease, 2);
  await (await safe.caches.open(stateCacheName)).put(activeKey, new safe.FakeResponse(JSON.stringify({
    scopeId: map.scopeIdentity,
    current: safeCurrentCache,
    previous: vulnerableCache,
  }), { contentType: "application/json" }));
  await safe.dispatch("install");
  assert.equal(safe.skipWaitingCalls, 0, "an allowlisted predecessor cannot force from a non-vulnerable current release");
  await safe.dispatch("activate");
  assert.deepEqual(safeNavigations, []);
});

test("release identity survives asynchronous MessagePort delivery", async () => {
  const map = await productionMap({ label: "message-port" });
  const worker = workerVm(map.get(map.serviceWorkerRoute).body, { assetMap: map });
  const channel = new MessageChannel();
  const send = channel.port2.postMessage.bind(channel.port2);
  const close = channel.port2.close.bind(channel.port2);
  let senderClosed = false;
  let timeout;
  const delivered = new Promise((resolve, reject) => {
    channel.port1.once("message", resolve);
    timeout = setTimeout(() => reject(new Error("asynchronous release reply was dropped")), 2_000);
  });
  channel.port1.start();
  channel.port2.postMessage = (value) => queueMicrotask(() => {
    if (!senderClosed) send(value);
  });
  channel.port2.close = () => {
    senderClosed = true;
    close();
  };
  try {
    await worker.dispatch("message", {
      data: { type: "GET_LAZYING_AGENT_RELEASE" },
      ports: [channel.port2],
    });
    const response = await delivered;
    assert.deepEqual(response, { type: "LAZYING_AGENT_RELEASE", releaseId: map.releaseVersion });
    assert.equal(senderClosed, false, "the sender must not close a reply port before asynchronous delivery");
  } finally {
    clearTimeout(timeout);
    channel.port1.close();
    close();
  }
});

test("v1/v2/v3/rollback retains current plus immediate predecessor and isolates sibling scopes", async () => {
  const stores = new Map();
  const clock = { value: 1_000 };
  const [v1, v2, v3, sibling] = await Promise.all([
    productionMap({ label: "release", marker: "v1" }),
    productionMap({ label: "release", marker: "v2" }),
    productionMap({ label: "release", marker: "v3" }),
    productionMap({ label: "release", marker: "sibling", basePath: "/sibling/" }),
  ]);
  const runtime = (map) => workerVm(map.get(map.serviceWorkerRoute).body, { assetMap: map, cacheStores: stores, clock });
  const w1 = runtime(v1);
  await w1.dispatch("install");
  await w1.dispatch("activate");
  await w1.caches.open("unrelated-application-cache");

  const w2 = runtime(v2);
  await w2.dispatch("install");
  assert.equal(w2.skipWaitingCalls, 0);
  w1.setOnline(false);
  const oldOffline = await w1.dispatch("fetch", { request: new w1.FakeRequest("/", { mode: "navigate" }) });
  assert.equal(oldOffline.response.value, v1.get("/").body);
  await w2.dispatch("message", { data: { type: "LATER" } });
  assert.equal(w2.skipWaitingCalls, 0);
  await w2.dispatch("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(w2.skipWaitingCalls, 1);
  await w2.dispatch("activate");
  assert(stores.has(v1.cacheName) && stores.has(v2.cacheName));

  const w3 = runtime(v3);
  await w3.dispatch("install");
  await w3.dispatch("activate");
  assert.equal(stores.has(v1.cacheName), false);
  assert(stores.has(v2.cacheName) && stores.has(v3.cacheName));

  const rollback = runtime(v2);
  await rollback.dispatch("install");
  await rollback.dispatch("activate");
  assert(stores.has(v2.cacheName) && stores.has(v3.cacheName), "rollback keeps its immediate predecessor");

  const siblingWorker = runtime(sibling);
  await siblingWorker.dispatch("install");
  await siblingWorker.dispatch("activate");
  assert(stores.has(v2.cacheName) && stores.has(v3.cacheName) && stores.has(sibling.cacheName));
  assert(stores.has("unrelated-application-cache"));
});

test("activation pointer preserves the exact prior active shell across waiting releases and clock rollback, then claims before pruning", async () => {
  const stores = new Map();
  const operations = [];
  const clock = { value: 2_000 };
  const [v1, v2Waiting, v3, v4] = await Promise.all([
    productionMap({ label: "pointer", marker: "v1" }),
    productionMap({ label: "pointer", marker: "v2-waiting" }),
    productionMap({ label: "pointer", marker: "v3" }),
    productionMap({ label: "pointer", marker: "v4-clock-rollback" }),
  ]);
  const runtime = (map) => workerVm(map.get(map.serviceWorkerRoute).body, {
    assetMap: map,
    cacheStores: stores,
    clock,
    operations,
  });

  const oldTab = runtime(v1);
  await oldTab.dispatch("install");
  await oldTab.dispatch("activate");
  await runtime(v2Waiting).dispatch("install");
  const v3Worker = runtime(v3);
  await v3Worker.dispatch("install");
  operations.length = 0;
  await v3Worker.dispatch("activate");
  assert(stores.has(v1.cacheName), "a waiting-only v2 must not displace the active v1 predecessor");
  assert.equal(stores.has(v2Waiting.cacheName), false);
  assert(stores.has(v3.cacheName));
  assert.equal(operations[0], "claim", "controlled clients are claimed before any superseded cache is pruned");
  assert(operations.some((entry) => entry === `delete:${v2Waiting.cacheName}`));
  oldTab.setOnline(false);
  const oldShell = await oldTab.dispatch("fetch", { request: new oldTab.FakeRequest("/", { mode: "navigate" }) });
  assert.equal(oldShell.response.value, v1.get("/").body, "the old controlled tab keeps offline continuity through controller migration");

  clock.value = 100;
  const v4Worker = runtime(v4);
  await v4Worker.dispatch("install");
  await v4Worker.dispatch("activate");
  assert.equal(stores.has(v1.cacheName), false);
  assert(stores.has(v3.cacheName) && stores.has(v4.cacheName), "wall-clock rollback cannot change predecessor identity");
});

test("worker never intercepts or caches auth, Agent, LocalLLM, artifacts, POST, range, SSE, or cross-origin", async () => {
  const map = await productionMap({ label: "bypass" });
  const worker = workerVm(map.get(map.serviceWorkerRoute).body, { assetMap: map });
  await worker.dispatch("install");
  const before = worker.snapshot();
  const staticAssetRoute = map.moduleRoutes.find((route) => route.endsWith("/app.js"));
  for (const [path, options] of [
    ["/api/session", {}],
    ["/api/login", {}],
    ["/api/logout", {}],
    ["/api/transport/agent/v1/runs/events", {}],
    ["/api/transport/agent/v1/artifacts/get", {}],
    [`/api/agent/artifacts/${ARTIFACT_ID}/content`, {}],
    ["/artifacts/private-result", {}],
    ["/api/localllm/v1/chat/completions", {}],
    ["/api/chat/runs/start", { method: "POST" }],
    ["/agent/v1/capabilities", {}],
    ["/v1/chat/completions", {}],
    [staticAssetRoute, { method: "POST" }],
    [staticAssetRoute, { headers: { has: (name) => name === "range" } }],
    [staticAssetRoute, { headers: { get: (name) => name === "accept" ? "TEXT/EVENT-STREAM; charset=utf-8" : null } }],
    ["/assets/app.js", {}],
    [`${staticAssetRoute}?v=wrong`, {}],
    ["https://other.invalid/api/session", {}],
  ]) {
    const result = await worker.dispatch("fetch", { request: new worker.FakeRequest(path, options) });
    assert.equal(result.responded, false, `${options.method ?? "GET"} ${path}`);
  }
  assert.deepEqual(worker.snapshot(), before, "data-plane requests must never add to CacheStorage");
  const staticAsset = await worker.dispatch("fetch", { request: new worker.FakeRequest(staticAssetRoute) });
  assert.equal(staticAsset.responded, true);
  assert.deepEqual(worker.snapshot(), before, "immutable shell reads must not mutate CacheStorage");
});

test("one tab confirms globally, all old controlled tabs navigate once, and initial installation never loops", async () => {
  const environment = updateEnvironment();
  const confirmingTab = updateControllerHarness({ environment });
  const deferredTab = updateControllerHarness({ environment });
  deferredTab.document.getElementById("message-input").value = "keep this tab unsafe";
  await Promise.all([confirmingTab.app.initialize(), deferredTab.app.initialize()]);
  await Promise.resolve();
  assert.equal(confirmingTab.document.getElementById("update-banner").hidden, false);
  assert.equal(deferredTab.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(environment.workerMessages, [], "an unobserved merely-different release is never assumed to be a successor");
  deferredTab.document.getElementById("defer-update").dispatch("click");
  assert.equal(deferredTab.document.getElementById("update-banner").hidden, true);
  assert.deepEqual(environment.workerMessages, [], "Later must not activate from the unsafe tab");
  deferredTab.document.getElementById("message-input").value = "";
  deferredTab.document.getElementById("message-input").dispatch("input");

  confirmingTab.document.getElementById("apply-update").dispatch("click");
  confirmingTab.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(environment.workerMessages, [{ type: "SKIP_WAITING" }]);
  environment.registration.waiting = null;
  environment.transitionController(NEXT_RELEASE);
  await Promise.resolve();
  confirmingTab.runTimers(1_000);
  deferredTab.runTimers(1_000);
  assert.deepEqual(confirmingTab.replacements, [`https://llm.lazying.art/?v=${NEXT_RELEASE}`]);
  assert.deepEqual(deferredTab.replacements, [`https://llm.lazying.art/?v=${NEXT_RELEASE}`], "Later cannot veto a successor activated by another controlled tab");
  assert.equal(confirmingTab.reloads, 0);
  assert.equal(deferredTab.reloads, 0);

  const initialEnvironment = updateEnvironment({ waiting: false, controlled: false });
  const initialTab = updateControllerHarness({ environment: initialEnvironment, controlled: false });
  await initialTab.app.initialize();
  await Promise.resolve();
  initialEnvironment.transitionController(CURRENT_RELEASE);
  assert.equal(initialTab.reloads, 0, "first control acquisition is not an app update");

  const installing = initialEnvironment.waitingWorker;
  initialEnvironment.registration.installing = installing;
  initialEnvironment.registration.waiting = initialEnvironment.waitingWorker;
  initialEnvironment.registration.dispatch("updatefound");
  installing.dispatch("statechange");
  await Promise.resolve();
  assert.deepEqual(initialEnvironment.workerMessages, [{ type: "SKIP_WAITING" }], "a worker observed reaching waiting is a proven successor");
  initialEnvironment.registration.waiting = null;
  initialEnvironment.transitionController(NEXT_RELEASE);
  await Promise.resolve();
  initialTab.runTimers(1_000);
  assert.deepEqual(initialTab.replacements, [`https://llm.lazying.art/?v=${NEXT_RELEASE}`], "the same tab navigates for a later approved successor");
  assert.equal(initialTab.reloads, 0);
});

test("a fresh exact-release install skips the redundant startup update and never offers its own waiting worker", async () => {
  const environment = updateEnvironment({
    waiting: false,
    waitingReleaseId: CURRENT_RELEASE,
    controlled: false,
  });
  const harness = updateControllerHarness({ environment, controlled: false });
  await harness.app.initialize();
  await Promise.resolve();
  assert.equal(environment.registration.updateCalls, 0, "an uncontrolled first load must not race its initial install with update()");
  assert.equal(harness.document.getElementById("update-banner").hidden, true);

  const installing = environment.waitingWorker;
  environment.registration.installing = installing;
  environment.registration.waiting = environment.waitingWorker;
  environment.registration.dispatch("updatefound");
  installing.dispatch("statechange");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.document.getElementById("update-banner").hidden, true);
  harness.document.getElementById("apply-update").dispatch("click");
  harness.document.getElementById("defer-update").dispatch("click");
  assert.deepEqual(environment.workerMessages, [], "stale controls cannot activate or defer a same-release worker");
  assert.equal(environment.workerReleaseQueries.length, 1);
});

test("waiting-worker release proof suppresses the active shell and never autoactivates an unobserved different hash", async () => {
  const sameEnvironment = updateEnvironment({ waitingReleaseId: CURRENT_RELEASE });
  const same = updateControllerHarness({ environment: sameEnvironment });
  await same.app.initialize();
  await Promise.resolve();
  assert.equal(same.document.getElementById("update-banner").hidden, true);
  assert.equal(sameEnvironment.workerReleaseQueries.length, 1);

  const newerEnvironment = updateEnvironment({ waitingReleaseId: NEXT_RELEASE });
  const newer = updateControllerHarness({ environment: newerEnvironment });
  await newer.app.initialize();
  await Promise.resolve();
  assert.equal(newer.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(newerEnvironment.workerMessages, [], "release hashes have no ordering, so inequality is not successor proof");
  newer.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(newerEnvironment.workerMessages, [{ type: "SKIP_WAITING" }]);
});

test("a pre-existing stale waiting hash is offered but never activated automatically", async () => {
  const environment = updateEnvironment({ waitingReleaseId: OLD_RELEASE });
  const harness = updateControllerHarness({ environment });
  await harness.app.initialize();
  await Promise.resolve();

  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(environment.workerMessages, []);
});

test("the current page release replaces a proven older active controller but not an already-current controller", async () => {
  const upgradeEnvironment = updateEnvironment({
    waitingReleaseId: CURRENT_RELEASE,
    activeReleaseId: OLD_RELEASE,
  });
  const upgrade = updateControllerHarness({ environment: upgradeEnvironment });
  await upgrade.app.initialize();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(upgradeEnvironment.workerMessages, [{ type: "SKIP_WAITING" }]);

  const freshEnvironment = updateEnvironment({
    waitingReleaseId: CURRENT_RELEASE,
    activeReleaseId: CURRENT_RELEASE,
  });
  const fresh = updateControllerHarness({ environment: freshEnvironment });
  await fresh.app.initialize();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fresh.document.getElementById("update-banner").hidden, true);
  assert.deepEqual(freshEnvironment.workerMessages, []);
});

test("a same-page waiting release stays visibly manual when the incumbent controller cannot prove its identity", async () => {
  const environment = updateEnvironment({
    waitingReleaseId: CURRENT_RELEASE,
    respondToActiveReleaseQuery: false,
  });
  const harness = updateControllerHarness({ environment });
  await harness.app.initialize();
  await Promise.resolve();

  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(environment.workerMessages, []);
});

test("an unidentified legacy waiting worker is conservatively offered after the bounded proof timeout", async () => {
  const environment = updateEnvironment({ respondToReleaseQuery: false });
  const harness = updateControllerHarness({ environment });
  await harness.app.initialize();
  await Promise.resolve();
  assert.equal(harness.document.getElementById("update-banner").hidden, true, "identity is checked before prompting");
  assert.equal(environment.workerReleaseQueries.length, 1);

  harness.runTimers(1_000);
  await Promise.resolve();
  assert.equal(harness.document.getElementById("update-banner").hidden, false, "unknown workers must not be silently discarded");
  harness.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(environment.workerMessages, [{ type: "SKIP_WAITING" }]);
});

test("controller migration uses a content-versioned full navigation and defers tabs with browser-only work", async () => {
  const environment = updateEnvironment();
  const safe = updateControllerHarness({ environment });
  const unsafe = updateControllerHarness({ environment });
  await Promise.all([safe.app.initialize(), unsafe.app.initialize()]);
  await Promise.resolve();
  unsafe.document.getElementById("message-input").value = "unfinished private draft";
  safe.document.getElementById("apply-update").dispatch("click");
  environment.registration.waiting = null;
  const controller = environment.transitionController();
  const successor = `release-${"d".repeat(64)}`;
  environment.serviceWorker.dispatch("message", {
    data: { type: "LAZYING_AGENT_RELEASE", releaseId: successor },
    source: controller,
  });
  assert.deepEqual(safe.replacements, [`https://llm.lazying.art/?v=${successor}`]);
  assert.equal(safe.reloads, 0);
  assert.deepEqual(unsafe.replacements, []);
  assert.equal(unsafe.reloads, 0, "a controller change must not discard an unsafe tab");
  assert.equal(unsafe.document.getElementById("update-banner").hidden, false);
  unsafe.document.getElementById("message-input").value = "";
  unsafe.document.getElementById("message-input").dispatch("input");
  assert.deepEqual(unsafe.replacements, [`https://llm.lazying.art/?v=${successor}`]);
});

test("a paused authoritative chat finalization defers update activation and controller reload until Resume completes it", async () => {
  const threadId = "chat_0001_xxxxxxxxxxxxxxxxxxxxxxxx";
  const generationId = "generation_0004_xxxxxxxxxxxxxxxxxxxxxxxx";
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const now = "2026-08-23T08:00:00.000Z";
  let thread = null;
  let messages = [];
  let runStarted = false;
  let snapshotAvailable = false;
  const disabledCapability = {
    schemaVersion: "1",
    enabled: false,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: false, resume: false, retry: false },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
  };
  const agent = {
    async capabilities() { return disabledCapability; },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async *streamRunEvents() {},
  };
  const chat = {
    async capabilities() { return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }; },
    prepareThread({ title }) {
      return Object.freeze({ threadId, title, idempotencyKey: "thread_create_update_finalize_x" });
    },
    async createThread(request) {
      thread = {
        threadId, title: request.title, modelAlias: "local-default", revision: 0, ledgerHash: null,
        messageCount: 0, ledgerBytes: 0, currentGenerationId: null, createdAt: now, updatedAt: now,
      };
      return { request, thread };
    },
    async retryCreateThread(request) { return await this.createThread(request); },
    async listThreads() { return { threads: thread ? [thread] : [] }; },
    async getThread() {
      if (runStarted && !snapshotAvailable) {
        throw Object.assign(new Error("snapshot temporarily unavailable"), { retryable: true });
      }
      return { thread };
    },
    async listMessages({ afterRevision, limit }) {
      return { messages: messages.filter((message) => message.revision > afterRevision).slice(0, limit) };
    },
    async getAttachment() { throw new Error("unexpected attachment read"); },
    prepareRun(request) {
      return Object.freeze({ ...request, generationId, idempotencyKey: "run_start_update_finalize_xxxx" });
    },
    async startRun(request) {
      runStarted = true;
      messages = [
        {
          threadId, messageId: "message_0001_xxxxxxxxxxxxxxxxxxxxxxxx", revision: 1, role: "user",
          content: request.content, contentBytes: request.content.length, previousHash: null, messageHash: hashA,
          generationId: null, createdAt: now,
        },
        {
          threadId, messageId: "message_0002_xxxxxxxxxxxxxxxxxxxxxxxx", revision: 2, role: "assistant",
          content: "Ready after finalization", contentBytes: 24, previousHash: hashA, messageHash: hashB,
          generationId, createdAt: now,
        },
      ];
      thread = {
        ...thread, revision: 2, ledgerHash: hashB, messageCount: 2,
        ledgerBytes: messages.reduce((total, message) => total + message.contentBytes, 0), updatedAt: now,
      };
      return { request, generation: { threadId, generationId, status: "completed", terminal: true } };
    },
    async retryRun(request) { return await this.startRun(request); },
    async getRunStatus() { return { generation: { threadId, generationId, status: "completed", terminal: true } }; },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("unexpected cancellation"); },
    async cancelRun() { throw new Error("unexpected cancellation"); },
  };
  const environment = updateEnvironment({ waiting: false });
  const harness = updateControllerHarness({
    environment,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat,
  });
  await harness.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  harness.document.getElementById("message-input").value = "Keep this completed response recoverable";
  await harness.app.submitMessage({ preventDefault() {} });
  assert.equal(harness.document.getElementById("workspace").dataset.status, "finalizing");

  const installing = environment.waitingWorker;
  environment.registration.installing = installing;
  environment.registration.waiting = environment.waitingWorker;
  environment.registration.dispatch("updatefound");
  installing.dispatch("statechange");
  await Promise.resolve();
  assert.equal(harness.document.getElementById("update-banner").hidden, false);

  harness.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(environment.workerMessages, [], "Finalizing cannot activate a waiting worker");
  assert.match(harness.document.getElementById("toast").textContent, /Finish the current draft or response/u);

  environment.registration.waiting = null;
  const controller = environment.transitionController();
  const successor = `release-${"f".repeat(64)}`;
  environment.serviceWorker.dispatch("message", {
    data: { type: "LAZYING_AGENT_RELEASE", releaseId: successor },
    source: controller,
  });
  assert.deepEqual(harness.replacements, [], "another tab's controller activation cannot reload paused Finalizing");

  snapshotAvailable = true;
  await harness.app.resume();
  assert.equal(harness.document.getElementById("workspace").dataset.status, "completed");
  harness.runTimers(1_000);
  assert.deepEqual(harness.replacements, [`https://llm.lazying.art/?v=${successor}`]);
});

test("a deferred tab replaces an obsolete R2 handshake when a distinct R3 controller takes ownership", async () => {
  const environment = updateEnvironment();
  const harness = updateControllerHarness({ environment });
  await harness.app.initialize();
  await Promise.resolve();
  const message = harness.document.getElementById("message-input");
  message.value = "keep this draft across two controller migrations";

  const releaseTwo = `release-${"2".repeat(64)}`;
  const controllerTwo = environment.transitionController();
  environment.serviceWorker.dispatch("message", {
    data: { type: "LAZYING_AGENT_RELEASE", releaseId: releaseTwo },
    source: controllerTwo,
  });
  assert.deepEqual(harness.replacements, []);
  assert.deepEqual(controllerTwo.messages, [{ type: "GET_LAZYING_AGENT_RELEASE" }]);

  const releaseThree = `release-${"3".repeat(64)}`;
  const controllerThree = environment.transitionController();
  assert.deepEqual(controllerThree.messages, [{ type: "GET_LAZYING_AGENT_RELEASE" }]);
  environment.serviceWorker.dispatch("message", {
    data: { type: "LAZYING_AGENT_RELEASE", releaseId: releaseTwo },
    source: controllerTwo,
  });
  environment.serviceWorker.dispatch("message", {
    data: { type: "LAZYING_AGENT_RELEASE", releaseId: releaseThree },
    source: controllerThree,
  });
  message.value = "";
  message.dispatch("input");

  assert.deepEqual(harness.replacements, [`https://llm.lazying.art/?v=${releaseThree}`]);
  assert.equal(harness.reloads, 0);
});

test("a release-handshake timeout never navigates until Apply verifies the exact active release", async () => {
  const staleRelease = `release-${"1".repeat(64)}`;
  const harness = updateControllerHarness({
    locationHref: `https://llm.lazying.art/?v=${staleRelease}`,
  });
  await harness.app.initialize();
  await Promise.resolve();
  const controller = harness.transitionController();
  assert.deepEqual(controller.messages, [{ type: "GET_LAZYING_AGENT_RELEASE" }]);

  harness.runTimers(1_000);
  await Promise.resolve();

  assert.deepEqual(harness.replacements, [], "unknown controller identity must keep the current page intact");
  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.equal(harness.document.getElementById("apply-update").disabled, false);

  controller.releaseId = NEXT_RELEASE;
  harness.document.getElementById("apply-update").dispatch("click");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(harness.replacements, [`https://llm.lazying.art/?v=${NEXT_RELEASE}`]);
  assert.equal(harness.reloads, 0, "neither the stale URL release nor an unversioned fallback may be loaded");
  assert.deepEqual(controller.messages, [
    { type: "GET_LAZYING_AGENT_RELEASE" },
    { type: "GET_LAZYING_AGENT_RELEASE" },
  ]);
});

test("a same-origin worker with a protocol-invalid release label cannot autoactivate or navigate", async () => {
  const invalidRelease = "legacy-worker-v99";
  const environment = updateEnvironment({ waitingReleaseId: invalidRelease });
  const harness = updateControllerHarness({ environment });
  await harness.app.initialize();
  await Promise.resolve();

  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(environment.workerMessages, [], "an invalid waiting-worker label has no successor provenance");

  environment.registration.waiting = null;
  const invalidController = environment.transitionController(invalidRelease);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.replacements, []);
  assert.equal(harness.document.getElementById("update-banner").hidden, false);

  harness.document.getElementById("apply-update").dispatch("click");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.replacements, [], "manual retry also requires an exact release grammar proof");
  assert.equal(harness.document.getElementById("apply-update").disabled, false);
  assert.equal(invalidController.messages.length >= 2, true);
});

test("accepted Agent prompts bind to their run before streaming and reset old collapsed activity", async () => {
  const threadId = "thr_13572468-2468-4135-8246-135724681357";
  const runId = "run_13572468-2468-4135-8246-135724681357";
  const instant = "2026-08-28T12:00:00.000Z";
  const envelope = {
    schemaVersion: "1",
    id: `${runId}.1`,
    seq: 1,
    type: "run.completed",
    threadId,
    runId,
    createdAt: instant,
    payload: {},
    previousHash: "0".repeat(64),
  };
  const terminalEvent = await verifyAgentEvent({
    ...envelope,
    hash: createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex"),
  }, {
    expectedRunId: runId,
    expectedThreadId: threadId,
    afterSeq: 0,
    previousHash: "0".repeat(64),
    digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  });
  let releaseStream;
  const streamGate = new Promise((resolve) => { releaseStream = resolve; });
  let announceStream;
  const streamStarted = new Promise((resolve) => { announceStream = resolve; });
  const agent = {
    async capabilities() { return enabledAgentPwaCapability(); },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async createThread() { return { thread: { id: threadId, title: "Bound accepted run" } }; },
    async startRun() { return { run: { id: runId, threadId, status: "starting" } }; },
    async *streamRunEvents() {
      announceStream();
      await streamGate;
      yield { event: terminalEvent, cursor: { seq: 1, hash: terminalEvent.hash } };
    },
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "csrf-token-value-long-enough",
    }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
  });
  await harness.app.initialize();
  const oldPlan = harness.document.createElement("li");
  oldPlan.textContent = "Completed old plan";
  harness.document.getElementById("agent-plan").appendChild(oldPlan);
  const oldEvent = harness.document.createElement("li");
  oldEvent.textContent = "Completed old activity";
  harness.document.getElementById("agent-timeline").appendChild(oldEvent);
  const oldArtifact = harness.document.createElement("section");
  oldArtifact.textContent = "Completed old artifact";
  harness.document.getElementById("agent-artifacts").appendChild(oldArtifact);
  harness.document.getElementById("agent-artifacts").hidden = false;
  harness.document.getElementById("activity-disclosure").open = true;
  harness.document.getElementById("message-input").value = "Run this accepted task in the same conversation";

  const submission = harness.app.submitMessage({ preventDefault() {} });
  await streamStarted;
  const userMessage = [...harness.document.getElementById("messages").children]
    .find((message) => message.dataset.role === "user");
  assert.equal(userMessage?.dataset.runId, runId, "the visible prompt owns the accepted run before its first event");
  assert.equal(harness.document.getElementById("activity-disclosure").open, false);
  assert.equal(harness.document.getElementById("agent-plan").children.length, 0);
  assert.equal(harness.document.getElementById("agent-timeline").children.length, 0);
  assert.equal(harness.document.getElementById("agent-artifacts").children.length, 0);
  assert.equal(harness.document.getElementById("agent-artifacts").hidden, true);

  releaseStream();
  await submission;
  assert.equal(harness.document.getElementById("workspace").dataset.status, "completed");
});

test("authoritative terminal Agent states remain update-safe while retaining their run identity", async () => {
  const threadId = "thr_12345678-1234-4123-8123-123456789abc";
  const runId = "run_12345678-1234-4123-8123-123456789abc";
  const capability = {
    schemaVersion: "1",
    enabled: true,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: true, resume: true, retry: false },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
  };
  const inactiveChat = {
    async capabilities() { return { visionInput: false, visionMediaTypes: [], maximumImageBytes: 0 }; },
    prepareThread() {}, async createThread() {}, async retryCreateThread() {},
    async listThreads() { return { threads: [] }; }, async getThread() {}, async listMessages() {}, async getAttachment() {},
    prepareRun() {}, async startRun() {}, async retryRun() {}, async getRunStatus() {}, async *streamRunEvents() {},
    prepareCancellation() {}, async cancelRun() {},
  };

  for (const status of ["completed", "failed", "cancelled"]) {
    const type = `run.${status}`;
    const envelope = {
      schemaVersion: "1",
      id: `${runId}.1`,
      seq: 1,
      type,
      threadId,
      runId,
      createdAt: "2026-08-20T08:00:00.000Z",
      payload: {},
      previousHash: "0".repeat(64),
    };
    const value = { ...envelope, hash: createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex") };
    const terminalEvent = await verifyAgentEvent(value, {
      expectedRunId: runId,
      expectedThreadId: threadId,
      afterSeq: 0,
      previousHash: "0".repeat(64),
      digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
    });
    const agent = {
      async capabilities() { return capability; },
      async listThreads() { return { threads: [] }; },
      async createThread() { return { thread: { id: threadId, title: "Terminal update safety" } }; },
      async startRun() { return { run: { id: runId, threadId, status: "starting" } }; },
      async *streamRunEvents() { yield { event: terminalEvent, cursor: { seq: 1, hash: terminalEvent.hash } }; },
      async runStatus() { throw new Error("terminal event must complete without a status shortcut"); },
    };
    const harness = updateControllerHarness({
      restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
      agent,
      chat: inactiveChat,
    });
    await harness.app.initialize();
    await Promise.resolve();
    harness.document.getElementById("message-input").value = `finish as ${status}`;
    await harness.app.submitMessage({ preventDefault() {} });
    assert.equal(harness.document.getElementById("workspace").dataset.status, status);

    harness.document.getElementById("apply-update").dispatch("click");
    assert.deepEqual(harness.workerMessages, [{ type: "SKIP_WAITING" }], `${status} is terminal and safe to reload`);
  }
});

test("a verified historical Agent file remains renderable after the current creation capability omits file", async () => {
  const threadId = "thr_abcdefab-cdef-4abc-8def-abcdefabcdef";
  const runId = "run_abcdefab-cdef-4abc-8def-abcdefabcdef";
  const createdAt = "2026-08-25T16:00:00.000Z";
  const createdEnvelope = {
    schemaVersion: "1",
    id: `${runId}.1`,
    seq: 1,
    type: "artifact.created",
    threadId,
    runId,
    createdAt,
    payload: {
      artifact: artifact("file", {
        schemaVersion: "1",
        filename: "paper.pdf",
        mime: "application/pdf",
        bytes: 4_096,
        sha256: "c".repeat(64),
      }),
      receiptDigest: "d".repeat(64),
    },
    previousHash: "0".repeat(64),
  };
  const createdEvent = await verifyAgentEvent({
    ...createdEnvelope,
    hash: createHash("sha256").update(canonicalJson(createdEnvelope), "utf8").digest("hex"),
  }, {
    expectedRunId: runId,
    expectedThreadId: threadId,
    afterSeq: 0,
    previousHash: "0".repeat(64),
    digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  });
  const terminalEnvelope = {
    schemaVersion: "1",
    id: `${runId}.2`,
    seq: 2,
    type: "run.completed",
    threadId,
    runId,
    createdAt,
    payload: {},
    previousHash: createdEvent.hash,
  };
  const terminalEvent = await verifyAgentEvent({
    ...terminalEnvelope,
    hash: createHash("sha256").update(canonicalJson(terminalEnvelope), "utf8").digest("hex"),
  }, {
    expectedRunId: runId,
    expectedThreadId: threadId,
    afterSeq: 1,
    previousHash: createdEvent.hash,
    digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  });

  let artifactRenders = 0;
  const agent = {
    async capabilities() {
      return {
        schemaVersion: "1",
        enabled: true,
        agent: { kind: "aginti", label: "AgInTi Agent" },
        model: { label: "LocalLLM" },
        actions: { cancel: true, resume: true, retry: false },
        attachments: { enabled: false },
        artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
      };
    },
    async listThreads() { return { threads: [] }; },
    async createThread() { return { thread: { id: threadId, title: "Rollback-readable file" } }; },
    async startRun() { return { run: { id: runId, threadId, status: "starting" } }; },
    async *streamRunEvents() {
      yield { event: createdEvent, cursor: { seq: 1, hash: createdEvent.hash } };
      yield { event: terminalEvent, cursor: { seq: 2, hash: terminalEvent.hash } };
    },
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    renderer: {
      renderMarkdown(target, value) { target.textContent = value; },
      renderArtifact(target) {
        artifactRenders += 1;
        target.textContent = "rendered historical file controls";
        return true;
      },
    },
  });
  await harness.app.initialize();
  harness.document.getElementById("message-input").value = "Compile the exact PDF";
  await harness.app.submitMessage({ preventDefault() {} });
  assert.ok(artifactRenders > 0);
  assert.match(harness.document.getElementById("messages").textContent, /rendered historical file controls/u);
});

test("Update refuses to activate while a password or draft is only browser-held", async () => {
  const harness = updateControllerHarness();
  harness.document.getElementById("password").value = "not-yet-submitted";
  await harness.app.initialize();
  await Promise.resolve();
  harness.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(harness.workerMessages, []);
  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.match(harness.document.getElementById("toast").textContent, /Finish the current draft or response/u);
});

test("a successor controller aborts slow image preparation and fences its stale completion", async () => {
  const environment = updateEnvironment({ waiting: false, activeReleaseId: CURRENT_RELEASE });
  const clients = idleAuthenticatedPwaClients();
  const pending = Promise.withResolvers();
  const bytes = canonicalPngHeader();
  let preparationSignal;
  let objectUrls = 0;
  const harness = updateControllerHarness({
    waiting: false,
    environment,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: clients.agent,
    chat: clients.chat,
    canonicalizeImage(file, options) {
      preparationSignal = options.signal;
      return pending.promise;
    },
    createObjectUrl() { objectUrls += 1; return `blob:stale-release-${objectUrls}`; },
    revokeObjectUrl() {},
  });
  await harness.app.initialize();
  await Promise.resolve();
  harness.document.getElementById("message-input").value = "keep this browser-only draft";
  const input = harness.document.getElementById("image-input");
  input.files = [{ name: "slow-release-photo.heic" }];
  input.dispatch("change");
  assert.equal(harness.document.getElementById("add-image").textContent, "Preparing images…");

  environment.transitionController(NEXT_RELEASE);
  assert.equal(preparationSignal.aborted, true);
  assert.equal(harness.document.getElementById("add-image").textContent, "Images");
  pending.resolve(Object.freeze({
    attachmentId: "image_stale_release_xxxxxxxxx",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    width: 64,
    height: 64,
    bytes,
    previewBlob: new Blob([bytes], { type: "image/png" }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(objectUrls, 0);
  assert.equal(harness.document.getElementById("image-preview").hidden, true);
  assert.equal(harness.document.getElementById("message-input").value, "keep this browser-only draft");
  assert.deepEqual(harness.replacements, [], "the new controller cannot discard browser-only work");
});

test("a staged image remains in place when protected update handoff storage is unavailable", async () => {
  const environment = updateEnvironment();
  const capability = {
    schemaVersion: "1",
    enabled: false,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: false, resume: false, retry: false },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
  };
  const agent = {
    async capabilities() { return capability; },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async *streamRunEvents() {},
  };
  const chat = {
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread() {}, async createThread() {}, async retryCreateThread() {},
    async listThreads() { return { threads: [] }; }, async getThread() {}, async listMessages() {}, async getAttachment() {},
    prepareRun() {}, async startRun() {}, async retryRun() {}, async getRunStatus() {}, async *streamRunEvents() {},
    prepareCancellation() {}, async cancelRun() {},
  };
  const bytes = canonicalPngHeader();
  let handoffSaveAttempts = 0;
  let handoffSaveAttemptedResolve;
  const handoffSaveAttempted = new Promise((resolve) => { handoffSaveAttemptedResolve = resolve; });
  const harness = updateControllerHarness({
    environment,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000200",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 64,
        height: 64,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl: () => "blob:staged-update-image",
    revokeObjectUrl() {},
    updateHandoffStore: {
      async save() {
        handoffSaveAttempts += 1;
        handoffSaveAttemptedResolve();
        throw new TypeError("storage unavailable");
      },
      async take() { return null; },
      async discard() {},
    },
  });
  await harness.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const imageInput = harness.document.getElementById("image-input");
  imageInput.files = [{ name: "staged.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.document.getElementById("image-preview").hidden, false);
  harness.document.getElementById("message-input").value = "keep this image";

  assert.deepEqual(environment.workerMessages, [], "a browser-held image must block automatic activation");
  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  harness.document.getElementById("apply-update").dispatch("click");
  await handoffSaveAttempted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(environment.workerMessages, []);
  assert.equal(handoffSaveAttempts, 1);
  assert.match(harness.document.getElementById("toast").textContent, /could not be protected/u);

  harness.document.getElementById("remove-image").dispatch("click");
  harness.document.getElementById("message-input").value = "";
  harness.document.getElementById("message-input").dispatch("input");
  harness.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(environment.workerMessages, [{ type: "SKIP_WAITING" }]);
});

test("a definitively unsent image survives a confirmed stale-PWA update exactly once without redispatch", async () => {
  const capability = {
    schemaVersion: "1",
    enabled: false,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: false, resume: false, retry: false },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
  };
  const agent = {
    async capabilities() { return capability; },
    async listThreads() { return { threads: [] }; },
    async *streamRunEvents() {},
  };
  const mutationCalls = { prepareThread: 0, createThread: 0, startRun: 0 };
  const chat = {
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread() {
      mutationCalls.prepareThread += 1;
      throw new TypeError("local preparation stopped before dispatch");
    },
    async createThread() { mutationCalls.createThread += 1; throw new Error("must not dispatch"); },
    async retryCreateThread() { throw new Error("must not retry"); },
    async listThreads() { return { threads: [] }; },
    async getThread() { throw new Error("no thread exists"); },
    async listMessages() { return { messages: [] }; },
    async getAttachment() { throw new Error("no attachment exists"); },
    prepareRun() { throw new Error("must not prepare a run"); },
    async startRun() { mutationCalls.startRun += 1; throw new Error("must not start"); },
    async retryRun() { throw new Error("must not retry"); },
    async getRunStatus() { throw new Error("no run exists"); },
    async *streamRunEvents() {},
    prepareCancellation() { throw new Error("no run exists"); },
    async cancelRun() { throw new Error("no run exists"); },
  };
  const bytes = canonicalPngHeader();
  const store = memoryUpdateHandoffStore();
  const environment = updateEnvironment();
  const source = updateControllerHarness({
    environment,
    now: () => 10_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat,
    updateHandoffStore: store,
    async canonicalizeImage() {
      return Object.freeze({
        attachmentId: "image_0000000000000200",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 64,
        height: 64,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl: () => "blob:failed-image",
    revokeObjectUrl() {},
  });
  await source.app.initialize();
  await Promise.resolve();
  const imageInput = source.document.getElementById("image-input");
  imageInput.files = [{ name: "failed.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  source.document.getElementById("message-input").value = "Describe this exact restored image";
  await source.app.submitMessage({ preventDefault() {} });
  assert.match(source.document.getElementById("toast").textContent, /not sent/u);
  assert.equal(source.document.getElementById("image-preview").hidden, false);
  assert.equal(source.document.getElementById("update-banner").hidden, false);
  assert.equal(mutationCalls.createThread, 0);
  assert.equal(mutationCalls.startRun, 0);

  source.document.getElementById("apply-update").dispatch("click");
  await store.saved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(environment.workerMessages, [{ type: "SKIP_WAITING" }]);
  assert.equal(store.calls.save, 1);
  assert.equal(store.records.size, 1);
  const encrypted = [...store.records.values()][0];
  assert.deepEqual(Object.keys(encrypted).sort(), [
    "ciphertext", "createdAt", "expiresAt", "handoffId", "iv", "schemaVersion", "scope", "sourceRelease", "targetRelease",
  ]);
  assert.doesNotMatch(JSON.stringify(encrypted), /Describe this exact restored image/u);

  environment.registration.waiting = null;
  environment.transitionController(NEXT_RELEASE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.replacements.length, 1);
  assert.match(
    source.replacements[0],
    new RegExp(`^https://llm\\.lazying\\.art/\\?v=${NEXT_RELEASE}#lazying-update-handoff=[a-f0-9]{64}\\.[A-Za-z0-9_-]{43}$`, "u"),
  );

  const restoredMutationCalls = { prepareThread: 0, createThread: 0, startRun: 0 };
  const restoredChat = {
    ...chat,
    prepareThread() { restoredMutationCalls.prepareThread += 1; throw new Error("restore must not prepare"); },
    async createThread() { restoredMutationCalls.createThread += 1; throw new Error("restore must not create"); },
    async startRun() { restoredMutationCalls.startRun += 1; throw new Error("restore must not send"); },
  };
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 10_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat: restoredChat,
    updateHandoffStore: store,
    createObjectUrl: () => "blob:restored-image",
    revokeObjectUrl() {},
  });
  assert.deepEqual(restored.historyReplacements, [], "the fragment remains reload-safe until authenticated decryption succeeds");
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("message-input").value, "Describe this exact restored image");
  assert.equal(restored.document.getElementById("image-preview").hidden, false);
  assert.equal(restored.document.getElementById("image-preview-thumbnail").src, "blob:restored-image");
  assert.match(restored.document.getElementById("toast").textContent, /restored/u);
  assert.deepEqual(restoredMutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
  assert.equal(store.calls.take, 1);
  assert.equal(store.records.size, 0, "the encrypted handoff is deleted before validation and restored only in memory");
  assert.deepEqual(restored.historyReplacements, [`/?v=${NEXT_RELEASE}`], "successful decryption scrubs the one-time key");
});

test("an Agent draft keeps its exact mode and thread across a versioned full-page update", async () => {
  const threadId = "thr_12345678-1234-4123-8123-123456789abc";
  const runId = "run_12345678-1234-4123-8123-123456789abc";
  const successorRunId = "run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const instant = "2026-08-25T10:00:00.000Z";
  const terminalEvent = async (ownedRunId) => {
    const envelope = {
      schemaVersion: "1",
      id: `${ownedRunId}.1`,
      seq: 1,
      type: "run.completed",
      threadId,
      runId: ownedRunId,
      createdAt: instant,
      payload: {},
      previousHash: "0".repeat(64),
    };
    const value = {
      ...envelope,
      hash: createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex"),
    };
    return await verifyAgentEvent(value, {
      expectedRunId: ownedRunId,
      expectedThreadId: threadId,
      afterSeq: 0,
      previousHash: "0".repeat(64),
      digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
    });
  };
  const priorTerminalEvent = await terminalEvent(runId);
  const successorTerminalEvent = await terminalEvent(successorRunId);
  const thread = Object.freeze({
    id: threadId,
    title: "TeX and PDF work",
    status: "idle",
    revision: 3,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: runId,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: "a".repeat(64),
      lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([
      Object.freeze({
        id: "msg_1234567890abcdef",
        role: "user",
        content: "Create the first verified result",
        runId,
        createdAt: instant,
        digest: "b".repeat(64),
      }),
      Object.freeze({
        id: "msg_abcdef1234567890",
        role: "assistant",
        content: "The first verified result is complete.",
        runId,
        createdAt: instant,
        digest: "c".repeat(64),
      }),
    ]),
  });
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    search: Object.freeze({
      enabled: true,
      modes: Object.freeze(["web", "papers", "both"]),
      maximumSources: 20,
    }),
    artifacts: Object.freeze({
      kinds: Object.freeze(["plot", "table", "markdown", "sources"]),
      schemaVersion: "1",
    }),
  });
  const priorRun = Object.freeze({
    id: runId,
    threadId,
    previousRunId: null,
    status: "completed",
    createdAt: instant,
    startedAt: instant,
    completedAt: instant,
    cancelRequestedAt: null,
    output: "The first verified result is complete.",
    error: null,
    authority: Object.freeze({
      kind: "aginti",
      snapshotHash: "d".repeat(64),
      runtimeRevision: 1,
      contextDigest: "a".repeat(64),
    }),
    eventCursor: Object.freeze({
      firstSeq: 1,
      lastSeq: 1,
      lastHash: priorTerminalEvent.hash,
      prunedThroughSeq: 0,
    }),
  });
  const successorRun = Object.freeze({
    id: successorRunId,
    threadId,
    previousRunId: runId,
    status: "starting",
  });
  const reads = { source: 0, restored: 0 };
  let staleResumeCalls = 0;
  let successfulResumeCalls = 0;
  const makeAgent = (stage) => ({
    async capabilities() { return capability; },
    async listThreads() {
      if (stage === "restored") throw new Error("injected sidebar list outage");
      return { schemaVersion: "1", threads: [thread], nextBefore: null };
    },
    async getThread(requested) {
      assert.equal(requested, threadId);
      reads[stage] += 1;
      return { schemaVersion: "1", thread };
    },
    async runStatus(requestedRunId) {
      assert.equal(requestedRunId, runId);
      return { schemaVersion: "1", run: priorRun };
    },
    async resumeRun(previousRunId, text, options) {
      assert.equal(previousRunId, runId);
      assert.equal(text, "Continue this exact Agent thread after the deployment");
      assert.deepEqual(options.search, { mode: "papers", limit: 6 });
      if (stage === "source") {
        staleResumeCalls += 1;
        throw Object.assign(new Error("stale Agent release"), {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: NEXT_RELEASE,
        });
      }
      successfulResumeCalls += 1;
      return { schemaVersion: "1", run: successorRun };
    },
    async *streamRunEvents({ runId: requestedRunId }) {
      const event = requestedRunId === runId
        ? priorTerminalEvent
        : requestedRunId === successorRunId ? successorTerminalEvent : null;
      if (event === null) throw new Error("unexpected Agent run replay");
      yield { event, cursor: { seq: 1, hash: event.hash } };
    },
  });
  const sourceChat = idleAuthenticatedPwaClients().chat;
  const store = memoryUpdateHandoffStore();
  const environment = updateEnvironment();
  const source = updateControllerHarness({
    environment,
    now: () => 40_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: makeAgent("source"),
    chat: sourceChat,
    updateHandoffStore: store,
  });
  await source.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(source.document.getElementById("conversation-title").textContent, thread.title);
  source.document.getElementById("search-toggle").dispatch("click");
  source.document.getElementById("search-mode").value = "papers";
  source.document.getElementById("search-limit").value = "6";
  source.document.getElementById("message-input").value = "Continue this exact Agent thread after the deployment";
  await source.app.submitMessage({ preventDefault() {} });
  await store.saved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleResumeCalls, 1);
  assert.equal(source.replacements.length, 1);
  assert.equal([...store.records.values()][0].schemaVersion, "2",
    "the v3 mode-aware payload remains inside the v2 cross-tab-compatible encrypted envelope");

  const replayFailureStore = memoryUpdateHandoffStore([...store.records.entries()]);
  const replayDelegate = makeAgent("restored");
  let replayGetAttempts = 0;
  const replayFailureAgent = {
    ...replayDelegate,
    async getThread(requested) {
      assert.equal(requested, threadId);
      replayGetAttempts += 1;
      if (replayGetAttempts === 1) throw new Error("injected exact ledger read outage");
      return await replayDelegate.getThread(requested);
    },
  };
  const replayFailure = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 40_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: replayFailureAgent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: replayFailureStore,
  });
  await replayFailure.app.initialize();
  assert.equal(replayFailure.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(replayFailure.document.getElementById("message-input").disabled, true);
  assert.equal(replayFailure.document.getElementById("send-message").disabled, true);
  assert.equal(replayFailureStore.records.size, 1,
    "a failed exact replay keeps the encrypted handoff reloadable");
  assert.match(replayFailure.window.location.href, /#lazying-update-handoff=/u);
  const retryThread = [...replayFailure.document.getElementById("thread-list").children]
    .find((entry) => entry.dataset.threadId === threadId);
  assert.ok(retryThread, "the exact owned retry target remains visible after list and ledger outages");
  threadOpenControl(retryThread).dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replayGetAttempts, 2);
  assert.equal(replayFailure.document.getElementById("message-input").disabled, false);
  assert.equal(
    replayFailure.document.getElementById("message-input").value,
    "Continue this exact Agent thread after the deployment",
  );
  assert.equal(replayFailureStore.records.size, 0,
    "a verified exact retry consumes the retained recovery row and unlocks the composer");
  reads.restored = 0;

  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 40_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: makeAgent("restored"),
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(restored.document.getElementById("agent-mode").getAttribute("aria-pressed"), "true");
  assert.equal(restored.document.getElementById("chat-mode").getAttribute("aria-pressed"), "false");
  assert.equal(restored.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(
    restored.document.getElementById("message-input").value,
    "Continue this exact Agent thread after the deployment",
  );
  assert.equal(restored.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(restored.document.getElementById("search-mode").value, "papers");
  assert.equal(restored.document.getElementById("search-limit").value, "6");
  assert.equal(reads.restored, 1, "the handoff reopens the owned Agent thread exactly once");
  const restoredThreadButton = [...restored.document.getElementById("thread-list").children]
    .find((entry) => entry.dataset.threadId === threadId);
  assert.equal(threadOpenControl(restoredThreadButton)?.getAttribute("aria-current"), "true",
    "the directly verified thread is restored even when the sidebar list request failed");
  assert.equal(successfulResumeCalls, 0, "restoring the draft is read-only");
  assert.equal(store.records.size, 0);
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(successfulResumeCalls, 1, "the next Send resumes the replayed terminal Agent run");
  assert.equal(restored.document.getElementById("workspace").dataset.status, "completed");
});

test("a v0.1.27 text-only v2 handoff is visible but fenced until its conversation is chosen", async () => {
  const legacy = await legacyV2DraftHandoff();
  const store = memoryUpdateHandoffStore([legacy.storageEntry]);
  let agentMutations = 0;
  const agent = {
    async capabilities() {
      return {
        schemaVersion: "1",
        enabled: true,
        agent: { kind: "aginti", label: "AgInTi Agent" },
        model: { label: "LocalLLM" },
        actions: { cancel: true, resume: true, retry: false },
        attachments: { enabled: false },
        artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
      };
    },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async createThread() { agentMutations += 1; throw new Error("legacy recovery must remain read-only"); },
    async startRun() { agentMutations += 1; throw new Error("legacy recovery must remain read-only"); },
    async *streamRunEvents() {},
  };
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: legacy.href,
    now: () => 50_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  assert.deepEqual(restored.historyReplacements, []);
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(restored.document.getElementById("message-input").value, "Continue the exact TeX and PDF task");
  assert.equal(restored.document.getElementById("message-input").disabled, true);
  assert.equal(restored.document.getElementById("send-message").disabled, true);
  assert.match(restored.document.getElementById("toast").textContent, /choose its exact conversation/iu);
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(agentMutations, 0);
  restored.document.getElementById("new-thread").dispatch("click");
  assert.equal(restored.document.getElementById("message-input").value, "Continue the exact TeX and PDF task");
  assert.equal(restored.document.getElementById("message-input").disabled, true,
    "the legacy prompt stays immutable until Search or No Search is explicit");
  assert.equal(restored.document.getElementById("send-message").disabled, false);
  assert.match(restored.document.getElementById("toast").textContent, /confirm No Search/iu);
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(agentMutations, 0, "the first Run only confirms No Search");
  assert.equal(restored.document.getElementById("message-input").disabled, false);
  assert.equal(restored.document.getElementById("send-message").disabled, false);
  assert.equal(store.records.size, 0);

});

test("an unsupported recovered Agent Search stays read-only until explicit No Search confirmation", async () => {
  const threadId = "thr_22222222-2222-4222-8222-222222222222";
  const runId = "run_22222222-2222-4222-8222-222222222222";
  const instant = "2026-08-25T13:00:00.000Z";
  const thread = Object.freeze({
    id: threadId,
    title: "Recovered Search ownership",
    status: "idle",
    revision: 1,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: null,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: "2".repeat(64),
      lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([]),
  });
  const handoff = await currentV3AgentDraftHandoff({
    draft: "Continue without silently changing this Search intent",
    threadId,
    search: { mode: "papers", limit: 6 },
  });
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  const terminalEnvelope = {
    schemaVersion: "1",
    id: `${runId}.1`,
    seq: 1,
    type: "run.completed",
    threadId,
    runId,
    createdAt: instant,
    payload: {},
    previousHash: "0".repeat(64),
  };
  const terminalEvent = await verifyAgentEvent({
    ...terminalEnvelope,
    hash: createHash("sha256").update(canonicalJson(terminalEnvelope), "utf8").digest("hex"),
  }, {
    expectedRunId: runId,
    expectedThreadId: threadId,
    afterSeq: 0,
    previousHash: "0".repeat(64),
    digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  });
  let starts = 0;
  let dispatchedOptions = null;
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    search: Object.freeze({
      enabled: true,
      modes: Object.freeze(["web", "papers", "both"]),
      maximumSources: 3,
    }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown", "sources"]), schemaVersion: "1" }),
  });
  const agent = {
    async capabilities() { return capability; },
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(requested) {
      assert.equal(requested, threadId);
      return { schemaVersion: "1", thread };
    },
    async startRun(requestedThreadId, text, options) {
      starts += 1;
      assert.equal(requestedThreadId, threadId);
      assert.equal(text, "Continue without silently changing this Search intent");
      dispatchedOptions = options;
      return { schemaVersion: "1", run: { id: runId, threadId, status: "starting" } };
    },
    async *streamRunEvents() {
      yield { event: terminalEvent, cursor: { seq: 1, hash: terminalEvent.hash } };
    },
  };
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 60_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(restored.document.getElementById("message-input").value,
    "Continue without silently changing this Search intent");
  assert.equal(restored.document.getElementById("message-input").disabled, true);
  assert.equal(restored.document.getElementById("send-message").disabled, false,
    `Run remains available only as an explicit choice confirmation; toast=${restored.document.getElementById("toast").textContent}`);
  assert.equal(restored.document.getElementById("search-toggle").getAttribute("aria-pressed"), "false");
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(starts, 0, "the confirmation press performs no Agent mutation");
  assert.equal(restored.document.getElementById("message-input").disabled, false);
  assert.equal(store.records.size, 0);
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(starts, 1);
  assert.equal(Object.hasOwn(dispatchedOptions, "search"), false,
    "the second press dispatches only after No Search is explicit");
});

test("an unresolved Agent Search downgrade survives repeated same-account authentication", async () => {
  let sessionValid = true;
  let maximumSources = 20;
  let mutations = 0;
  const capability = () => Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    search: Object.freeze({
      enabled: true,
      modes: Object.freeze(["web", "papers", "both"]),
      maximumSources,
    }),
    artifacts: Object.freeze({
      kinds: Object.freeze(["plot", "table", "markdown", "sources"]),
      schemaVersion: "1",
    }),
  });
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => sessionValid
      ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
      : { authenticated: false },
    login: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "renewed-csrf-token-long-enough",
    }),
    agent: {
      async capabilities() { return capability(); },
      async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
      async createThread() { mutations += 1; throw new Error("confirmation must remain read-only"); },
      async startRun() { mutations += 1; throw new Error("confirmation must remain read-only"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
  });
  await harness.app.initialize();
  const input = harness.document.getElementById("message-input");
  harness.document.getElementById("search-toggle").dispatch("click");
  harness.document.getElementById("search-mode").value = "papers";
  harness.document.getElementById("search-limit").value = "6";
  input.value = "Keep the unresolved Search choice across every sign-in";
  maximumSources = 3;
  sessionValid = false;

  const signInAgain = async () => {
    harness.window.dispatch("pageshow", { persisted: true });
    await new Promise((resolve) => setImmediate(resolve));
    harness.document.getElementById("username").value = "account-user";
    harness.document.getElementById("password").value = "browser-password";
    harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
    assert.equal(input.value, "Keep the unresolved Search choice across every sign-in");
    assert.equal(input.disabled, true);
    assert.equal(harness.document.getElementById("send-message").disabled, false);
  };

  await signInAgain();
  harness.document.getElementById("chat-mode").dispatch("click");
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent",
    "the unresolved Agent prompt cannot escape into Direct Chat");
  await signInAgain();
  await harness.app.submitMessage({ preventDefault() {} });
  assert.equal(mutations, 0, "the first Run after repeated auth only confirms No Search");
  assert.equal(input.disabled, false);
  assert.equal(harness.document.getElementById("send-message").disabled, false);
});

test("a stale declared Agent head cannot unlock a follow-up when a verified successor exists", async () => {
  const threadId = "thr_33333333-3333-4333-8333-333333333333";
  const firstRunId = "run_33333333-3333-4333-8333-333333333333";
  const successorRunId = "run_44444444-4444-4444-8444-444444444444";
  const firstAt = "2026-08-25T14:00:00.000Z";
  const successorAt = "2026-08-25T14:01:00.000Z";
  const message = (id, role, runId, createdAt, digest) => Object.freeze({
    id,
    role,
    content: role === "user" ? "Continue the chain" : "Verified result",
    runId,
    createdAt,
    digest,
  });
  const thread = Object.freeze({
    id: threadId,
    title: "Hostile stale head",
    status: "idle",
    revision: 5,
    createdAt: firstAt,
    updatedAt: successorAt,
    lastRunId: firstRunId,
    authority: Object.freeze({
      kind: "aginti", mapped: true, runtimeRevision: 1,
      contextDigest: "e".repeat(64), lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([
      message("msg_stale_head_00000001", "user", firstRunId, firstAt, "1".repeat(64)),
      message("msg_stale_head_00000002", "assistant", firstRunId, firstAt, "2".repeat(64)),
      message("msg_stale_head_00000003", "user", successorRunId, successorAt, "3".repeat(64)),
      message("msg_stale_head_00000004", "assistant", successorRunId, successorAt, "4".repeat(64)),
    ]),
  });
  const runs = new Map([
    [firstRunId, completedAgentRun({
      id: firstRunId, threadId, createdAt: firstAt, lastHash: "5".repeat(64),
    })],
    [successorRunId, completedAgentRun({
      id: successorRunId, threadId, previousRunId: firstRunId,
      createdAt: successorAt, lastHash: "6".repeat(64),
    })],
  ]);
  const capability = Object.freeze({
    schemaVersion: "1", enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
  });
  const handoff = await currentV3AgentDraftHandoff({
    draft: "Never resume a stale declared head",
    threadId,
    search: null,
    createdAt: 61_000,
  });
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let mutations = 0;
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 61_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { schemaVersion: "1", thread }; },
      async runStatus(runId) { return { schemaVersion: "1", run: runs.get(runId) }; },
      async resumeRun() { mutations += 1; throw new Error("stale head must never mutate"); },
      async *streamRunEvents() { throw new Error("invalid ancestry must fail before streaming"); },
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("message-input").value, "Never resume a stale declared head");
  assert.equal(restored.document.getElementById("message-input").disabled, true);
  assert.equal(restored.document.getElementById("send-message").disabled, true);
  assert.match(restored.document.getElementById("toast").textContent, /history could not be restored safely/iu);
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(mutations, 0);
  assert.equal(store.records.size, 1, "the prompt stays protected while ancestry is rejected");
});

test("a running-to-terminal Agent read race refreshes the thread before follow-up unlock", async () => {
  const threadId = "thr_55555555-5555-4555-8555-555555555555";
  const runId = "run_55555555-5555-4555-8555-555555555555";
  const instant = "2026-08-25T15:00:00.000Z";
  const userMessage = Object.freeze({
    id: "msg_refresh_race_0000001", role: "user", content: "Finish atomically",
    runId, createdAt: instant, digest: "7".repeat(64),
  });
  const assistantMessage = Object.freeze({
    id: "msg_refresh_race_0000002", role: "assistant", content: "Finished",
    runId, createdAt: instant, digest: "8".repeat(64),
  });
  const baseThread = {
    id: threadId,
    title: "Completion read race",
    revision: 2,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: runId,
    authority: Object.freeze({
      kind: "aginti", mapped: true, runtimeRevision: 1,
      contextDigest: "e".repeat(64), lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
  };
  const runningThread = Object.freeze({ ...baseThread, status: "running", messages: Object.freeze([userMessage]) });
  const settledThread = Object.freeze({
    ...baseThread, status: "idle", revision: 3,
    messages: Object.freeze([userMessage, assistantMessage]),
  });
  const terminalEnvelope = {
    schemaVersion: "1", id: `${runId}.1`, seq: 1, type: "run.completed",
    threadId, runId, createdAt: instant, payload: {}, previousHash: "0".repeat(64),
  };
  const terminalEvent = await verifyAgentEvent({
    ...terminalEnvelope,
    hash: createHash("sha256").update(canonicalJson(terminalEnvelope), "utf8").digest("hex"),
  }, {
    expectedRunId: runId, expectedThreadId: threadId, afterSeq: 0,
    previousHash: "0".repeat(64),
    digest: async (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  });
  const run = completedAgentRun({
    id: runId, threadId, createdAt: instant, lastHash: terminalEvent.hash, output: "Finished",
  });
  const capability = Object.freeze({
    schemaVersion: "1", enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
  });
  const handoff = await currentV3AgentDraftHandoff({
    draft: "Continue only after the settled head is re-read",
    threadId,
    search: null,
    createdAt: 62_000,
  });
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let threadReads = 0;
  let statusReads = 0;
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 62_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [runningThread], nextBefore: null }; },
      async getThread() {
        threadReads += 1;
        return { schemaVersion: "1", thread: threadReads === 1 ? runningThread : settledThread };
      },
      async runStatus() { statusReads += 1; return { schemaVersion: "1", run }; },
      async *streamRunEvents() {
        yield { event: terminalEvent, cursor: { seq: 1, hash: terminalEvent.hash } };
      },
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await restored.app.initialize();
  assert.equal(threadReads, 2, "the terminal status triggers one bounded authoritative thread refresh");
  assert.equal(statusReads, 2, "the refreshed thread/run pair is revalidated together");
  assert.equal(restored.document.getElementById("conversation-title").textContent, settledThread.title);
  assert.equal(restored.document.getElementById("message-input").value,
    "Continue only after the settled head is re-read");
  assert.equal(restored.document.getElementById("message-input").disabled, false);
  assert.equal(restored.document.getElementById("send-message").disabled, false);
  assert.equal(store.records.size, 0);

  const regressedThread = Object.freeze({
    ...baseThread,
    status: "idle",
    revision: 3,
    lastRunId: null,
    messages: Object.freeze([]),
  });
  const hostileHandoff = await currentV3AgentDraftHandoff({
    draft: "Never accept a regressed refreshed head",
    threadId,
    search: null,
    createdAt: 63_000,
  });
  const hostileStore = memoryUpdateHandoffStore([hostileHandoff.storageEntry]);
  let hostileThreadReads = 0;
  const hostile = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: hostileHandoff.href,
    now: () => 63_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [runningThread], nextBefore: null }; },
      async getThread() {
        hostileThreadReads += 1;
        return { schemaVersion: "1", thread: hostileThreadReads === 1 ? runningThread : regressedThread };
      },
      async runStatus() { return { schemaVersion: "1", run }; },
      async *streamRunEvents() { throw new Error("a regressed head must fail before streaming"); },
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: hostileStore,
  });
  await hostile.app.initialize();
  assert.equal(hostileThreadReads, 2);
  assert.equal(hostile.document.getElementById("message-input").disabled, true);
  assert.equal(hostile.document.getElementById("send-message").disabled, true);
  assert.equal(hostileStore.records.size, 1);
});

test("an exact v3 Agent recovery keeps a conflicting composer until two explicit Resume actions", async () => {
  const threadId = "thr_55555555-5555-4555-8555-555555555555";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Exact protected Agent destination",
  });
  const protectedDraft = "Continue the exact protected Agent work";
  const conflict = "Safari restored a different Agent draft";
  const handoff = await currentV3AgentDraftHandoff({
    draft: protectedDraft,
    threadId,
    search: null,
    createdAt: 64_000,
  });
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let exactReads = 0;
  let mutations = 0;
  const agent = {
    async capabilities() { return enabledAgentPwaCapability(); },
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(requested) {
      assert.equal(requested, threadId);
      exactReads += 1;
      return { schemaVersion: "1", thread };
    },
    async createThread() { mutations += 1; throw new Error("recovery must not create a thread"); },
    async startRun() { mutations += 1; throw new Error("recovery must not start a run"); },
    async resumeRun() { mutations += 1; throw new Error("recovery must not resume a run"); },
    async *streamRunEvents() {},
  };
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 64_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  const input = restored.document.getElementById("message-input");
  input.value = conflict;
  await restored.app.initialize();

  assert.equal(exactReads, 1, "the exact owned thread is verified even though its protected draft conflicts");
  assert.equal(restored.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(input.value, conflict);
  assert.equal(input.disabled, true);
  assert.equal(store.records.size, 1, "verification alone cannot consume a draft that is not installed");
  assert.match(restored.window.location.href, /#lazying-update-handoff=/u);

  restored.document.getElementById("resume-run").dispatch("click");
  await settlePwaActions();
  assert.equal(input.value, conflict, "the first Resume only records explicit replacement confirmation");
  assert.equal(store.records.size, 1);
  assert.equal(mutations, 0);
  assert.match(restored.document.getElementById("toast").textContent, /again to replace/iu);

  restored.document.getElementById("resume-run").dispatch("click");
  await settlePwaActions(4);
  assert.equal(input.value, protectedDraft, "the protected record, never the conflicting DOM value, wins confirmation");
  assert.equal(input.disabled, false);
  assert.equal(store.records.size, 0, "the row is consumed only after owned-thread verification and installation");
  assert.doesNotMatch(restored.window.location.href, /#lazying-update-handoff=/u);
  assert.equal(mutations, 0);
});

test("an exact v3 Agent capability retry cannot capture a conflicting composer as the recovery draft", async () => {
  const threadId = "thr_66666666-6666-4666-8666-666666666666";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Capability-recovered Agent destination",
    instant: "2026-08-25T15:10:00.000Z",
  });
  const protectedDraft = "Keep this exact Agent draft through capability recovery";
  const conflict = "Safari restored stale conflicting text";
  const handoff = await currentV3AgentDraftHandoff({
    draft: protectedDraft,
    threadId,
    search: null,
    createdAt: 65_000,
  });
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let capabilityAvailable = false;
  let capabilityAttempts = 0;
  let exactReads = 0;
  let mutations = 0;
  const agent = {
    async capabilities() {
      capabilityAttempts += 1;
      if (!capabilityAvailable) throw new Error("injected three-probe Agent outage");
      return enabledAgentPwaCapability();
    },
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(requested) {
      assert.equal(requested, threadId);
      exactReads += 1;
      return { schemaVersion: "1", thread };
    },
    async createThread() { mutations += 1; throw new Error("recovery must not create a thread"); },
    async startRun() { mutations += 1; throw new Error("recovery must not start a run"); },
    async resumeRun() { mutations += 1; throw new Error("recovery must not resume a run"); },
    async *streamRunEvents() {},
  };
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 65_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
    wait: async () => {},
  });
  const input = restored.document.getElementById("message-input");
  input.value = conflict;
  await restored.app.initialize();
  assert.equal(capabilityAttempts, 3);
  assert.equal(exactReads, 0);
  assert.equal(input.value, conflict);
  assert.equal(store.records.size, 1);

  capabilityAvailable = true;
  restored.document.getElementById("resume-run").dispatch("click");
  await settlePwaActions();
  assert.equal(capabilityAttempts, 3, "the first Resume only confirms replacement and performs no probe");
  assert.equal(input.value, conflict);
  assert.equal(store.records.size, 1);
  assert.match(restored.document.getElementById("toast").textContent, /again to replace/iu);

  restored.document.getElementById("resume-run").dispatch("click");
  await settlePwaActions(5);
  assert.equal(capabilityAttempts, 4, "the confirmed second Resume retries capability in-page");
  assert.equal(exactReads, 1, "capability recovery verifies the exact owned thread before unlocking");
  assert.equal(input.value, protectedDraft, "the encrypted record remains authoritative across capability retry");
  assert.equal(input.disabled, false);
  assert.equal(store.records.size, 0);
  assert.equal(mutations, 0);
});

test("an exact protected Agent read release mismatch migrates its row without a mutation", async (t) => {
  const capability = enabledAgentPwaCapability();
  const threadId = "thr_77777777-7777-4777-8777-777777777777";
  const runId = "run_77777777-7777-4777-8777-777777777777";
  const instant = "2026-08-25T15:20:00.000Z";
  const baseThread = emptyAgentPwaThread({
    id: threadId,
    title: "Release-fenced Agent destination",
    instant,
  });
  const persistedThread = Object.freeze({
    ...baseThread,
    revision: 2,
    lastRunId: runId,
    messages: Object.freeze([
      Object.freeze({
        id: "msg_release_fence_0001",
        role: "user",
        content: "Create a protected result",
        runId,
        createdAt: instant,
        digest: "1".repeat(64),
      }),
      Object.freeze({
        id: "msg_release_fence_0002",
        role: "assistant",
        content: "Protected result",
        runId,
        createdAt: instant,
        digest: "2".repeat(64),
      }),
    ]),
  });
  const mismatch = () => Object.assign(new Error("exact Agent read requires successor shell"), {
    code: "client_release_mismatch",
    status: 409,
    retryable: false,
    serverRelease: LATER_RELEASE,
  });

  for (const failingRead of ["getThread", "runStatus"]) {
    await t.test(failingRead, async () => {
      const handoff = await currentV3AgentDraftHandoff({
        draft: `Preserve this draft across ${failingRead} release fencing`,
        threadId,
        search: null,
        createdAt: 66_000,
      });
      const store = memoryUpdateHandoffStore([handoff.storageEntry]);
      let mutations = 0;
      let getThreadCalls = 0;
      let runStatusCalls = 0;
      const restored = updateControllerHarness({
        waiting: false,
        environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
        releaseId: NEXT_RELEASE,
        locationHref: handoff.href,
        now: () => 66_001,
        restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
        agent: {
          async capabilities() { return capability; },
          async listThreads() { return { schemaVersion: "1", threads: [persistedThread], nextBefore: null }; },
          async getThread(requested) {
            assert.equal(requested, threadId);
            getThreadCalls += 1;
            if (failingRead === "getThread") throw mismatch();
            return { schemaVersion: "1", thread: persistedThread };
          },
          async runStatus(requested) {
            assert.equal(requested, runId);
            runStatusCalls += 1;
            throw mismatch();
          },
          async createThread() { mutations += 1; throw new Error("must not create while migrating"); },
          async startRun() { mutations += 1; throw new Error("must not run while migrating"); },
          async resumeRun() { mutations += 1; throw new Error("must not resume while migrating"); },
          async *streamRunEvents() { throw new Error("release fencing must happen before event replay"); },
        },
        chat: idleAuthenticatedPwaClients().chat,
        updateHandoffStore: store,
      });
      await restored.app.initialize();

      assert.equal(getThreadCalls, 1);
      assert.equal(runStatusCalls, failingRead === "runStatus" ? 1 : 0);
      assert.equal(mutations, 0);
      assert.equal(restored.replacements.length, 1);
      assert.match(
        restored.replacements[0],
        new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
      );
      assert.equal(store.records.size, 1, "the migrated encrypted row remains available to the successor shell");
      const migrated = [...store.records.values()][0];
      assert.equal(migrated.sourceRelease, NEXT_RELEASE);
      assert.equal(migrated.targetRelease, LATER_RELEASE);
    });
  }
});

test("a legacy v2 existing-Agent choice survives same-account expiry before Search confirmation", async () => {
  const threadId = "thr_88888888-8888-4888-8888-888888888888";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Chosen legacy Agent destination",
    instant: "2026-08-25T15:30:00.000Z",
  });
  const protectedDraft = "Keep this legacy prompt on the explicitly chosen Agent thread";
  const legacy = await legacyV2DraftHandoff({ draft: protectedDraft, createdAt: 67_000 });
  const store = memoryUpdateHandoffStore([legacy.storageEntry]);
  let sessionValid = true;
  let exactReads = 0;
  let mutations = 0;
  const harness = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: legacy.href,
    now: () => 67_001,
    restore: async () => sessionValid
      ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
      : { authenticated: false },
    login: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "second-csrf-token-long-enough",
    }),
    agent: {
      async capabilities() { return enabledAgentPwaCapability(); },
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread(requested) {
        assert.equal(requested, threadId);
        exactReads += 1;
        return { schemaVersion: "1", thread };
      },
      async createThread() { mutations += 1; throw new Error("legacy replay must never create a replacement thread"); },
      async startRun() { mutations += 1; throw new Error("first confirmation must remain read-only"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await harness.app.initialize();
  const chosenThread = [...harness.document.getElementById("thread-list").children]
    .find((entry) => entry.dataset.threadId === threadId);
  assert.ok(chosenThread);
  threadOpenControl(chosenThread).dispatch("click");
  await settlePwaActions();
  assert.equal(exactReads, 1);
  assert.equal(harness.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(harness.document.getElementById("message-input").value, protectedDraft);
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  assert.equal(harness.document.getElementById("send-message").disabled, false);
  assert.equal(store.records.size, 1, "the row remains until Search or No Search is confirmed");

  sessionValid = false;
  harness.window.dispatch("pageshow", { persisted: true });
  await settlePwaActions();
  harness.document.getElementById("username").value = "account-user";
  harness.document.getElementById("password").value = "browser-password";
  harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
  await settlePwaActions(4);

  assert.equal(exactReads, 2, "same-account sign-in replays the previously chosen exact Agent thread");
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(harness.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(harness.document.getElementById("message-input").value, protectedDraft);
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  assert.equal(harness.document.getElementById("send-message").disabled, false);
  const replayedThread = [...harness.document.getElementById("thread-list").children]
    .find((entry) => entry.dataset.threadId === threadId);
  assert.equal(threadOpenControl(replayedThread)?.getAttribute("aria-current"), "true");
  assert.equal(store.records.size, 1);
  assert.equal(mutations, 0);

  await harness.app.submitMessage({ preventDefault() {} });
  assert.equal(mutations, 0, "the first Run after sign-in only confirms No Search");
  assert.equal(harness.document.getElementById("message-input").disabled, false);
  assert.equal(store.records.size, 0);
});

test("an installed exact v3 Agent handoff detects composer or Search divergence before replay consumption", async (t) => {
  const threadId = "thr_99999999-9999-4999-8999-999999999999";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Replay-raced protected Agent destination",
    instant: "2026-08-25T15:40:00.000Z",
  });
  const protectedDraft = "Keep the exact installed prompt until replay settles";

  for (const divergence of ["textarea", "search"]) {
    await t.test(divergence, async () => {
      const handoff = await currentV3AgentDraftHandoff({
        draft: protectedDraft,
        threadId,
        search: { mode: "papers", limit: 6 },
        createdAt: 68_000,
      });
      const store = memoryUpdateHandoffStore([handoff.storageEntry]);
      let beginRead;
      const readStarted = new Promise((resolve) => { beginRead = resolve; });
      let finishRead;
      const readResult = new Promise((resolve) => { finishRead = resolve; });
      let exactReads = 0;
      let mutations = 0;
      const restored = updateControllerHarness({
        waiting: false,
        environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
        releaseId: NEXT_RELEASE,
        locationHref: handoff.href,
        now: () => 68_001,
        restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
        agent: {
          async capabilities() { return enabledAgentPwaCapability(); },
          async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
          async getThread(requested) {
            assert.equal(requested, threadId);
            exactReads += 1;
            if (exactReads === 1) {
              beginRead();
              return await readResult;
            }
            return { schemaVersion: "1", thread };
          },
          async createThread() { mutations += 1; throw new Error("replay recovery must not create"); },
          async startRun() { mutations += 1; throw new Error("replay recovery must not run"); },
          async resumeRun() { mutations += 1; throw new Error("replay recovery must not resume"); },
          async *streamRunEvents() {},
        },
        chat: idleAuthenticatedPwaClients().chat,
        updateHandoffStore: store,
      });
      const input = restored.document.getElementById("message-input");
      const searchMode = restored.document.getElementById("search-mode");
      const searchLimit = restored.document.getElementById("search-limit");
      const initialization = restored.app.initialize();
      await readStarted;
      assert.equal(input.value, protectedDraft, "the protected record is installed before exact ledger replay settles");
      assert.equal(restored.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
      assert.equal(searchMode.value, "papers");
      assert.equal(searchLimit.value, "6");

      if (divergence === "textarea") input.value = "Programmatic textarea divergence during replay";
      else {
        searchMode.value = "web";
        searchLimit.value = "2";
      }
      finishRead({ schemaVersion: "1", thread });
      await initialization;

      assert.equal(store.records.size, 1, `${divergence} divergence must invalidate installation before consumption`);
      assert.match(restored.window.location.href, /#lazying-update-handoff=/u);
      assert.equal(input.disabled, true);
      if (divergence === "textarea") assert.equal(input.value, "Programmatic textarea divergence during replay");
      else {
        assert.equal(input.value, protectedDraft);
        assert.equal(searchMode.value, "web");
        assert.equal(searchLimit.value, "2");
      }

      restored.document.getElementById("resume-run").dispatch("click");
      await settlePwaActions();
      assert.equal(store.records.size, 1, "the first Resume only confirms replacement of the diverged browser state");
      if (divergence === "textarea") assert.equal(input.value, "Programmatic textarea divergence during replay");
      else {
        assert.equal(searchMode.value, "web");
        assert.equal(searchLimit.value, "2");
      }
      assert.match(restored.document.getElementById("toast").textContent, /again to replace/iu);

      restored.document.getElementById("resume-run").dispatch("click");
      await settlePwaActions(4);
      assert.equal(input.value, protectedDraft);
      assert.equal(restored.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
      assert.equal(searchMode.value, "papers");
      assert.equal(searchLimit.value, "6");
      assert.equal(input.disabled, false);
      assert.equal(store.records.size, 0);
      assert.ok(exactReads >= 2, "the confirmed restore re-verifies exact thread ownership before consumption");
      assert.equal(mutations, 0);
    });
  }
});

test("a legacy v2 mode-switch list mismatch migrates one encrypted row and performs one versioned replace", async () => {
  const protectedDraft = "Carry this ambiguous legacy prompt through the required shell update";
  const legacy = await legacyV2DraftHandoff({ draft: protectedDraft, createdAt: 69_000 });
  const store = memoryUpdateHandoffStore([legacy.storageEntry]);
  let listCalls = 0;
  let mutations = 0;
  const mismatch = () => Object.assign(new Error("Agent thread list requires successor shell"), {
    code: "client_release_mismatch",
    status: 409,
    retryable: false,
    serverRelease: LATER_RELEASE,
  });
  const harness = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: legacy.href,
    now: () => 69_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return enabledAgentPwaCapability(); },
      async listThreads() {
        listCalls += 1;
        if (listCalls > 1) throw mismatch();
        return { schemaVersion: "1", threads: [], nextBefore: null };
      },
      async createThread() { mutations += 1; throw new Error("legacy migration must not create"); },
      async startRun() { mutations += 1; throw new Error("legacy migration must not run"); },
      async resumeRun() { mutations += 1; throw new Error("legacy migration must not resume"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await harness.app.initialize();
  assert.equal(listCalls, 1);
  assert.equal(harness.document.getElementById("message-input").value, protectedDraft);
  assert.equal(store.records.size, 1);

  harness.document.getElementById("chat-mode").dispatch("click");
  await settlePwaActions();
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "chat");
  harness.document.getElementById("agent-mode").dispatch("click");
  assert.equal(
    await settlePwaUntil(() => listCalls === 2 && harness.replacements.length === 1),
    true,
    "the bounded release-fence migration did not settle",
  );

  assert.equal(listCalls, 2, "the release fence is raised by the Agent list read after mode switching");
  assert.equal(mutations, 0);
  assert.equal(harness.replacements.length, 1, "one mismatch produces exactly one full versioned navigation");
  assert.match(
    harness.replacements[0],
    new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
  );
  assert.equal(store.records.size, 1);
  const migrated = [...store.records.values()][0];
  assert.equal(migrated.sourceRelease, NEXT_RELEASE);
  assert.equal(migrated.targetRelease, LATER_RELEASE);
  assert.equal(store.calls.discard, 0);
});

test("an uninstalled conflicting handoff refuses release-mismatch navigation and retains its original row", async () => {
  const threadId = "thr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const protectedDraft = "Do not reload until this exact protected prompt owns the composer";
  const conflict = "A conflicting browser-only composer must remain visible";
  const handoff = await currentV3AgentDraftHandoff({
    draft: protectedDraft,
    threadId,
    search: null,
    createdAt: 70_000,
  });
  const originalEnvelope = structuredClone(handoff.storageEntry[1]);
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let mutations = 0;
  const mismatch = Object.assign(new Error("Agent list requires successor shell"), {
    code: "client_release_mismatch",
    status: 409,
    retryable: false,
    serverRelease: LATER_RELEASE,
  });
  const harness = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 70_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return enabledAgentPwaCapability(); },
      async listThreads() { throw mismatch; },
      async createThread() { mutations += 1; throw new Error("unsafe mismatch path must not create"); },
      async startRun() { mutations += 1; throw new Error("unsafe mismatch path must not run"); },
      async resumeRun() { mutations += 1; throw new Error("unsafe mismatch path must not resume"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  const input = harness.document.getElementById("message-input");
  input.value = conflict;
  await harness.app.initialize();

  assert.equal(input.value, conflict);
  assert.equal(input.disabled, true);
  assert.equal(harness.replacements.length, 0, "navigation would lose the conflicting browser-only value");
  assert.equal(store.records.size, 1);
  const retained = [...store.records.values()][0];
  assert.equal(retained.sourceRelease, originalEnvelope.sourceRelease);
  assert.equal(retained.targetRelease, originalEnvelope.targetRelease);
  assert.deepEqual(retained.ciphertext, originalEnvelope.ciphertext);
  assert.equal(store.calls.discard, 0);
  assert.match(harness.window.location.href, /#lazying-update-handoff=/u);
  assert.equal(mutations, 0);
});

test("same-account reauthentication preserves an uninstalled conflict and a pending legacy Search choice", async (t) => {
  await t.test("uninstalled exact-v3 conflict", async () => {
    const threadId = "thr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const thread = emptyAgentPwaThread({
      id: threadId,
      title: "Same-account conflicting recovery",
      instant: "2026-08-25T15:50:00.000Z",
    });
    const protectedDraft = "Protected exact prompt must still await replacement consent";
    const conflict = "Keep this divergent browser composer through sign-in";
    const handoff = await currentV3AgentDraftHandoff({
      draft: protectedDraft,
      threadId,
      search: null,
      createdAt: 71_000,
    });
    const store = memoryUpdateHandoffStore([handoff.storageEntry]);
    let sessionValid = true;
    let exactReads = 0;
    let mutations = 0;
    const harness = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      locationHref: handoff.href,
      now: () => 71_001,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => ({
        authenticated: true,
        username: "account-user",
        csrfToken: "second-csrf-token-long-enough",
      }),
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread(requested) {
          assert.equal(requested, threadId);
          exactReads += 1;
          return { schemaVersion: "1", thread };
        },
        async createThread() { mutations += 1; throw new Error("reauth recovery must not create"); },
        async startRun() { mutations += 1; throw new Error("reauth recovery must not run"); },
        async *streamRunEvents() {},
      },
      chat: idleAuthenticatedPwaClients().chat,
      updateHandoffStore: store,
    });
    const input = harness.document.getElementById("message-input");
    input.value = conflict;
    await harness.app.initialize();
    assert.equal(exactReads, 1);
    assert.equal(input.value, conflict);
    assert.equal(store.records.size, 1);

    sessionValid = false;
    harness.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    harness.document.getElementById("username").value = "account-user";
    harness.document.getElementById("password").value = "browser-password";
    harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
    await settlePwaActions(4);

    assert.equal(exactReads, 2);
    assert.equal(input.value, conflict, "same-account reauth cannot silently install over an unconfirmed conflict");
    assert.equal(input.disabled, true);
    assert.equal(store.records.size, 1);
    assert.match(harness.window.location.href, /#lazying-update-handoff=/u);
    assert.equal(mutations, 0);
  });

  await t.test("legacy chosen Search", async () => {
    const threadId = "thr_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const thread = emptyAgentPwaThread({
      id: threadId,
      title: "Legacy Search destination",
      instant: "2026-08-25T16:00:00.000Z",
    });
    const protectedDraft = "Preserve this explicitly chosen legacy papers Search";
    const legacy = await legacyV2DraftHandoff({ draft: protectedDraft, createdAt: 72_000 });
    const store = memoryUpdateHandoffStore([legacy.storageEntry]);
    let sessionValid = true;
    let exactReads = 0;
    let mutations = 0;
    const harness = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      locationHref: legacy.href,
      now: () => 72_001,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => ({
        authenticated: true,
        username: "account-user",
        csrfToken: "second-csrf-token-long-enough",
      }),
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread(requested) {
          assert.equal(requested, threadId);
          exactReads += 1;
          return { schemaVersion: "1", thread };
        },
        async createThread() { mutations += 1; throw new Error("chosen Search recovery must not create"); },
        async startRun() { mutations += 1; throw new Error("Search confirmation must not run"); },
        async *streamRunEvents() {},
      },
      chat: idleAuthenticatedPwaClients().chat,
      updateHandoffStore: store,
    });
    await harness.app.initialize();
    const chosenThread = [...harness.document.getElementById("thread-list").children]
      .find((entry) => entry.dataset.threadId === threadId);
    assert.ok(chosenThread);
    threadOpenControl(chosenThread).dispatch("click");
    await settlePwaActions();
    assert.equal(exactReads, 1);
    assert.equal(store.records.size, 1, "the chosen destination still awaits an explicit Search choice");
    harness.document.getElementById("search-mode").value = "papers";
    harness.document.getElementById("search-limit").value = "6";
    harness.document.getElementById("search-toggle").dispatch("click");
    assert.equal(harness.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(store.records.size, 0, "choosing Search resolves the legacy handoff before authentication expires");

    sessionValid = false;
    harness.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    harness.document.getElementById("username").value = "account-user";
    harness.document.getElementById("password").value = "browser-password";
    harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
    await settlePwaActions(4);

    assert.equal(exactReads, 2);
    assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
    assert.equal(harness.document.getElementById("conversation-title").textContent, thread.title);
    assert.equal(harness.document.getElementById("message-input").value, protectedDraft);
    assert.equal(harness.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(harness.document.getElementById("search-mode").value, "papers");
    assert.equal(harness.document.getElementById("search-limit").value, "6");
    assert.equal(harness.document.getElementById("message-input").disabled, false);
    assert.equal(harness.document.getElementById("send-message").disabled, false);
    assert.equal(store.records.size, 0);
    assert.equal(mutations, 0);
  });
});

test("memory-only same-account Agent and Chat recovery survive post-login release fencing", async (t) => {
  await t.test("Agent exact-thread hydration while login is busy", async () => {
    const threadId = "thr_dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const thread = emptyAgentPwaThread({
      id: threadId,
      title: "Memory-only Agent release recovery",
      instant: "2026-08-25T16:10:00.000Z",
    });
    const draft = "Carry this memory-only Agent draft to the required release";
    const store = memoryUpdateHandoffStore();
    let sessionValid = true;
    let fenceAfterLogin = false;
    let exactReads = 0;
    let mutations = 0;
    const mismatch = () => Object.assign(new Error("exact Agent hydration requires successor shell"), {
      code: "client_release_mismatch",
      status: 409,
      retryable: false,
      serverRelease: LATER_RELEASE,
    });
    const source = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      now: () => 73_000,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => ({
        authenticated: true,
        username: "account-user",
        csrfToken: "second-csrf-token-long-enough",
      }),
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread(requested) {
          assert.equal(requested, threadId);
          exactReads += 1;
          if (fenceAfterLogin) throw mismatch();
          return { schemaVersion: "1", thread };
        },
        async createThread() { mutations += 1; throw new Error("release recovery must not create"); },
        async startRun() { mutations += 1; throw new Error("release recovery must not run"); },
        async resumeRun() { mutations += 1; throw new Error("release recovery must not resume"); },
        async *streamRunEvents() {},
      },
      chat: idleAuthenticatedPwaClients().chat,
      updateHandoffStore: store,
    });
    await source.app.initialize();
    assert.equal(exactReads, 1);
    source.document.getElementById("search-toggle").dispatch("click");
    source.document.getElementById("search-mode").value = "papers";
    source.document.getElementById("search-limit").value = "6";
    source.document.getElementById("message-input").value = draft;
    sessionValid = false;
    source.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    fenceAfterLogin = true;
    source.document.getElementById("username").value = "account-user";
    source.document.getElementById("password").value = "browser-password";
    await source.app.login({ preventDefault() {} });

    assert.equal(exactReads, 2);
    assert.equal(mutations, 0);
    assert.equal(source.replacements.length, 1,
      `the busy login path defers one safe navigation until staging finishes; toast=${source.document.getElementById("toast").textContent}; mode=${source.document.getElementById("workspace").dataset.mode}; records=${store.records.size}`);
    assert.match(
      source.replacements[0],
      new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
    );
    assert.equal(store.records.size, 1);

    fenceAfterLogin = false;
    const successor = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
      releaseId: LATER_RELEASE,
      locationHref: source.replacements[0],
      now: () => 73_001,
      restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "third-csrf-token-long-enough" }),
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread() { return { schemaVersion: "1", thread }; },
        async createThread() { mutations += 1; throw new Error("successor restore must not create"); },
        async startRun() { mutations += 1; throw new Error("successor restore must not run"); },
        async *streamRunEvents() {},
      },
      chat: idleAuthenticatedPwaClients().chat,
      updateHandoffStore: store,
    });
    await successor.app.initialize();
    assert.equal(successor.document.getElementById("workspace").dataset.mode, "agent");
    assert.equal(successor.document.getElementById("conversation-title").textContent, thread.title);
    assert.equal(successor.document.getElementById("message-input").value, draft);
    assert.equal(successor.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(successor.document.getElementById("search-mode").value, "papers");
    assert.equal(successor.document.getElementById("search-limit").value, "6");
    assert.equal(store.records.size, 0);
    assert.equal(mutations, 0);
  });

  await t.test("Chat list hydration while login is busy", async () => {
    const draft = "Carry this memory-only Direct Chat draft to the required release";
    const store = memoryUpdateHandoffStore();
    const idle = idleAuthenticatedPwaClients();
    let sessionValid = true;
    let fenceAfterLogin = false;
    let listCalls = 0;
    const mismatch = () => Object.assign(new Error("Chat hydration requires successor shell"), {
      code: "client_release_mismatch",
      status: 409,
      retryable: false,
      serverRelease: LATER_RELEASE,
    });
    const chat = {
      ...idle.chat,
      async listThreads() {
        listCalls += 1;
        if (fenceAfterLogin) throw mismatch();
        return { threads: [] };
      },
    };
    const source = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      now: () => 74_000,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => ({
        authenticated: true,
        username: "account-user",
        csrfToken: "second-csrf-token-long-enough",
      }),
      agent: idle.agent,
      chat,
      updateHandoffStore: store,
    });
    await source.app.initialize();
    assert.equal(source.document.getElementById("workspace").dataset.mode, "chat");
    source.document.getElementById("message-input").value = draft;
    sessionValid = false;
    source.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    fenceAfterLogin = true;
    source.document.getElementById("username").value = "account-user";
    source.document.getElementById("password").value = "browser-password";
    await source.app.login({ preventDefault() {} });

    assert.ok(listCalls >= 2);
    assert.deepEqual(idle.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
    assert.equal(source.replacements.length, 1,
      `Chat recovery must stage after login hydration fencing; toast=${source.document.getElementById("toast").textContent}; mode=${source.document.getElementById("workspace").dataset.mode}; records=${store.records.size}`);
    assert.match(
      source.replacements[0],
      new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
    );
    assert.equal(store.records.size, 1);

    const successorIdle = idleAuthenticatedPwaClients();
    const successor = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
      releaseId: LATER_RELEASE,
      locationHref: source.replacements[0],
      now: () => 74_001,
      restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "third-csrf-token-long-enough" }),
      agent: successorIdle.agent,
      chat: successorIdle.chat,
      updateHandoffStore: store,
    });
    await successor.app.initialize();
    assert.equal(successor.document.getElementById("workspace").dataset.mode, "chat");
    assert.equal(successor.document.getElementById("message-input").value, draft);
    assert.equal(successor.document.getElementById("message-input").disabled, false);
    assert.equal(store.records.size, 0);
    assert.deepEqual(successorIdle.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
  });

  await t.test("Chat list mismatch after login clears", async () => {
    const draft = "Keep this Chat draft when the post-login mode switch discovers a newer shell";
    const store = memoryUpdateHandoffStore();
    const idle = idleAuthenticatedPwaClients();
    let sessionValid = true;
    let fenceList = false;
    let listCalls = 0;
    const chat = {
      ...idle.chat,
      async listThreads() {
        listCalls += 1;
        if (fenceList) {
          throw Object.assign(new Error("post-login Chat list requires successor shell"), {
            code: "client_release_mismatch",
            status: 409,
            retryable: false,
            serverRelease: LATER_RELEASE,
          });
        }
        return { threads: [] };
      },
    };
    const source = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      now: () => 74_500,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => ({
        authenticated: true,
        username: "account-user",
        csrfToken: "second-csrf-token-long-enough",
      }),
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
        async *streamRunEvents() {},
      },
      chat,
      updateHandoffStore: store,
    });
    await source.app.initialize();
    source.document.getElementById("chat-mode").dispatch("click");
    await settlePwaActions();
    source.document.getElementById("message-input").value = draft;
    sessionValid = false;
    source.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    source.document.getElementById("username").value = "account-user";
    source.document.getElementById("password").value = "browser-password";
    source.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
    await settlePwaActions(4);
    assert.equal(source.replacements.length, 0);
    assert.equal(source.document.getElementById("workspace").dataset.mode, "chat");
    assert.equal(source.document.getElementById("message-input").value, draft);

    fenceList = true;
    source.document.getElementById("agent-mode").dispatch("click");
    await settlePwaActions();
    source.document.getElementById("chat-mode").dispatch("click");
    await settlePwaUntil(() => source.replacements.length > 0);
    assert.ok(listCalls >= 3);
    assert.equal(source.replacements.length, 1, "a mismatch after login clears stages and navigates exactly once");
    assert.match(
      source.replacements[0],
      new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
    );
    assert.equal(store.records.size, 1);
    assert.deepEqual(idle.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
  });
});

test("a signed-out retained encrypted row crosses login release fencing through an opaque authenticated chain hop", async () => {
  const threadId = "thr_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Opaque signed-out successor recovery",
    instant: "2026-08-25T16:20:00.000Z",
  });
  const draft = "Decrypt this protected prompt only after successor authentication";
  const handoff = await currentV3AgentDraftHandoff({
    draft,
    threadId,
    search: null,
    createdAt: 75_000,
  });
  const originalEnvelope = structuredClone(handoff.storageEntry[1]);
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let sessionValid = true;
  let loginCalls = 0;
  let mutations = 0;
  const unavailableAgent = idleAuthenticatedPwaClients().agent;
  const source = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 75_001,
    restore: async () => sessionValid
      ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
      : { authenticated: false },
    login: async () => {
      loginCalls += 1;
      throw Object.assign(new Error("login requires successor shell"), {
        code: "client_release_mismatch",
        status: 409,
        retryable: false,
        serverRelease: LATER_RELEASE,
      });
    },
    agent: unavailableAgent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await source.app.initialize();
  assert.equal(store.calls.take, 1, "the authenticated destination opened and durably re-retained the exact row");
  assert.equal(store.records.size, 1);
  assert.equal(source.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(source.document.getElementById("message-input").value, draft);
  assert.equal(source.document.getElementById("message-input").disabled, true);
  sessionValid = false;
  source.window.dispatch("pageshow", { persisted: true });
  await settlePwaActions();
  assert.equal(source.document.getElementById("login-view").hidden, false);
  source.document.getElementById("username").value = "account-user";
  source.document.getElementById("password").value = "browser-password";
  await source.app.login({ preventDefault() {} });

  assert.equal(loginCalls, 1);
  assert.equal(store.calls.take, 1, "the signed-out stale shell never decrypts the retained row a second time");
  assert.equal(store.records.size, 1);
  assert.deepEqual([...store.records.values()][0].ciphertext, originalEnvelope.ciphertext);
  assert.equal(source.replacements.length, 1);
  assert.match(
    source.replacements[0],
    new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=[a-f0-9]{64}\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$`, "u"),
  );

  const successor = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
    releaseId: LATER_RELEASE,
    locationHref: source.replacements[0],
    now: () => 75_002,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "successor-csrf-token-long-enough" }),
    agent: {
      async capabilities() { return enabledAgentPwaCapability(); },
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { schemaVersion: "1", thread }; },
      async createThread() { mutations += 1; throw new Error("opaque restore must not create"); },
      async startRun() { mutations += 1; throw new Error("opaque restore must not run"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await successor.app.initialize();
  assert.equal(successor.document.getElementById("message-input").value, draft);
  assert.equal(successor.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(store.records.size, 0);
  assert.equal(mutations, 0);
});

test("a signed-out Search-on Agent row ignores auth control reset but still rejects unrelated browser work", async (t) => {
  const threadId = "thr_12121212-1212-4212-8212-121212121212";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Signed-out Search recovery",
    instant: "2026-08-25T16:25:00.000Z",
  });
  const draft = "Carry this exact Search-on Agent prompt through the signed-out update";
  const search = Object.freeze({ mode: "papers", limit: 6 });

  const retainedSearchSource = async ({ createdAt }) => {
    const handoff = await currentV3AgentDraftHandoff({ draft, threadId, search, createdAt });
    const originalEnvelope = structuredClone(handoff.storageEntry[1]);
    const store = memoryUpdateHandoffStore([handoff.storageEntry]);
    let sessionValid = true;
    let loginCalls = 0;
    let exactReads = 0;
    let mutations = 0;
    const source = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      locationHref: handoff.href,
      now: () => createdAt + 1,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => {
        loginCalls += 1;
        throw Object.assign(new Error("login requires the Search-capable successor shell"), {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: LATER_RELEASE,
        });
      },
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread() {
          exactReads += 1;
          throw new Error("retain the installed record until its exact ledger can be verified");
        },
        async createThread() { mutations += 1; throw new Error("recovery must not create"); },
        async startRun() { mutations += 1; throw new Error("recovery must not run"); },
        async resumeRun() { mutations += 1; throw new Error("recovery must not resume"); },
        async *streamRunEvents() {},
      },
      chat: idleAuthenticatedPwaClients().chat,
      updateHandoffStore: store,
    });
    await source.app.initialize();
    assert.equal(exactReads, 1);
    assert.equal(store.calls.take, 1);
    assert.equal(store.records.size, 1);
    assert.equal(source.document.getElementById("workspace").dataset.mode, "agent");
    assert.equal(source.document.getElementById("message-input").value, draft);
    assert.equal(source.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(source.document.getElementById("search-mode").value, "papers");
    assert.equal(source.document.getElementById("search-limit").value, "6");

    sessionValid = false;
    source.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    assert.equal(source.document.getElementById("login-view").hidden, false);
    // Authentication reset intentionally owns Chat/Search-off internally. Make
    // the hidden control state observable without introducing a user change.
    source.app.setMode("chat");
    assert.equal(source.document.getElementById("workspace").dataset.mode, "chat");
    assert.equal(source.document.getElementById("search-toggle").getAttribute("aria-pressed"), "false");
    return {
      source,
      store,
      originalEnvelope,
      get loginCalls() { return loginCalls; },
      get mutations() { return mutations; },
    };
  };

  await t.test("the reset Chat/Search-off controls do not compete with the encrypted Agent owner", async () => {
    const recovery = await retainedSearchSource({ createdAt: 75_100 });
    recovery.source.document.getElementById("username").value = "account-user";
    recovery.source.document.getElementById("password").value = "browser-password";
    await recovery.source.app.login({ preventDefault() {} });

    assert.equal(recovery.loginCalls, 1);
    assert.equal(recovery.mutations, 0);
    assert.equal(recovery.store.calls.take, 1, "the stale signed-out shell never decrypts twice");
    assert.equal(recovery.store.records.size, 1);
    assert.deepEqual([...recovery.store.records.values()][0].ciphertext, recovery.originalEnvelope.ciphertext);
    assert.equal(recovery.source.replacements.length, 1, "the opaque row chains exactly once");
    assert.match(
      recovery.source.replacements[0],
      new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=[a-f0-9]{64}\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$`, "u"),
    );

    let successorMutations = 0;
    const successor = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
      releaseId: LATER_RELEASE,
      locationHref: recovery.source.replacements[0],
      now: () => 75_102,
      restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "successor-csrf-token-long-enough" }),
      agent: {
        async capabilities() { return enabledAgentPwaCapability(); },
        async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
        async getThread() { return { schemaVersion: "1", thread }; },
        async createThread() { successorMutations += 1; throw new Error("successor restore must not create"); },
        async startRun() { successorMutations += 1; throw new Error("successor restore must not run"); },
        async resumeRun() { successorMutations += 1; throw new Error("successor restore must not resume"); },
        async *streamRunEvents() {},
      },
      chat: idleAuthenticatedPwaClients().chat,
      updateHandoffStore: recovery.store,
    });
    await successor.app.initialize();
    assert.equal(successor.document.getElementById("workspace").dataset.mode, "agent");
    assert.equal(successor.document.getElementById("conversation-title").textContent, thread.title);
    assert.equal(successor.document.getElementById("message-input").value, draft);
    assert.equal(successor.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(successor.document.getElementById("search-mode").value, "papers");
    assert.equal(successor.document.getElementById("search-limit").value, "6");
    assert.equal(successor.replacements.length, 0);
    assert.equal(recovery.store.calls.take, 2);
    assert.equal(recovery.store.records.size, 0);
    assert.equal(successorMutations, 0);
  });

  await t.test("a genuinely different signed-out draft still blocks the opaque hop", async () => {
    const recovery = await retainedSearchSource({ createdAt: 75_200 });
    const conflict = "Safari restored a genuinely different unsent prompt";
    recovery.source.document.getElementById("message-input").value = conflict;
    recovery.source.document.getElementById("username").value = "account-user";
    recovery.source.document.getElementById("password").value = "browser-password";
    await recovery.source.app.login({ preventDefault() {} });

    assert.equal(recovery.loginCalls, 1);
    assert.equal(recovery.mutations, 0);
    assert.equal(recovery.source.replacements.length, 0);
    assert.equal(recovery.source.document.getElementById("message-input").value, conflict);
    assert.equal(recovery.store.calls.take, 1);
    assert.equal(recovery.store.records.size, 1);
    assert.deepEqual([...recovery.store.records.values()][0].ciphertext, recovery.originalEnvelope.ciphertext);
    assert.match(recovery.source.document.getElementById("login-error").textContent, /different browser-restored draft/u);
  });

  await t.test("an unrelated selected image still blocks the opaque hop", async () => {
    const chatThreadId = "chat_signed_out_image_conflict_xxxx";
    const chatDraft = "Keep this exact retained Chat prompt separate from a restored image";
    const handoff = await currentV3AgentDraftHandoff({
      draft: chatDraft,
      threadId: chatThreadId,
      search: null,
      mode: "chat",
      createdAt: 75_300,
    });
    const originalEnvelope = structuredClone(handoff.storageEntry[1]);
    const store = memoryUpdateHandoffStore([handoff.storageEntry]);
    const idle = idleAuthenticatedPwaClients();
    const chatThread = Object.freeze({
      threadId: chatThreadId,
      title: "Signed-out image conflict",
      modelAlias: "local-default",
      revision: 0,
      ledgerHash: null,
      messageCount: 0,
      ledgerBytes: 0,
      currentGenerationId: null,
      createdAt: "2026-08-25T16:26:00.000Z",
      updatedAt: "2026-08-25T16:26:00.000Z",
    });
    const bytes = canonicalPngHeader();
    let sessionValid = true;
    let loginCalls = 0;
    const source = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      locationHref: handoff.href,
      now: () => 75_301,
      restore: async () => sessionValid
        ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
        : { authenticated: false },
      login: async () => {
        loginCalls += 1;
        throw Object.assign(new Error("login requires the successor shell"), {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: LATER_RELEASE,
        });
      },
      agent: idle.agent,
      chat: {
        ...idle.chat,
        async listThreads() { return { threads: [chatThread] }; },
        async getThread() { throw new Error("retain the installed Chat record for explicit verification"); },
      },
      updateHandoffStore: store,
      async canonicalizeImage() {
        return Object.freeze({
          attachmentId: "image_signed_out_unrelated_0001",
          mediaType: "image/png",
          byteLength: bytes.byteLength,
          width: 64,
          height: 64,
          bytes,
          previewBlob: new Blob([bytes], { type: "image/png" }),
        });
      },
      createObjectUrl: () => "blob:signed-out-unrelated-image",
      revokeObjectUrl() {},
    });
    await source.app.initialize();
    assert.equal(source.document.getElementById("workspace").dataset.mode, "chat");
    assert.equal(source.document.getElementById("message-input").value, chatDraft);
    assert.equal(store.records.size, 1);

    const imageInput = source.document.getElementById("image-input");
    imageInput.files = [{ name: "unrelated.png" }];
    imageInput.dispatch("change");
    await settlePwaActions(4);
    assert.equal(source.document.getElementById("image-preview").hidden, false);
    sessionValid = false;
    source.window.dispatch("pageshow", { persisted: true });
    await settlePwaActions();
    assert.equal(source.document.getElementById("login-view").hidden, false);
    assert.equal(source.document.getElementById("image-preview").hidden, false);
    source.document.getElementById("username").value = "account-user";
    source.document.getElementById("password").value = "browser-password";
    await source.app.login({ preventDefault() {} });

    assert.equal(loginCalls, 1);
    assert.equal(source.replacements.length, 0);
    assert.equal(store.calls.take, 1);
    assert.equal(store.records.size, 1);
    assert.deepEqual([...store.records.values()][0].ciphertext, originalEnvelope.ciphertext);
    assert.equal(source.document.getElementById("image-preview").hidden, false);
    assert.deepEqual(idle.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
  });
});

test("a pre-showApp capability release fence exposes Resume for a conflicting protected composer", async () => {
  const threadId = "thr_ffffffff-ffff-4fff-8fff-ffffffffffff";
  const protectedDraft = "Keep the protected prompt behind an explicit replacement action";
  const conflict = "Safari restored different browser-only work before hydration";
  const handoff = await currentV3AgentDraftHandoff({
    draft: protectedDraft,
    threadId,
    search: null,
    createdAt: 76_000,
  });
  const store = memoryUpdateHandoffStore([handoff.storageEntry]);
  let mutations = 0;
  const harness = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: handoff.href,
    now: () => 76_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() {
        throw Object.assign(new Error("capability endpoint requires successor shell"), {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: LATER_RELEASE,
        });
      },
      async listThreads() { throw new Error("capability fence must happen before Agent listing"); },
      async createThread() { mutations += 1; throw new Error("capability recovery must not create"); },
      async startRun() { mutations += 1; throw new Error("capability recovery must not run"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  const input = harness.document.getElementById("message-input");
  input.value = conflict;
  await harness.app.initialize();

  assert.equal(harness.replacements.length, 0);
  assert.equal(store.records.size, 1);
  assert.equal(input.value, conflict);
  assert.equal(harness.document.getElementById("login-view").hidden, true);
  assert.equal(harness.document.getElementById("app-view").hidden, false, "authenticated protected work must expose its recovery UI");
  assert.equal(harness.document.getElementById("resume-run").hidden, false);
  assert.equal(harness.document.getElementById("resume-run").disabled, false);
  harness.document.getElementById("resume-run").dispatch("click");
  await settlePwaActions();
  assert.equal(input.value, conflict);
  assert.equal(store.records.size, 1);
  assert.match(harness.document.getElementById("toast").textContent, /again to replace/iu);
  assert.equal(mutations, 0);
});

test("New conversation consumes one exact Search-on Agent recovery without a detach loop", async (t) => {
  const threadId = "thr_10101010-1010-4010-8010-101010101010";
  const thread = emptyAgentPwaThread({
    id: threadId,
    title: "Search-on detach source",
    instant: "2026-08-25T16:30:00.000Z",
  });
  const protectedDraft = "Detach this exact Search-on prompt to one new Agent conversation";

  for (const variant of ["replay-failure", "stale-install"]) {
    await t.test(variant, async () => {
      const handoff = await currentV3AgentDraftHandoff({
        draft: protectedDraft,
        threadId,
        search: { mode: "papers", limit: 6 },
        createdAt: 77_000,
      });
      const store = memoryUpdateHandoffStore([handoff.storageEntry]);
      let mutations = 0;
      let beginRead;
      const readStarted = new Promise((resolve) => { beginRead = resolve; });
      let finishRead;
      const readResult = new Promise((resolve) => { finishRead = resolve; });
      const restored = updateControllerHarness({
        waiting: false,
        environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
        releaseId: NEXT_RELEASE,
        locationHref: handoff.href,
        now: () => 77_001,
        restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
        agent: {
          async capabilities() { return enabledAgentPwaCapability(); },
          async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
          async getThread() {
            if (variant === "replay-failure") throw new Error("injected exact replay outage");
            beginRead();
            return await readResult;
          },
          async createThread() { mutations += 1; throw new Error("detach must not create eagerly"); },
          async startRun() { mutations += 1; throw new Error("detach must not run"); },
          async resumeRun() { mutations += 1; throw new Error("detach must not resume"); },
          async *streamRunEvents() {},
        },
        chat: idleAuthenticatedPwaClients().chat,
        updateHandoffStore: store,
      });
      let initialization;
      if (variant === "stale-install") {
        initialization = restored.app.initialize();
        await readStarted;
        restored.document.getElementById("search-mode").value = "web";
        restored.document.getElementById("search-limit").value = "2";
        finishRead({ schemaVersion: "1", thread });
        await initialization;
      } else await restored.app.initialize();

      assert.equal(store.records.size, 1);
      assert.equal(restored.document.getElementById("message-input").value, protectedDraft);
      const newConversation = restored.document.getElementById("new-thread");
      assert.equal(newConversation.disabled, false);
      newConversation.dispatch("click");
      await settlePwaActions();
      if (variant === "stale-install") {
        assert.equal(store.records.size, 1, "the first detach click only confirms replacement of stale Search state");
        assert.equal(restored.document.getElementById("search-mode").value, "web");
        assert.match(restored.document.getElementById("toast").textContent, /again to replace/iu);
        newConversation.dispatch("click");
        await settlePwaActions();
      }

      assert.equal(store.records.size, 0);
      assert.equal(store.calls.discard, 1, "the retained row is consumed exactly once");
      assert.doesNotMatch(restored.window.location.href, /#lazying-update-handoff=/u);
      assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
      assert.equal(restored.document.getElementById("conversation-title").textContent, "New conversation");
      assert.equal(restored.document.getElementById("message-input").value, protectedDraft);
      assert.equal(restored.document.getElementById("message-input").disabled, false);
      assert.equal(restored.document.getElementById("search-toggle").getAttribute("aria-pressed"), "false");
      assert.equal(mutations, 0);

      newConversation.dispatch("click");
      await settlePwaActions();
      assert.equal(store.calls.discard, 1, "a second ordinary New conversation cannot re-enter detach recovery");
      assert.equal(store.records.size, 0);
      assert.equal(mutations, 0);
    });
  }
});

test("a conflicting browser-restored composer needs a second explicit action before protected replacement", async () => {
  const staged = await stageEncryptedTextUpdateHandoff();
  for (const action of ["resume-run", "new-thread"]) {
    const store = memoryUpdateHandoffStore([staged.record]);
    const clients = idleAuthenticatedPwaClients();
    const restored = updateControllerHarness({
      waiting: false,
      environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
      releaseId: NEXT_RELEASE,
      locationHref: staged.href,
      now: () => 20_001,
      restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
      agent: clients.agent,
      chat: clients.chat,
      updateHandoffStore: store,
    });
    const input = restored.document.getElementById("message-input");
    input.value = "Safari restored a different local draft";
    await restored.app.initialize();
    assert.equal(input.value, "Safari restored a different local draft");
    assert.equal(input.disabled, true);
    restored.document.getElementById(action).dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(input.value, "Safari restored a different local draft",
      "the first action only asks for explicit replacement confirmation");
    assert.equal(store.records.size, 1);
    assert.match(restored.document.getElementById("toast").textContent, /again to replace/iu);
    restored.document.getElementById(action).dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(input.value, "private handoff draft");
    assert.equal(input.disabled, false);
    assert.equal(store.records.size, 0);
    assert.deepEqual(clients.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
  }
});

test("an ambiguous v2 draft remains assignable to Chat when Agent capability is unavailable", async () => {
  const legacy = await legacyV2DraftHandoff({ draft: "Preserve this one-time rollout draft" });
  const store = memoryUpdateHandoffStore([legacy.storageEntry]);
  let capabilityAttempts = 0;
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: legacy.href,
    now: () => 50_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { capabilityAttempts += 1; throw new Error("injected Agent outage"); },
      async listThreads() { throw new Error("Agent list must not run"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
    wait: async () => {},
  });
  await restored.app.initialize();
  assert.equal(capabilityAttempts, 3);
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(restored.document.getElementById("message-input").value, "Preserve this one-time rollout draft");
  assert.equal(restored.document.getElementById("message-input").disabled, true);
  assert.equal(store.records.size, 1);
  restored.document.getElementById("new-thread").dispatch("click");
  assert.equal(restored.document.getElementById("message-input").disabled, false);
  assert.equal(restored.document.getElementById("send-message").disabled, false);
  assert.equal(store.records.size, 0);
});

test("a transient post-update Agent capability outage retains the v3 draft and disables dispatch", async () => {
  const capability = {
    schemaVersion: "1",
    enabled: true,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: true, resume: true, retry: false },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
  };
  let sourceMutations = 0;
  const sourceAgent = {
    async capabilities() { return capability; },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async createThread() { sourceMutations += 1; throw new Error("must not create during update staging"); },
    async startRun() { sourceMutations += 1; throw new Error("must not run during update staging"); },
    async *streamRunEvents() {},
  };
  const store = memoryUpdateHandoffStore();
  const environment = updateEnvironment();
  const source = updateControllerHarness({
    environment,
    now: () => 60_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: sourceAgent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await source.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  source.document.getElementById("message-input").value = "Keep this Agent draft through a capability outage";
  source.document.getElementById("apply-update").dispatch("click");
  await store.saved;
  await new Promise((resolve) => setImmediate(resolve));
  environment.registration.waiting = null;
  environment.transitionController(NEXT_RELEASE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.replacements.length, 1);

  let capabilityAttempts = 0;
  let restoredMutations = 0;
  const unavailableAgent = {
    async capabilities() { capabilityAttempts += 1; throw new Error("injected Agent capability outage"); },
    async listThreads() { throw new Error("Agent list must stay fenced"); },
    async createThread() { restoredMutations += 1; throw new Error("must not create while fenced"); },
    async startRun() { restoredMutations += 1; throw new Error("must not run while fenced"); },
    async *streamRunEvents() {},
  };
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 60_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: unavailableAgent,
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
    wait: async () => {},
  });
  assert.equal(restored.historyReplacements.length, 0, "the key remains reload-safe before authenticated decryption");
  await restored.app.initialize();
  assert.equal(capabilityAttempts, 3);
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(
    restored.document.getElementById("message-input").value,
    "Keep this Agent draft through a capability outage",
  );
  assert.equal(restored.document.getElementById("message-input").disabled, true,
    "the visible draft cannot diverge from the retained encrypted recovery row");
  assert.equal(restored.document.getElementById("send-message").disabled, true);
  assert.match(restored.document.getElementById("toast").textContent, /remains protected/iu);
  assert.equal(store.records.size, 1, "the encrypted row is restored until a later verified Agent startup consumes it");
  assert.equal(restored.historyReplacements.length, 0);
  assert.match(restored.window.location.href, /#lazying-update-handoff=/u);
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(restoredMutations, 0);
  assert.equal(sourceMutations, 0);
});

test("a pre-consumption release mismatch migrates the encrypted handoff to the exact newer release", async () => {
  const staged = await stageEncryptedTextUpdateHandoff();
  const store = memoryUpdateHandoffStore([staged.record]);
  const idle = idleAuthenticatedPwaClients();
  const stale = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: staged.href,
    now: () => 20_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      ...idle.agent,
      async capabilities() {
        throw Object.assign(new Error("stale handoff destination release"), {
          code: "client_release_mismatch",
          status: 409,
          retryable: false,
          serverRelease: LATER_RELEASE,
        });
      },
    },
    chat: idle.chat,
    updateHandoffStore: store,
  });
  await stale.app.initialize();
  assert.equal(stale.replacements.length, 1);
  assert.match(
    stale.replacements[0],
    new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
  );
  const migrated = [...store.records.values()][0];
  assert.equal(migrated.sourceRelease, NEXT_RELEASE);
  assert.equal(migrated.targetRelease, LATER_RELEASE);

  const recovered = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
    releaseId: LATER_RELEASE,
    locationHref: stale.replacements[0],
    now: () => 20_002,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idle.agent,
    chat: idle.chat,
    updateHandoffStore: store,
  });
  await recovered.app.initialize();
  assert.equal(recovered.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(recovered.document.getElementById("message-input").value, "private handoff draft");
  assert.equal(recovered.document.getElementById("message-input").disabled, false);
  assert.equal(store.records.size, 0);
});

test("a session-restore release fence carries an unread handoff to the successor before account-bound decryption", async () => {
  const staged = await stageEncryptedTextUpdateHandoff();
  const store = memoryUpdateHandoffStore([staged.record]);
  const stale = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: staged.href,
    now: () => 20_001,
    restore: async () => {
      throw Object.assign(new Error("session endpoint requires the successor shell"), {
        code: "client_release_mismatch",
        status: 409,
        retryable: false,
        serverRelease: LATER_RELEASE,
      });
    },
    updateHandoffStore: store,
  });
  await stale.app.initialize();
  assert.equal(store.calls.take, 0, "no plaintext is opened before the account session is authenticated");
  assert.equal(store.records.size, 1);
  assert.equal(stale.replacements.length, 1);
  assert.match(
    stale.replacements[0],
    new RegExp(`^https://llm\\.lazying\\.art/\\?v=${LATER_RELEASE}#lazying-update-handoff=`, "u"),
  );

  const idle = idleAuthenticatedPwaClients();
  const recovered = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
    releaseId: LATER_RELEASE,
    locationHref: stale.replacements[0],
    now: () => 20_002,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idle.agent,
    chat: idle.chat,
    updateHandoffStore: store,
  });
  await recovered.app.initialize();
  assert.equal(recovered.document.getElementById("message-input").value, "private handoff draft");
  assert.equal(recovered.document.getElementById("message-input").disabled, false);
  assert.equal(store.records.size, 0);
});

test("an authentic encrypted handoff for another target release is rejected without a chained-hop proof", async () => {
  const staged = await stageEncryptedTextUpdateHandoff();
  const store = memoryUpdateHandoffStore([staged.record]);
  const idle = idleAuthenticatedPwaClients();
  const foreignTarget = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: LATER_RELEASE }),
    releaseId: LATER_RELEASE,
    locationHref: staged.href.replace(`?v=${NEXT_RELEASE}`, `?v=${LATER_RELEASE}`),
    now: () => 20_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idle.agent,
    chat: idle.chat,
    updateHandoffStore: store,
  });
  await foreignTarget.app.initialize();
  assert.equal(foreignTarget.document.getElementById("message-input").value, "");
  assert.equal(store.records.size, 0);
  assert.doesNotMatch(foreignTarget.window.location.href, /#lazying-update-handoff=/u);
});

test("a protected handoff read outage fences the composer and remains reload-retryable", async () => {
  const staged = await stageEncryptedTextUpdateHandoff();
  const baseStore = memoryUpdateHandoffStore([staged.record]);
  const failingStore = {
    ...baseStore,
    async take() {
      baseStore.calls.take += 1;
      throw new Error("injected IndexedDB read outage");
    },
  };
  const idle = idleAuthenticatedPwaClients();
  const blocked = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: staged.href,
    now: () => 20_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idle.agent,
    chat: idle.chat,
    updateHandoffStore: failingStore,
  });
  await blocked.app.initialize();
  assert.equal(baseStore.records.size, 1);
  assert.match(blocked.window.location.href, /#lazying-update-handoff=/u);
  assert.equal(blocked.document.getElementById("message-input").disabled, true);
  assert.equal(blocked.document.getElementById("send-message").disabled, true);
  assert.equal(blocked.document.getElementById("new-thread").disabled, true);

  const retried = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: blocked.window.location.href,
    now: () => 20_002,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: idle.agent,
    chat: idle.chat,
    updateHandoffStore: baseStore,
  });
  await retried.app.initialize();
  assert.equal(retried.document.getElementById("message-input").value, "private handoff draft");
  assert.equal(retried.document.getElementById("message-input").disabled, false);
  assert.equal(baseStore.records.size, 0);
});

test("an explicit release mismatch hard-refreshes by exact version and restores two unsent images from encrypted handoff", async () => {
  const clients = idleAuthenticatedPwaClients();
  const mutationCalls = { create: 0, retry: 0 };
  const chat = {
    ...clients.chat,
    prepareThread({ title }) {
      return Object.freeze({
        threadId: "chat_release_refresh_xxxxxxxxx",
        title,
        idempotencyKey: "thread_release_refresh_0001",
      });
    },
    prepareRun(value) {
      return Object.freeze({
        ...value,
        generationId: "generation_release_refresh_xxx",
        assistantMessageId: "assistant_release_refresh_xxxxx",
        idempotencyKey: "run_release_refresh_0000001",
      });
    },
    async createThread() {
      mutationCalls.create += 1;
      throw new DirectChatTransportError("stale release", {
        code: "client_release_mismatch",
        status: 409,
        retryable: false,
        serverRelease: NEXT_RELEASE,
      });
    },
    async retryCreateThread() { mutationCalls.retry += 1; throw new Error("must not retry"); },
  };
  const bytes = canonicalPngHeader();
  let imageSerial = 0;
  const store = memoryUpdateHandoffStore();
  const source = updateControllerHarness({
    waiting: false,
    now: () => 30_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: clients.agent,
    chat,
    updateHandoffStore: store,
    async canonicalizeImage() {
      imageSerial += 1;
      return Object.freeze({
        attachmentId: `image_release_refresh_0000000${imageSerial}`,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 64,
        height: 64,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl: (blob) => `blob:source-${blob.size}-${imageSerial}`,
    revokeObjectUrl() {},
  });
  await source.app.initialize();
  const imageInput = source.document.getElementById("image-input");
  imageInput.files = [{ name: "first.png" }, { name: "second.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  source.document.getElementById("message-input").value = "Describe both unsent mobile images";
  await source.app.submitMessage({ preventDefault() {} });

  assert.deepEqual(mutationCalls, { create: 1, retry: 0 });
  assert.equal(store.calls.save, 1);
  assert.equal(source.replacements.length, 1);
  assert.match(source.replacements[0], new RegExp(
    `^https://llm\\.lazying\\.art/\\?v=${NEXT_RELEASE}#lazying-update-handoff=`,
    "u",
  ));
  const encrypted = [...store.records.values()][0];
  assert.equal(encrypted.schemaVersion, "2");
  assert.doesNotMatch(JSON.stringify(encrypted), /Describe both unsent mobile images|image_release_refresh/u);

  const restoredClients = idleAuthenticatedPwaClients();
  let restoredUrlSerial = 0;
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 30_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: restoredClients.agent,
    chat: restoredClients.chat,
    updateHandoffStore: store,
    createObjectUrl: () => { restoredUrlSerial += 1; return `blob:restored-${restoredUrlSerial}`; },
    revokeObjectUrl() {},
  });
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("message-input").value, "Describe both unsent mobile images");
  assert.match(restored.document.getElementById("image-preview-label").textContent, /2 images/u);
  assert.equal(store.records.size, 0);
  assert.deepEqual(restoredClients.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
});

test("a versioned iPhone update encrypts and restores an unsent Agent multi-image draft without mutation", async () => {
  const capability = enabledAgentPwaCapability({ imageInput: true });
  const agentMutations = { createThread: 0, startRun: 0 };
  const makeAgent = () => ({
    async capabilities() { return capability; },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async createThread() { agentMutations.createThread += 1; throw new Error("update recovery must not create"); },
    async startRun() { agentMutations.startRun += 1; throw new Error("update recovery must not send"); },
    async *streamRunEvents() {},
  });
  const store = memoryUpdateHandoffStore();
  const environment = updateEnvironment();
  const bytes = canonicalPngHeader();
  let imageSerial = 0;
  const source = updateControllerHarness({
    environment,
    now: () => 31_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: makeAgent(),
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
    async canonicalizeImage() {
      imageSerial += 1;
      return Object.freeze({
        attachmentId: `image_agent_update_000000${imageSerial}`,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        width: 64,
        height: 64,
        bytes,
        previewBlob: new Blob([bytes], { type: "image/png" }),
      });
    },
    createObjectUrl: () => `blob:agent-source-${imageSerial}`,
    revokeObjectUrl() {},
  });
  await source.app.initialize();
  assert.equal(source.document.getElementById("workspace").dataset.mode, "agent");
  const imageInput = source.document.getElementById("image-input");
  imageInput.files = [{ name: "IMG_1001.HEIC" }, { name: "IMG_1002.HEIC" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  source.document.getElementById("message-input").value = "Compare these two unsent Agent images";
  source.document.getElementById("apply-update").dispatch("click");
  await store.saved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(environment.workerMessages, [{ type: "SKIP_WAITING" }]);
  assert.equal(store.records.size, 1);
  assert.doesNotMatch(JSON.stringify([...store.records.values()][0]), /Compare these two|image_agent_update/u);

  environment.registration.waiting = null;
  environment.transitionController(NEXT_RELEASE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.replacements.length, 1);

  let restoredUrls = 0;
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 31_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: makeAgent(),
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
    createObjectUrl: () => { restoredUrls += 1; return `blob:agent-restored-${restoredUrls}`; },
    revokeObjectUrl() {},
  });
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(restored.document.getElementById("message-input").value, "Compare these two unsent Agent images");
  assert.match(restored.document.getElementById("image-preview-label").textContent, /2 images/u);
  assert.equal(restored.document.getElementById("image-preview-thumbnail").src, "blob:agent-restored-1");
  assert.equal(restored.document.getElementById("add-image").hidden, false);
  assert.deepEqual(agentMutations, { createThread: 0, startRun: 0 });
  assert.equal(store.records.size, 0);
});

test("corrupt, oversized, foreign-release, and foreign-account update handoffs are deleted and rejected", async (t) => {
  const { href, record: [storageKey, encrypted] } = await stageEncryptedTextUpdateHandoff();
  const corrupt = structuredClone(encrypted);
  corrupt.ciphertext[0] ^= 0xff;
  const oversized = structuredClone(encrypted);
  oversized.ciphertext = new Uint8Array(16 * 1024 * 1024 + 160 * 1024 + 21);
  const foreignRelease = structuredClone(encrypted);
  foreignRelease.targetRelease = OLD_RELEASE;
  for (const scenario of [
    { name: "corrupt ciphertext", record: corrupt, username: "account-user" },
    { name: "oversized ciphertext", record: oversized, username: "account-user" },
    { name: "foreign target release", record: foreignRelease, username: "account-user" },
    { name: "foreign account", record: structuredClone(encrypted), username: "different-account" },
  ]) {
    await t.test(scenario.name, async () => {
      const store = memoryUpdateHandoffStore([[storageKey, scenario.record]]);
      const clients = idleAuthenticatedPwaClients();
      const restored = updateControllerHarness({
        waiting: false,
        environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
        releaseId: NEXT_RELEASE,
        locationHref: href,
        now: () => 20_001,
        restore: async () => ({
          authenticated: true,
          username: scenario.username,
          csrfToken: "csrf-token-value-long-enough",
        }),
        agent: clients.agent,
        chat: clients.chat,
        updateHandoffStore: store,
      });
      await restored.app.initialize();
      assert.equal(restored.document.getElementById("message-input").value, "");
      assert.match(restored.document.getElementById("toast").textContent, /failed its safety checks/u);
      assert.equal(store.calls.take, 1);
      assert.equal(store.records.size, 0, "rejected state is still consumed exactly once");
      assert.deepEqual(clients.mutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
    });
  }
});

test("a normal safe update never creates a handoff record and activates only once", async () => {
  const store = memoryUpdateHandoffStore();
  const harness = updateControllerHarness({ updateHandoffStore: store });
  await harness.app.initialize();
  await Promise.resolve();
  harness.document.getElementById("apply-update").dispatch("click");
  harness.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(harness.workerMessages, [{ type: "SKIP_WAITING" }]);
  assert.equal(store.calls.save, 0);
  assert.equal(store.calls.take, 0);
  assert.equal(store.records.size, 0);
});

test("Later re-prompts after bounded deferral and a newer waiting worker bypasses the old deferral", async () => {
  let instant = 10;
  const harness = updateControllerHarness({ now: () => instant });
  harness.document.getElementById("message-input").value = "keep the waiting worker unsafe";
  await harness.app.initialize();
  await Promise.resolve();
  harness.document.getElementById("defer-update").dispatch("click");
  assert.equal(harness.document.getElementById("update-banner").hidden, true);
  assert.deepEqual(harness.workerMessages, []);
  harness.runTimers(60 * 60 * 1_000);
  assert.equal(harness.document.getElementById("update-banner").hidden, false, "the same worker is offered again after bounded deferral");

  harness.document.getElementById("defer-update").dispatch("click");
  const newerWorker = harness.makeWorker(`release-${"c".repeat(64)}`);
  const installing = newerWorker;
  harness.registration.installing = installing;
  harness.registration.dispatch("updatefound");
  harness.registration.waiting = newerWorker;
  installing.dispatch("statechange");
  await Promise.resolve();
  assert.equal(harness.document.getElementById("update-banner").hidden, false, "a newer worker is never hidden behind an older deferral");
  instant += 1;
});

test("failed update activation re-enables controls and never leaves a dead banner", async () => {
  const failedPost = updateControllerHarness();
  failedPost.waitingWorker.throwOnPost = true;
  await failedPost.app.initialize();
  await Promise.resolve();
  failedPost.document.getElementById("apply-update").dispatch("click");
  assert.equal(failedPost.document.getElementById("apply-update").disabled, false);
  assert.equal(failedPost.document.getElementById("defer-update").disabled, false);
  assert.equal(failedPost.document.getElementById("update-banner").hidden, false);
  failedPost.waitingWorker.throwOnPost = false;
  failedPost.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(failedPost.workerMessages, [{ type: "SKIP_WAITING" }]);

  const timedOut = updateControllerHarness();
  await timedOut.app.initialize();
  await Promise.resolve();
  timedOut.document.getElementById("apply-update").dispatch("click");
  assert.equal(timedOut.document.getElementById("apply-update").disabled, true);
  timedOut.runTimers(30_000);
  assert.equal(timedOut.document.getElementById("apply-update").disabled, false);
  assert.equal(timedOut.document.getElementById("defer-update").disabled, false);
  assert.equal(timedOut.document.getElementById("update-banner").hidden, false);
});

test("updatefound shows a visible prompt only after the successor reaches waiting", async () => {
  const harness = updateControllerHarness({ waiting: false });
  await harness.app.initialize();
  await Promise.resolve();
  assert.equal(harness.document.getElementById("update-banner").hidden, true);
  const installing = harness.waitingWorker;
  harness.registration.installing = installing;
  harness.registration.dispatch("updatefound");
  harness.registration.waiting = harness.waitingWorker;
  installing.dispatch("statechange");
  await Promise.resolve();
  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(harness.workerMessages, [{ type: "SKIP_WAITING" }], "an idle safe tab activates a verified waiting worker automatically");
});

test("foreground and periodic update checks are online-only and throttled", async () => {
  let instant = 0;
  const harness = updateControllerHarness({ waiting: false, now: () => instant });
  await harness.app.initialize();
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 1);

  harness.document.visibilityState = "hidden";
  instant += 15 * 60 * 1_000 + 1;
  harness.document.dispatch("visibilitychange");
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 1);

  harness.document.visibilityState = "visible";
  harness.document.dispatch("visibilitychange");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 2, "returning to the foreground after cooldown checks once");

  harness.document.dispatch("visibilitychange");
  harness.transitionController();
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 2, "repeated foreground events inside cooldown are ignored");

  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  assert.equal(harness.registration.updateCalls, 2);

  harness.document.visibilityState = "visible";
  instant += 15 * 60 * 1_000 + 1;
  harness.runTimers(15 * 60 * 1_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 3, "a visible online tab checks periodically without requiring focus churn");
});

test("pageshow and visible PWA resume revalidate the retained browser session without duplicate hidden checks", async () => {
  const clients = idleAuthenticatedPwaClients();
  const session = Object.freeze({
    authenticated: true,
    username: "account-user",
    csrfToken: "csrf-token-value-long-enough",
  });
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => session,
    agent: clients.agent,
    chat: clients.chat,
  });
  await harness.app.initialize();
  assert.equal(harness.restoreCalls, 1);

  harness.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.restoreCalls, 2, "BFCache/PWA resume verifies the server session");

  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  await Promise.resolve();
  assert.equal(harness.restoreCalls, 2);

  harness.document.visibilityState = "visible";
  harness.document.dispatch("visibilitychange");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.restoreCalls, 3, "foreground resume revalidates exactly once");
});

test("a PWA resume with a revoked session preserves the unsent draft and returns to sign-in", async () => {
  const clients = idleAuthenticatedPwaClients();
  let valid = true;
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => valid
      ? { authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }
      : { authenticated: false },
    agent: clients.agent,
    chat: clients.chat,
  });
  await harness.app.initialize();
  harness.document.getElementById("message-input").value = "keep this unsent mobile draft";
  valid = false;
  harness.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.document.getElementById("login-view").hidden, false);
  assert.equal(harness.document.getElementById("message-input").value, "keep this unsent mobile draft");
  assert.match(harness.document.getElementById("login-error").textContent, /session expired/u);
});

test("same-account reauthentication replays the exact Agent thread before the preserved draft can send", async () => {
  const instant = "2026-08-25T11:00:00.000Z";
  const threadId = "thr_99999999-9999-4999-8999-999999999999";
  const thread = Object.freeze({
    id: threadId,
    title: "Long TeX and PDF session",
    status: "idle",
    revision: 1,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: null,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: "d".repeat(64),
      lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([]),
  });
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    search: Object.freeze({
      enabled: true,
      modes: Object.freeze(["web", "papers", "both"]),
      maximumSources: 20,
    }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown", "sources"]), schemaVersion: "1" }),
  });
  let valid = true;
  let exactReads = 0;
  let agentStarts = 0;
  const agent = {
    async capabilities() { return capability; },
    async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
    async getThread(requested) {
      assert.equal(requested, threadId);
      exactReads += 1;
      return { schemaVersion: "1", thread };
    },
    async startRun(requestedThreadId, text, options) {
      assert.equal(requestedThreadId, threadId);
      assert.equal(text, "Continue this exact Agent session after sign-in");
      assert.deepEqual(options.search, { mode: "papers", limit: 6 });
      agentStarts += 1;
      throw new Error("stop after proving Agent routing");
    },
    async *streamRunEvents() {},
  };
  const chatClients = idleAuthenticatedPwaClients();
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => valid
      ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
      : { authenticated: false },
    login: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "second-csrf-token-long-enough",
    }),
    agent,
    chat: chatClients.chat,
  });
  await harness.app.initialize();
  assert.equal(exactReads, 1);
  harness.document.getElementById("search-toggle").dispatch("click");
  harness.document.getElementById("search-mode").value = "papers";
  harness.document.getElementById("search-limit").value = "6";
  harness.document.getElementById("message-input").value = "Continue this exact Agent session after sign-in";
  valid = false;
  harness.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.document.getElementById("login-view").hidden, false);
  assert.equal(
    harness.document.getElementById("message-input").value,
    "Continue this exact Agent session after sign-in",
  );

  harness.document.getElementById("username").value = "account-user";
  harness.document.getElementById("password").value = "browser-password";
  harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exactReads, 2, "the same owned Agent thread is verified after the new browser session is issued");
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(harness.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(harness.document.getElementById("send-message").disabled, false);
  assert.equal(harness.document.getElementById("search-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(harness.document.getElementById("search-mode").value, "papers");
  assert.equal(harness.document.getElementById("search-limit").value, "6");
  assert.equal(
    harness.document.getElementById("message-input").value,
    "Continue this exact Agent session after sign-in",
  );
  await harness.app.submitMessage({ preventDefault() {} });
  assert.equal(agentStarts, 1);
  assert.equal(chatClients.mutationCalls.startRun, 0, "the preserved Agent prompt never falls through to Direct Chat");
});

test("session revalidation waits for an in-flight Agent thread create before revoking the browser session", async () => {
  const instant = "2026-08-25T11:30:00.000Z";
  const thread = Object.freeze({
    id: "thr_77777777-7777-4777-8777-777777777777",
    title: "Pending exact Agent create",
    status: "idle",
    revision: 1,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: null,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: "f".repeat(64),
      lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([]),
  });
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
  });
  let restoreCalls = 0;
  let resolveRevalidation;
  const revalidation = new Promise((resolve) => { resolveRevalidation = resolve; });
  let resolveCreate;
  const createResponse = new Promise((resolve) => { resolveCreate = resolve; });
  let createCalls = 0;
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => {
      restoreCalls += 1;
      if (restoreCalls === 1) {
        return { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" };
      }
      if (restoreCalls === 2) return await revalidation;
      return { authenticated: false };
    },
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
      async createThread() { createCalls += 1; return await createResponse; },
      async startRun() { throw Object.assign(new Error("stop after create ownership is confirmed"), { retryable: false }); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
  });
  await harness.app.initialize();
  harness.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restoreCalls, 2, "the foreground session read is now in flight");
  harness.document.getElementById("message-input").value = "Create exactly one Agent thread despite session revocation";
  const submission = harness.app.submitMessage({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCalls, 1);
  resolveRevalidation({ authenticated: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.document.getElementById("login-view").hidden, true,
    "the revoked read cannot erase an unresolved idempotent create ticket");
  resolveCreate({ schemaVersion: "1", thread });
  await submission;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCalls, 1);
  assert.equal(restoreCalls, 3, "the deferred revalidation runs after the mutation reconciles");
  assert.equal(harness.document.getElementById("login-view").hidden, false);
  assert.equal(
    harness.document.getElementById("message-input").value,
    "Create exactly one Agent thread despite session revocation",
  );
});

test("same-account reauthentication preserves an unresolved legacy-v2 destination fence", async () => {
  const legacy = await legacyV2DraftHandoff({ draft: "Keep the ambiguous rollout prompt owned" });
  const store = memoryUpdateHandoffStore([legacy.storageEntry]);
  let valid = true;
  let agentMutations = 0;
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
  });
  const harness = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: legacy.href,
    now: () => 80_001,
    restore: async () => valid
      ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
      : { authenticated: false },
    login: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "second-csrf-token-long-enough",
    }),
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
      async createThread() { agentMutations += 1; throw new Error("legacy recovery must remain read-only"); },
      async startRun() { agentMutations += 1; throw new Error("legacy recovery must remain read-only"); },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: store,
  });
  await harness.app.initialize();
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  valid = false;
  harness.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  harness.document.getElementById("username").value = "account-user";
  harness.document.getElementById("password").value = "browser-password";
  harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(harness.document.getElementById("message-input").value, "Keep the ambiguous rollout prompt owned");
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  assert.equal(harness.document.getElementById("send-message").disabled, true);
  assert.equal(store.records.size, 1);
  await harness.app.submitMessage({ preventDefault() {} });
  assert.equal(agentMutations, 0);
  harness.document.getElementById("new-thread").dispatch("click");
  assert.equal(harness.document.getElementById("message-input").disabled, true);
  assert.equal(harness.document.getElementById("send-message").disabled, false);
  await harness.app.submitMessage({ preventDefault() {} });
  assert.equal(agentMutations, 0, "reauthentication does not bypass the explicit No Search confirmation");
  assert.equal(harness.document.getElementById("message-input").disabled, false);
  assert.equal(store.records.size, 0);
});

test("a memory-only Agent auth draft retries capability verification in-page", async () => {
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
  });
  let sessionValid = true;
  let capabilityAvailable = true;
  let capabilityAttempts = 0;
  const agent = {
    async capabilities() {
      capabilityAttempts += 1;
      if (!capabilityAvailable) throw new Error("injected Agent capability outage");
      return capability;
    },
    async listThreads() { return { schemaVersion: "1", threads: [], nextBefore: null }; },
    async *streamRunEvents() {},
  };
  const harness = updateControllerHarness({
    waiting: false,
    restore: async () => sessionValid
      ? { authenticated: true, username: "account-user", csrfToken: "first-csrf-token-long-enough" }
      : { authenticated: false },
    login: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "second-csrf-token-long-enough",
    }),
    agent,
    chat: idleAuthenticatedPwaClients().chat,
    wait: async () => {},
  });
  await harness.app.initialize();
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  harness.document.getElementById("message-input").value = "Preserve this new Agent thread draft in memory";
  sessionValid = false;
  capabilityAvailable = false;
  harness.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  harness.document.getElementById("username").value = "account-user";
  harness.document.getElementById("password").value = "browser-password";
  harness.document.getElementById("login-form").dispatch("submit", { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capabilityAttempts, 4, "startup succeeded before the three bounded post-login probes failed");
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(harness.document.getElementById("message-input").value, "Preserve this new Agent thread draft in memory");
  assert.equal(harness.document.getElementById("send-message").disabled, true);
  assert.equal(harness.document.getElementById("resume-run").hidden, false);
  assert.match(harness.document.getElementById("toast").textContent, /Resume retries Agent verification/iu);
  capabilityAvailable = true;
  harness.document.getElementById("resume-run").dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capabilityAttempts, 5);
  assert.equal(harness.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(harness.document.getElementById("message-input").value, "Preserve this new Agent thread draft in memory");
  assert.equal(harness.document.getElementById("message-input").disabled, false);
  assert.equal(harness.document.getElementById("send-message").disabled, false);
});

test("an exact Agent update stays ownership-fenced when durable re-retention and replay both fail", async () => {
  const instant = "2026-08-25T12:00:00.000Z";
  const threadId = "thr_88888888-8888-4888-8888-888888888888";
  const thread = Object.freeze({
    id: threadId,
    title: "Exact locally owned Agent thread",
    status: "idle",
    revision: 1,
    createdAt: instant,
    updatedAt: instant,
    lastRunId: null,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: "e".repeat(64),
      lastCompaction: null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: "0".repeat(64) }),
    messages: Object.freeze([]),
  });
  const capability = Object.freeze({
    schemaVersion: "1",
    enabled: true,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: true, resume: true, retry: false }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({ kinds: Object.freeze(["plot", "table", "markdown"]), schemaVersion: "1" }),
  });
  const sourceStore = memoryUpdateHandoffStore();
  const environment = updateEnvironment();
  const source = updateControllerHarness({
    environment,
    now: () => 90_000,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { return { schemaVersion: "1", thread }; },
      async *streamRunEvents() {},
    },
    chat: idleAuthenticatedPwaClients().chat,
    updateHandoffStore: sourceStore,
  });
  await source.app.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  source.document.getElementById("message-input").value = "Never send this exact Agent follow-up to Direct Chat";
  source.document.getElementById("apply-update").dispatch("click");
  await sourceStore.saved;
  await new Promise((resolve) => setImmediate(resolve));
  environment.registration.waiting = null;
  environment.transitionController(NEXT_RELEASE);
  await new Promise((resolve) => setImmediate(resolve));

  const targetBaseStore = memoryUpdateHandoffStore([...sourceStore.records.entries()]);
  const targetStore = {
    ...targetBaseStore,
    async save() {
      targetBaseStore.calls.save += 1;
      throw new Error("injected protected-store re-retention failure");
    },
  };
  let exactReads = 0;
  let agentMutations = 0;
  const chatClients = idleAuthenticatedPwaClients();
  const restored = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: source.replacements[0],
    now: () => 90_001,
    restore: async () => ({ authenticated: true, username: "account-user", csrfToken: "csrf-token-value-long-enough" }),
    agent: {
      async capabilities() { return capability; },
      async listThreads() { return { schemaVersion: "1", threads: [thread], nextBefore: null }; },
      async getThread() { exactReads += 1; throw new Error("injected exact-ledger outage"); },
      async createThread() { agentMutations += 1; throw new Error("must remain fenced"); },
      async startRun() { agentMutations += 1; throw new Error("must remain fenced"); },
      async *streamRunEvents() {},
    },
    chat: chatClients.chat,
    updateHandoffStore: targetStore,
  });
  await restored.app.initialize();
  assert.equal(exactReads, 1);
  assert.equal(targetStore.records.size, 0, "the injected retention failure leaves no durable reload copy");
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  assert.equal(restored.document.getElementById("message-input").value, "Never send this exact Agent follow-up to Direct Chat");
  assert.equal(restored.document.getElementById("message-input").disabled, true);
  assert.equal(restored.document.getElementById("send-message").disabled, true);
  restored.document.getElementById("chat-mode").dispatch("click");
  assert.equal(restored.document.getElementById("workspace").dataset.mode, "agent");
  await restored.app.submitMessage({ preventDefault() {} });
  assert.equal(agentMutations, 0);
  assert.equal(chatClients.mutationCalls.startRun, 0);
  restored.document.getElementById("new-thread").dispatch("click");
  assert.equal(restored.document.getElementById("message-input").disabled, false,
    "explicit New conversation is the only non-replay path that detaches the memory-only prompt");
});

test("one stable worker registration discovers v1, v2, and v3 without a second version authority", async () => {
  const maps = await Promise.all(["v1", "v2", "v3"].map((marker) => productionMap({ label: "stable-worker", marker })));
  let servedSource = maps[0].get(maps[0].serviceWorkerRoute).body;
  const seen = [];
  let instant = 0;
  const harness = updateControllerHarness({
    waiting: false,
    now: () => instant,
    async onUpdate() {
      const match = /const VERSION = "([^"]+)";/u.exec(servedSource);
      seen.push(match?.[1]);
    },
  });
  await harness.app.initialize();
  await Promise.resolve();
  servedSource = maps[1].get(maps[1].serviceWorkerRoute).body;
  instant += 15 * 60 * 1_000 + 1;
  harness.document.dispatch("visibilitychange");
  await Promise.resolve();
  await Promise.resolve();
  servedSource = maps[2].get(maps[2].serviceWorkerRoute).body;
  instant += 15 * 60 * 1_000 + 1;
  harness.document.dispatch("visibilitychange");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seen, maps.map((map) => map.releaseVersion));
  assert.deepEqual(harness.serviceWorker.registerCalls, [["/sw.js", { scope: "/", updateViaCache: "none" }]]);
});

test("an offline startup does not delay the immediate online update retry", async () => {
  const harness = updateControllerHarness({
    waiting: false,
    online: false,
    async onUpdate(call) { if (call === 1) throw new Error("offline"); },
  });
  await harness.app.initialize();
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 1);
  harness.navigator.onLine = true;
  harness.window.dispatch("online");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registration.updateCalls, 2, "online transition must retry a failed startup check immediately");
});

test("service-worker registration starts only after hydration and cannot block the first usable UI", async () => {
  const never = new Promise(() => {});
  const hydration = Promise.withResolvers();
  const harness = updateControllerHarness({
    controlled: false,
    registerPromise: never,
    restore: async () => await hydration.promise,
  });
  const initialization = harness.app.initialize();
  await Promise.resolve();
  assert.equal(harness.restoreCalls, 1);
  assert.deepEqual(harness.serviceWorker.registerCalls, [], "cold shell installation cannot compete with session hydration");
  hydration.resolve({ authenticated: false });
  const result = await Promise.race([
    initialization.then(() => "initialized"),
    new Promise((resolve) => setImmediate(() => resolve("blocked"))),
  ]);
  assert.equal(result, "initialized");
  assert.equal(harness.document.getElementById("login-view").hidden, false);
  assert.equal(harness.document.getElementById("app-view").hidden, true);
  assert.equal(harness.document.getElementById("login-submit").disabled, false);
  await Promise.resolve();
  assert.deepEqual(harness.serviceWorker.registerCalls, [["/sw.js", { scope: "/", updateViaCache: "none" }]]);
});

test("runtime configuration injects only normalized endpoint paths and never accepts secrets or traversal", () => {
  assert.deepEqual(createBrowserRuntimeConfig(), {
    sessionEndpoint: "/api/session",
    agentTransportEndpoint: "/api/transport",
  });
  for (const value of ["https://edge.test/api", "/api/../private", "/api/%2e%2e/private", "/api?token=secret", "/api\\private"]) {
    assert.throws(() => createBrowserRuntimeConfig({ agentTransportEndpoint: value }), /normalized|absolute path/u);
  }
  const serialized = JSON.stringify(createBrowserRuntimeConfig());
  assert.doesNotMatch(serialized, /password|authorization|bearer|secret|principal/iu);
});

test("theme persistence stores only the theme and keeps bright as the fail-safe default", () => {
  const document = new DomDocument();
  const writes = [];
  const storage = {
    getItem() { return "not-a-theme"; },
    setItem(key, value) { writes.push([key, value]); },
  };
  assert.equal(restoreTheme({ document, storage }), "bright");
  assert.equal(document.documentElement.dataset.theme, "bright");
  assert.deepEqual(writes, [["lazying-agent-theme", "bright"]]);
  assert.equal(applyTheme("dark", { document, storage }), "dark");
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.throws(() => applyTheme("credential", { document, storage }), /theme/u);
});

test("workspace mode persistence stores only a bounded non-private preference", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  assert.equal(restoreWorkspaceMode({ storage }), null);
  assert.equal(rememberWorkspaceMode("chat", { storage }), "chat");
  assert.equal(restoreWorkspaceMode({ storage }), "chat");
  assert.deepEqual([...values], [["lazying-agent-workspace-mode", "chat"]]);
  assert.equal(rememberWorkspaceMode("agent", { storage }), "agent");
  assert.equal(restoreWorkspaceMode({ storage }), "agent");
  values.set("lazying-agent-workspace-mode", "credential");
  assert.equal(restoreWorkspaceMode({ storage }), null);
  assert.throws(() => rememberWorkspaceMode("credential", { storage }), /workspace mode/u);
  const unavailable = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
  };
  assert.equal(restoreWorkspaceMode({ storage: unavailable }), null);
  assert.equal(rememberWorkspaceMode("chat", { storage: unavailable }), "chat");
});

test("password saving delegates to the browser Credential Management API without app storage", async () => {
  const previous = globalThis.PasswordCredential;
  const form = { id: "login-form" };
  const saved = [];
  class PasswordCredential {
    constructor(source) { this.source = source; }
  }
  globalThis.PasswordCredential = PasswordCredential;
  try {
    const result = await offerPasswordManagerSave(form, {
      credentials: { async store(credential) { saved.push(credential); } },
    });
    assert.equal(result, true);
    assert.equal(saved[0].source, form);
  } finally {
    if (previous === undefined) delete globalThis.PasswordCredential;
    else globalThis.PasswordCredential = previous;
  }
});

test("Markdown renders text-only DOM and asks pinned KaTeX for MathML with trust disabled", () => {
  const document = new DomDocument();
  const calls = [];
  const katex = {
    render(source, target, options) {
      calls.push({ source, options });
      const math = document.createElement("math");
      math.textContent = source;
      target.appendChild(math);
    },
  };
  const renderer = createSafeRenderer({ document, katex, locationHref: "https://llm.lazying.art/" });
  const target = document.createElement("section");
  renderer.renderMarkdown(target, "# Result\n\nEuler: $e^{i\\pi}+1=0$.\n\n<script>alert(1)</script> [bad](javascript:alert(1))");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "e^{i\\pi}+1=0");
  assert.equal(calls[0].options.output, "mathml");
  assert.equal(calls[0].options.trust, false);
  assert.equal(calls[0].options.strict, "error");
  assert.equal(target.walk().some((node) => node.tagName === "script"), false);
  assert.equal(target.walk().some((node) => node.href.startsWith("javascript:")), false);
  assert.match(target.textContent, /<script>alert\(1\)<\/script>/u);
});

test("Markdown preserves adjacent assistant lines while retaining hard-break rendering", () => {
  const document = new DomDocument();
  const renderer = createSafeRenderer({ document });
  const lineLayout = (markdown) => {
    const target = document.createElement("section");
    renderer.renderMarkdown(target, markdown);
    const paragraph = target.walk().find((node) => node.tagName === "p");
    const lines = [""];
    let breaks = 0;
    for (const node of paragraph.children) {
      if (node.tagName === "br") {
        breaks += 1;
        lines.push("");
      } else lines[lines.length - 1] += node.textContent;
    }
    return { breaks, lines };
  };

  assert.deepEqual(lineLayout("CHECKSUM: 783\nSAME_THREAD: yes"), {
    breaks: 1,
    lines: ["CHECKSUM: 783", "SAME_THREAD: yes"],
  });
  assert.deepEqual(lineLayout("First  \nSecond"), {
    breaks: 1,
    lines: ["First  ", "Second"],
  });
});

test("plot, table, Markdown, and source artifacts render declaratively while active content fails closed", () => {
  const document = new DomDocument();
  const renderer = createSafeRenderer({ document });
  const target = document.createElement("section");
  assert.equal(renderer.renderArtifact(target, artifact("plot", {
    schemaVersion: "1",
    type: "line",
    labels: ["A", "B"],
    series: [{ name: "Value", data: [-148.413159, 0] }],
  })), true);
  assert.equal(target.dataset.status, "ready");
  assert.equal(target.walk().some((node) => node.tagName === "svg"), true);
  assert.equal(target.walk().some((node) => node.tagName === "script"), false);
  const plotNodes = target.walk();
  const plotSvg = plotNodes.find((node) => node.tagName === "svg");
  assert.equal(plotSvg.getAttribute("viewBox"), "0 0 720 390");
  assert.equal(plotSvg.getAttribute("width"), "720");
  assert.equal(plotSvg.getAttribute("height"), "390");
  assert.equal(plotSvg.getAttribute("preserveAspectRatio"), "xMidYMid meet");
  const plotDescription = plotNodes.find((node) => node.tagName === "desc");
  assert.ok(plotDescription);
  assert.equal(plotSvg.getAttribute("aria-describedby"), plotDescription.getAttribute("id"));
  assert.match(plotDescription.textContent, /Displayed category ticks: A; B/u);
  assert.match(plotDescription.textContent, /Y-axis ticks:/u);
  assert.match(plotDescription.textContent, /Series: Value/u);
  const yTicks = plotNodes.filter((node) => node.getAttribute("class")?.split(/\s+/u).includes("plot-y-tick"));
  assert.equal(yTicks.length, 5);
  assert.deepEqual(yTicks.map((node) => node.textContent), ["0", "-37.1", "-74.2", "-111", "-148"]);
  assert.equal(plotNodes.filter((node) => node.getAttribute("class")?.split(/\s+/u).includes("plot-x-tick")).length, 2);
  const swatches = plotNodes.filter((node) => /(?:^|\s)artifact-swatch-\d(?:\s|$)/u.test(node.className));
  assert.equal(swatches.length, 1);
  assert.equal(swatches[0].className.includes("artifact-swatch-0"), true);
  assert.equal(plotNodes.some((node) => node.attributes.has("style") || Object.keys(node.style).length > 0), false);
  const svgDownload = plotNodes.find((node) => node.tagName === "a" && node.textContent === "Download SVG");
  assert.ok(svgDownload);
  assert.equal(svgDownload.getAttribute("download"), "safe-result-aaaaaaaa.svg");
  assert.match(svgDownload.getAttribute("href"), /^data:image\/svg\+xml;charset=utf-8,/u);
  const exportedSvg = decodeURIComponent(svgDownload.getAttribute("href").split(",", 2)[1]);
  assert.match(exportedSvg, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /u);
  assert.match(exportedSvg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(exportedSvg, /<style>\.plot-grid\{stroke:var\(--line,#d5d9de\)\}/u);
  assert.match(exportedSvg, /Safe result/u);
  assert.doesNotMatch(exportedSvg, /<script|onload=|javascript:/iu);

  const numericTarget = document.createElement("section");
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.equal(renderer.renderArtifact(numericTarget, artifact("plot", {
    schemaVersion: "1",
    type: "scatter",
    series: [{ name: "Large values", points: [
      { x: -maximum, y: -maximum },
      { x: 0, y: 0 },
      { x: maximum, y: maximum },
    ] }],
  })), true);
  const numericNodes = numericTarget.walk();
  const numericXTicks = numericNodes.filter((node) => node.getAttribute("class")?.split(/\s+/u).includes("plot-x-tick"));
  assert.deepEqual(numericXTicks.map((node) => node.textContent), ["-9e15", "-4.5e15", "0", "4.5e15", "9e15"]);
  assert.deepEqual(numericXTicks.map((node) => node.getAttribute("aria-label")), [
    "-9007199254740991", "-4503599627370495.5", "0", "4503599627370495", "9007199254740991",
  ]);
  assert.match(numericNodes.find((node) => node.tagName === "desc").textContent, /X-axis absolute ticks: -9007199254740991/u);

  assert.equal(renderer.renderArtifact(target, artifact("table", {
    schemaVersion: "1",
    columns: [{ key: "name", label: "Name" }, { key: "value", label: "Value" }],
    rows: [{ name: "=2+2", value: "a,\"b\"\nline" }],
  })), true);
  assert.equal(target.walk().some((node) => node.tagName === "table"), true);
  const csvDownload = target.walk().find((node) => node.tagName === "a" && node.textContent === "Download CSV");
  assert.ok(csvDownload);
  assert.equal(csvDownload.getAttribute("download"), "safe-result-aaaaaaaa.csv");
  assert.match(csvDownload.getAttribute("href"), /^data:text\/csv;charset=utf-8,/u);
  assert.equal(
    decodeURIComponent(csvDownload.getAttribute("href").split(",", 2)[1]),
    '\ufeff"Name","Value"\r\n"\'=2+2","a,""b""\nline"\r\n',
  );
  const repeatedTable = document.createElement("section");
  renderer.renderArtifact(repeatedTable, artifact("table", {
    schemaVersion: "1",
    columns: [{ key: "name", label: "Name" }, { key: "value", label: "Value" }],
    rows: [{ name: "=2+2", value: "a,\"b\"\nline" }],
  }));
  const repeatedCsv = repeatedTable.walk().find((node) => node.tagName === "a" && node.textContent === "Download CSV");
  assert.equal(repeatedCsv.getAttribute("href"), csvDownload.getAttribute("href"), "same table yields byte-identical CSV");

  assert.equal(renderer.renderArtifact(target, artifact("markdown", {
    schemaVersion: "1",
    markdown: "**Safe result** with $x^2$",
  })), true);
  assert.match(target.textContent, /Safe result/u);

  assert.equal(renderer.renderArtifact(target, artifact("sources", {
    schemaVersion: "1",
    sources: [{
      index: 1,
      title: "Primary & verified source",
      url: "https://example.test/research",
      snippet: "Evidence rendered only as literal text.",
      providers: ["provider-one", "provider-two"],
      kind: "paper",
      publishedDate: "2026-08-20",
      doi: "10.1234/example.1",
    }],
  })), true);
  const sourceNodes = target.walk();
  const sourceAnchors = sourceNodes.filter((node) => node.tagName === "a");
  assert.equal(sourceAnchors.length, 1);
  assert.equal(sourceAnchors[0].getAttribute("href"), "https://example.test/research");
  assert.equal(sourceAnchors[0].getAttribute("target"), "_blank");
  assert.equal(sourceAnchors[0].getAttribute("rel"), "noopener noreferrer");
  assert.equal(sourceAnchors[0].textContent, "Primary & verified source");
  assert.match(target.textContent, /Evidence rendered only as literal text/u);
  assert.match(target.textContent, /Paper · provider-one, provider-two · 2026-08-20 · DOI 10\.1234\/example\.1/u);
  assert.equal(sourceNodes.some((node) => ["img", "iframe", "script", "link"].includes(node.tagName)), false);

  const fileTarget = document.createElement("section");
  const fileRenderer = createSafeRenderer({
    document,
    locationHref: "https://llm.lazying.art/conversation",
    releaseId: CURRENT_RELEASE,
  });
  assert.equal(fileRenderer.renderArtifact(fileTarget, artifact("file", {
    schemaVersion: "1",
    filename: "paper.pdf",
    mime: "application/pdf",
    bytes: 2_500_000,
    sha256: "a".repeat(64),
  })), true);
  const fileNodes = fileTarget.walk();
  const fileLinks = fileNodes.filter((node) => node.tagName === "a");
  assert.equal(fileLinks.length, 2);
  assert.deepEqual(fileLinks.map((node) => node.getAttribute("href")), [
    `https://llm.lazying.art/api/agent/artifacts/${ARTIFACT_ID}/content?v=${CURRENT_RELEASE}`,
    `https://llm.lazying.art/api/agent/artifacts/${ARTIFACT_ID}/content?v=${CURRENT_RELEASE}&download=1`,
  ]);
  assert.equal(fileLinks[0].textContent, "Open");
  assert.equal(fileLinks[0].getAttribute("target"), null);
  assert.equal(fileLinks[0].getAttribute("rel"), null);
  assert.equal(fileLinks[1].textContent, "Download");
  assert.equal(fileLinks[1].getAttribute("download"), "paper.pdf");
  assert.match(fileTarget.textContent, /paper\.pdf · 2\.4 MB/u);
  assert.match(fileTarget.textContent, /Not stored or cached by the web edge/u);
  assert.equal(fileNodes.some((node) => ["img", "iframe", "script", "object", "embed"].includes(node.tagName)), false);

  const unpinnedFileTarget = document.createElement("section");
  assert.equal(createSafeRenderer({
    document,
    locationHref: "https://llm.lazying.art/conversation",
    releaseId: null,
  }).renderArtifact(unpinnedFileTarget, artifact("file", {
    schemaVersion: "1",
    filename: "paper.pdf",
    mime: "application/pdf",
    bytes: 2_500_000,
    sha256: "a".repeat(64),
  })), false);
  assert.equal(unpinnedFileTarget.walk().some((node) => node.tagName === "a"), false);

  assert.equal(renderer.renderArtifact(target, {
    ...artifact("markdown", { schemaVersion: "1", markdown: "safe" }),
    html: "<img src=x onerror=alert(1)>",
  }), false);
  assert.equal(target.dataset.status, "rejected");
  assert.equal(target.walk().some((node) => ["script", "iframe", "img"].includes(node.tagName)), false);

  assert.equal(renderer.renderArtifact(target, artifact("plot", {
    schemaVersion: "1",
    type: "line",
    labels: ["unsafe"],
    series: [{ name: "Overflow", data: [Number.MAX_VALUE] }],
  })), false);
  assert.equal(target.dataset.status, "rejected");
  assert.equal(target.walk().some((node) => node.tagName === "svg"), false);

  const defensiveDocument = new DomDocument();
  const createElementNS = defensiveDocument.createElementNS.bind(defensiveDocument);
  defensiveDocument.createElementNS = (namespace, name) => {
    if (name === "path") throw new TypeError("simulated SVG construction failure");
    return createElementNS(namespace, name);
  };
  const defensiveRenderer = createSafeRenderer({ document: defensiveDocument });
  const defensiveTarget = defensiveDocument.createElement("section");
  assert.equal(defensiveRenderer.renderArtifact(defensiveTarget, artifact("plot", {
    schemaVersion: "1",
    type: "line",
    labels: ["A", "B"],
    series: [{ name: "Value", data: [1, 2] }],
  })), false);
  assert.equal(defensiveTarget.dataset.status, "rejected");
  assert.equal(defensiveTarget.walk().some((node) => node.tagName === "svg"), false);
});

test("rendering implementation contains no HTML injection, dynamic code execution, or external fetch", async () => {
  const source = await readFile(new URL("../src/web/safe-rendering.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/iu);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/iu);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
});

// Legacy encrypted update-handoff compatibility. Keep these fixtures separate
// from current-version update tests so their historical wire bytes stay fixed.
test("an encrypted inner-v1 Chat handoff restores its PNG into the current four-image composer without a mutation", async () => {
  const encoder = new TextEncoder();
  const createdAt = 125_000;
  const draft = "Restore this exact legacy PNG prompt without sending it";
  const threadId = "chat_inner_v1_compat_xxxxxxxxx";
  const handoffId = "9".repeat(64);
  const keyBytes = Uint8Array.from({ length: 32 }, (unused, index) => 0x60 + index);
  const keyText = Buffer.from(keyBytes).toString("base64url");
  const imageBytes = new Uint8Array(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  const image = Object.freeze({
    attachmentId: "image_inner_v1_compat_0001",
    mediaType: "image/png",
    byteLength: imageBytes.byteLength,
    width: 1,
    height: 1,
  });
  const accountDigest = createHash("sha256")
    .update(encoder.encode("lazying-agent-update-account\u0000account-user"))
    .digest("hex");
  const encodeInner = (metadata) => {
    const metadataBytes = encoder.encode(JSON.stringify(metadata));
    const payload = new Uint8Array(4 + metadataBytes.byteLength + imageBytes.byteLength);
    new DataView(payload.buffer).setUint32(0, metadataBytes.byteLength);
    payload.set(metadataBytes, 4);
    payload.set(imageBytes, 4 + metadataBytes.byteLength);
    return payload;
  };
  const unsignedInner = {
    schemaVersion: "1",
    scope: "/",
    sourceRelease: CURRENT_RELEASE,
    targetRelease: NEXT_RELEASE,
    createdAt,
    accountDigest,
    threadId,
    draft,
    image,
  };
  const inner = encodeInner({
    ...unsignedInner,
    digest: createHash("sha256").update(encodeInner(unsignedInner)).digest("hex"),
  });
  const envelope = {
    schemaVersion: "1",
    scope: "/",
    handoffId,
    sourceRelease: CURRENT_RELEASE,
    targetRelease: NEXT_RELEASE,
    createdAt,
    expiresAt: createdAt + 5 * 60 * 1_000,
  };
  const iv = Uint8Array.from({ length: 12 }, (unused, index) => 0xd0 + index);
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: encoder.encode(JSON.stringify(envelope)),
    tagLength: 128,
  }, cryptoKey, inner));
  const stored = { ...envelope, iv, ciphertext };
  assert.equal(stored.schemaVersion, "1", "inner-v1 historically used the outer-v1 envelope");
  assert.doesNotMatch(JSON.stringify(stored), /legacy PNG prompt|account-user|chat_inner_v1/u);

  const thread = Object.freeze({
    threadId,
    title: "Legacy image conversation",
    modelAlias: "local-default",
    revision: 0,
    ledgerHash: null,
    messageCount: 0,
    ledgerBytes: 0,
    currentGenerationId: null,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const mutationCalls = [];
  const rejectMutation = (name) => {
    mutationCalls.push(name);
    throw new Error(`legacy handoff restore must not call ${name}`);
  };
  let threadReads = 0;
  const chat = {
    async capabilities() {
      return { visionInput: true, visionMediaTypes: ["image/jpeg", "image/png"], maximumImageBytes: 4 * 1024 * 1024 };
    },
    prepareThread() { return rejectMutation("prepareThread"); },
    async createThread() { return rejectMutation("createThread"); },
    async retryCreateThread() { return rejectMutation("retryCreateThread"); },
    async listThreads() { return { threads: [thread] }; },
    async getThread(requestedThreadId) {
      assert.equal(requestedThreadId, threadId);
      threadReads += 1;
      return { thread };
    },
    prepareThreadDeletion() { return rejectMutation("prepareThreadDeletion"); },
    async deleteThread() { return rejectMutation("deleteThread"); },
    async retryDeleteThread() { return rejectMutation("retryDeleteThread"); },
    async listMessages({ threadId: requestedThreadId }) {
      assert.equal(requestedThreadId, threadId);
      return { messages: [] };
    },
    async getAttachment() { throw new Error("empty history has no attachment read"); },
    prepareRun() { return rejectMutation("prepareRun"); },
    async startRun() { return rejectMutation("startRun"); },
    async retryRun() { return rejectMutation("retryRun"); },
    async getRunStatus() { throw new Error("idle history has no run status"); },
    async *streamRunEvents() {},
    prepareCancellation() { return rejectMutation("prepareCancellation"); },
    async cancelRun() { return rejectMutation("cancelRun"); },
  };
  const store = memoryUpdateHandoffStore([[`/\u0000${handoffId}`, stored]]);
  const restoredBlobs = [];
  let appendedImages = 0;
  const href = `https://llm.lazying.art/?v=${NEXT_RELEASE}#lazying-update-handoff=${handoffId}.${keyText}`;
  const harness = updateControllerHarness({
    waiting: false,
    environment: updateEnvironment({ waiting: false, activeReleaseId: NEXT_RELEASE }),
    releaseId: NEXT_RELEASE,
    locationHref: href,
    now: () => createdAt + 1,
    restore: async () => ({
      authenticated: true,
      username: "account-user",
      csrfToken: "csrf-token-value-long-enough",
    }),
    agent: idleAuthenticatedPwaClients().agent,
    chat,
    updateHandoffStore: store,
    async canonicalizeImage() {
      appendedImages += 1;
      return Object.freeze({
        attachmentId: `image_inner_v1_current_000${appendedImages}`,
        mediaType: "image/png",
        byteLength: imageBytes.byteLength,
        width: 1,
        height: 1,
        bytes: imageBytes,
        previewBlob: new Blob([imageBytes], { type: "image/png" }),
      });
    },
    createObjectUrl(blob) {
      restoredBlobs.push(blob);
      return restoredBlobs.length === 1
        ? "blob:inner-v1-restored-png"
        : `blob:inner-v1-current-${restoredBlobs.length - 1}`;
    },
    revokeObjectUrl() {},
  });
  assert.match(harness.window.location.href, /#lazying-update-handoff=/u,
    "the one-time key remains reload-safe until authenticated decryption");
  await harness.app.initialize();

  assert.equal(harness.document.getElementById("workspace").dataset.mode, "chat");
  assert.equal(harness.document.getElementById("conversation-title").textContent, thread.title);
  assert.equal(threadReads, 2, "the carried Chat thread is read before and after its empty snapshot");
  assert.equal(harness.document.getElementById("message-input").value, draft);
  assert.equal(harness.document.getElementById("image-preview").hidden, false);
  assert.equal(harness.document.getElementById("image-preview-thumbnail").src, "blob:inner-v1-restored-png");
  assert.equal(restoredBlobs.length, 1);
  assert.equal(restoredBlobs[0].type, "image/png");
  assert.deepEqual(new Uint8Array(await restoredBlobs[0].arrayBuffer()), imageBytes);

  const imageInput = harness.document.getElementById("image-input");
  imageInput.files = [{ name: "second.png" }, { name: "third.png" }, { name: "fourth.png" }];
  imageInput.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appendedImages, 3);
  assert.match(harness.document.getElementById("image-preview-label").textContent, /4 images/u);
  assert.equal(harness.document.getElementById("image-preview-thumbnail").src, "blob:inner-v1-restored-png",
    "the restored legacy image remains first in current ordered multi-image input");
  assert.equal(harness.document.getElementById("add-image").disabled, true,
    "the successor shell enforces its current four-image limit");
  assert.equal(restoredBlobs.length, 4);
  assert.deepEqual(mutationCalls, []);
  assert.deepEqual(store.calls, { save: 1, take: 1, discard: 1 },
    "startup re-retains the row until UI initialization, then consumes it exactly once");
  assert.equal(store.records.size, 0);
  assert.deepEqual(harness.historyReplacements, [`/?v=${NEXT_RELEASE}`]);
  assert.doesNotMatch(harness.window.location.href, /lazying-update-handoff/u,
    "successful restore consumes the one-time URL key");
});
