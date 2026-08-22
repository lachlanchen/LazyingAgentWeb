import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  AGENT_WEB_CACHE_PREFIX,
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

const ARTIFACT_ID = `art_${"a".repeat(64)}`;
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

function appDocument({ basePath = "/" } = {}) {
  const document = new DomDocument();
  APP_IDS.forEach((id) => document.ids.set(id, new DomNode(id === "login-form" || id === "composer" ? "form" : "div")));
  const scope = normalizeAgentWebBasePath(basePath);
  const workerPath = scope === "/" ? "/sw.js" : `${scope.slice(0, -1)}/sw.js`;
  for (const [name, content] of [
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
    clients: { async claim() { claimCalls += 1; operations.push("claim"); } },
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

function updateEnvironment({ waiting = true, controlled = true, onUpdate = async () => {}, registerPromise } = {}) {
  const workerMessages = [];
  const waitingWorker = {
    throwOnPost: false,
    postMessage(value) {
      if (this.throwOnPost) throw new Error("postMessage failed");
      workerMessages.push(value);
    },
  };
  const registration = Object.assign(eventTarget(), {
    waiting: waiting ? waitingWorker : null,
    installing: null,
    updateCalls: 0,
    async update() { this.updateCalls += 1; await onUpdate(this.updateCalls); },
  });
  let controllerNumber = 0;
  const makeController = () => Object.assign(eventTarget(), {
    scriptURL: `https://llm.lazying.art/sw.js#controller-${controllerNumber += 1}`,
    messages: [],
    postMessage(value) { this.messages.push(value); },
  });
  const serviceWorker = Object.assign(eventTarget(), {
    controller: controlled ? makeController() : null,
    registerCalls: [],
    async register(path, options) {
      this.registerCalls.push([path, options]);
      if (registerPromise) return await registerPromise;
      return registration;
    },
  });
  const transitionController = () => {
    const controller = makeController();
    serviceWorker.controller = controller;
    serviceWorker.dispatch("controllerchange");
    return controller;
  };
  return { registration, serviceWorker, waitingWorker, workerMessages, transitionController };
}

function updateControllerHarness({
  waiting = true,
  controlled = true,
  now = () => 0,
  online = true,
  onUpdate = async () => {},
  basePath = "/",
  environment,
  registerPromise,
  restore = async () => ({ authenticated: false }),
  locationHref,
  agent,
  chat,
} = {}) {
  const document = appDocument({ basePath });
  const shared = environment ?? updateEnvironment({ waiting, controlled, onUpdate, registerPromise });
  const { registration, serviceWorker, waitingWorker, workerMessages } = shared;
  let reloads = 0;
  const replacements = [];
  let nextTimer = 1;
  const timers = new Map();
  const window = Object.assign(eventTarget(), {
    location: {
      protocol: "https:", href: locationHref ?? `https://llm.lazying.art${normalizeAgentWebBasePath(basePath)}`,
      reload() { reloads += 1; },
      replace(value) { replacements.push(String(value)); this.href = String(value); },
    },
    setTimeout(callback, delay) { const id = nextTimer; nextTimer += 1; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
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
      return chat;
    },
    renderer: {
      renderMarkdown(target, value) { target.textContent = value; },
      renderArtifact() { return false; },
    },
    credentialSaver: async () => false,
    now,
  });
  return {
    app,
    document,
    registration,
    navigator,
    window,
    serviceWorker,
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
  };
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
  assert.doesNotMatch(source.match(/self\.addEventListener\("install"[\s\S]*?\n\}\);/u)[0], /skipWaiting/u);
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
  await Promise.all([confirmingTab.app.initialize(), deferredTab.app.initialize()]);
  await Promise.resolve();
  assert.equal(confirmingTab.document.getElementById("update-banner").hidden, false);
  assert.equal(deferredTab.document.getElementById("update-banner").hidden, false);
  deferredTab.document.getElementById("defer-update").dispatch("click");
  assert.equal(deferredTab.document.getElementById("update-banner").hidden, true);
  assert.deepEqual(environment.workerMessages, [], "Later must not activate the waiting worker");

  confirmingTab.document.getElementById("apply-update").dispatch("click");
  confirmingTab.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(environment.workerMessages, [{ type: "SKIP_WAITING" }]);
  environment.transitionController();
  environment.serviceWorker.dispatch("controllerchange");
  confirmingTab.runTimers(1_000);
  deferredTab.runTimers(1_000);
  assert.deepEqual(confirmingTab.replacements, ["https://llm.lazying.art/"]);
  assert.deepEqual(deferredTab.replacements, ["https://llm.lazying.art/"], "Later cannot veto a successor activated by another controlled tab");
  assert.equal(confirmingTab.reloads, 0);
  assert.equal(deferredTab.reloads, 0);

  const initialEnvironment = updateEnvironment({ waiting: false, controlled: false });
  const initialTab = updateControllerHarness({ environment: initialEnvironment, controlled: false });
  await initialTab.app.initialize();
  await Promise.resolve();
  initialEnvironment.transitionController();
  assert.equal(initialTab.reloads, 0, "first control acquisition is not an app update");

  const installing = eventTarget();
  initialEnvironment.registration.installing = installing;
  initialEnvironment.registration.waiting = initialEnvironment.waitingWorker;
  initialEnvironment.registration.dispatch("updatefound");
  installing.dispatch("statechange");
  initialTab.document.getElementById("apply-update").dispatch("click");
  assert.deepEqual(initialEnvironment.workerMessages, [{ type: "SKIP_WAITING" }]);
  initialEnvironment.transitionController();
  initialEnvironment.serviceWorker.dispatch("controllerchange");
  initialTab.runTimers(1_000);
  assert.deepEqual(initialTab.replacements, ["https://llm.lazying.art/"], "the same tab navigates for a later approved successor");
  assert.equal(initialTab.reloads, 0);
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

test("a release-handshake timeout replaces a stale versioned URL with the stable worker scope", async () => {
  const staleRelease = `release-${"1".repeat(64)}`;
  const harness = updateControllerHarness({
    locationHref: `https://llm.lazying.art/?v=${staleRelease}`,
  });
  await harness.app.initialize();
  await Promise.resolve();
  const controller = harness.transitionController();
  assert.deepEqual(controller.messages, [{ type: "GET_LAZYING_AGENT_RELEASE" }]);

  harness.runTimers(1_000);

  assert.deepEqual(harness.replacements, ["https://llm.lazying.art/"]);
  assert.equal(harness.reloads, 0, "the stale release query must never be reloaded");
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
    const agent = {
      async capabilities() { return capability; },
      async listThreads() { return { threads: [] }; },
      async createThread() { return { thread: { id: threadId, title: "Terminal update safety" } }; },
      async startRun() { return { run: { id: runId, threadId, status: "starting" } }; },
      async *streamRunEvents() {},
      async runStatus() { return { run: { id: runId, threadId, status, output: "server-owned result" } }; },
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

test("Later re-prompts after bounded deferral and a newer waiting worker bypasses the old deferral", async () => {
  let instant = 10;
  const harness = updateControllerHarness({ now: () => instant });
  await harness.app.initialize();
  await Promise.resolve();
  harness.document.getElementById("defer-update").dispatch("click");
  assert.equal(harness.document.getElementById("update-banner").hidden, true);
  assert.deepEqual(harness.workerMessages, []);
  harness.runTimers(60 * 60 * 1_000);
  assert.equal(harness.document.getElementById("update-banner").hidden, false, "the same worker is offered again after bounded deferral");

  harness.document.getElementById("defer-update").dispatch("click");
  const newerWorker = { postMessage(value) { harness.workerMessages.push(value); } };
  const installing = eventTarget();
  harness.registration.installing = installing;
  harness.registration.dispatch("updatefound");
  harness.registration.waiting = newerWorker;
  installing.dispatch("statechange");
  assert.equal(harness.document.getElementById("update-banner").hidden, false, "a newer worker is never hidden behind an older deferral");
  instant += 1;
});

test("failed update activation re-enables controls and never leaves a dead banner", async () => {
  const failedPost = updateControllerHarness();
  await failedPost.app.initialize();
  await Promise.resolve();
  failedPost.waitingWorker.throwOnPost = true;
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
  const installing = eventTarget();
  harness.registration.installing = installing;
  harness.registration.dispatch("updatefound");
  harness.registration.waiting = harness.waitingWorker;
  installing.dispatch("statechange");
  assert.equal(harness.document.getElementById("update-banner").hidden, false);
  assert.deepEqual(harness.workerMessages, []);
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

test("a stalled optional service-worker registration never blocks session restore or chat startup", async () => {
  const never = new Promise(() => {});
  const harness = updateControllerHarness({ registerPromise: never });
  const result = await Promise.race([
    harness.app.initialize().then(() => "initialized"),
    new Promise((resolve) => setImmediate(() => resolve("blocked"))),
  ]);
  assert.equal(result, "initialized");
  assert.equal(harness.restoreCalls, 1);
  assert.equal(harness.document.getElementById("login-view").hidden, false);
  assert.equal(harness.document.getElementById("app-view").hidden, true);
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
});

test("rendering implementation contains no HTML injection, dynamic code execution, or external fetch", async () => {
  const source = await readFile(new URL("../src/web/safe-rendering.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/iu);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/iu);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
});
