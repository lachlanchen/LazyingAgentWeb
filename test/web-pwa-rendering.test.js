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
  restoreTheme,
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
  "welcome-eyebrow", "welcome-copy", "messages", "activity-panel", "run-state", "agent-plan",
  "agent-timeline", "agent-artifacts", "composer", "message-input", "send-message", "resume-run",
  "stop-run", "image-input", "add-image", "image-preview", "image-preview-thumbnail",
  "image-preview-label", "remove-image", "install-app", "toast", "sidebar", "sidebar-scrim", "open-sidebar",
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
  locationHref,
  agent,
  chat,
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
      async login() { return { authenticated: false }; },
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
    renderer: {
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
  assert.match(html, /AgInTi owns Agent runs, tools, context, compaction, and artifacts/u);
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

test("mobile thread rows reserve non-overlapping title and full Delete control rectangles", () => {
  const rowRule = /\.thread-row \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  const deleteRule = /\.thread-delete \{([^}]*)\}/u.exec(BRIGHT_APP_CSS);
  assert.ok(rowRule);
  assert.ok(deleteRule);
  assert.match(rowRule[1], /display:\s*grid;/u);
  assert.match(
    rowRule[1],
    /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(4\.5rem, max-content\);/u,
  );
  assert.match(deleteRule[1], /width:\s*100%;/u);
  assert.match(deleteRule[1], /min-width:\s*4\.5rem;/u);
  assert.match(deleteRule[1], /min-height:\s*44px;/u);
  assert.doesNotMatch(rowRule[1], /position:\s*(?:absolute|fixed)/u);
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
    /\.workspace \{[^}]*min-height: 0;[^}]*height: 100%;[^}]*overflow: hidden;[^}]*grid-template-rows: auto auto auto minmax\(0, 1fr\) auto auto;/u,
  );
  assert.match(
    BRIGHT_APP_CSS,
    /@media \(max-width: 760px\) \{[\s\S]*\.composer \{[^}]*flex-direction: column;[^}]*align-items: stretch;/u,
  );
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
  assert.deepEqual(restored.historyReplacements, [`/?v=${NEXT_RELEASE}`], "the decryption key is scrubbed before async startup");
  await restored.app.initialize();
  assert.equal(restored.document.getElementById("message-input").value, "Describe this exact restored image");
  assert.equal(restored.document.getElementById("image-preview").hidden, false);
  assert.equal(restored.document.getElementById("image-preview-thumbnail").src, "blob:restored-image");
  assert.match(restored.document.getElementById("toast").textContent, /restored/u);
  assert.deepEqual(restoredMutationCalls, { prepareThread: 0, createThread: 0, startRun: 0 });
  assert.equal(store.calls.take, 1);
  assert.equal(store.records.size, 0, "the encrypted handoff is deleted before validation and restored only in memory");
});

test("corrupt, oversized, foreign-release, and foreign-account update handoffs are deleted and rejected", async (t) => {
  const { href, record: [storageKey, encrypted] } = await stageEncryptedTextUpdateHandoff();
  const corrupt = structuredClone(encrypted);
  corrupt.ciphertext[0] ^= 0xff;
  const oversized = structuredClone(encrypted);
  oversized.ciphertext = new Uint8Array(4 * 1024 * 1024 + 160 * 1024 + 21);
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

test("plot, table, and Markdown artifacts render declaratively while active content fails closed", () => {
  const document = new DomDocument();
  const renderer = createSafeRenderer({ document });
  const target = document.createElement("section");
  assert.equal(renderer.renderArtifact(target, artifact("plot", {
    schemaVersion: "1",
    type: "line",
    labels: ["A", "B"],
    series: [{ name: "Value", data: [1, 2] }],
  })), true);
  assert.equal(target.dataset.status, "ready");
  assert.equal(target.walk().some((node) => node.tagName === "svg"), true);
  assert.equal(target.walk().some((node) => node.tagName === "script"), false);
  const plotNodes = target.walk();
  const swatches = plotNodes.filter((node) => /(?:^|\s)artifact-swatch-\d(?:\s|$)/u.test(node.className));
  assert.equal(swatches.length, 1);
  assert.equal(swatches[0].className.includes("artifact-swatch-0"), true);
  assert.equal(plotNodes.some((node) => node.attributes.has("style") || Object.keys(node.style).length > 0), false);

  assert.equal(renderer.renderArtifact(target, artifact("table", {
    schemaVersion: "1",
    columns: [{ key: "name", label: "Name" }, { key: "value", label: "Value" }],
    rows: [{ name: "A", value: 2 }],
  })), true);
  assert.equal(target.walk().some((node) => node.tagName === "table"), true);

  assert.equal(renderer.renderArtifact(target, artifact("markdown", {
    schemaVersion: "1",
    markdown: "**Safe result** with $x^2$",
  })), true);
  assert.match(target.textContent, /Safe result/u);

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
