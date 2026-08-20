export const AGENT_WEB_GENERATOR_VERSION = "3";
export const AGENT_WEB_CACHE_PREFIX = "lazying-agent-web-";
export const AGENT_WEB_KATEX_VERSION = "0.16.47";
export const AGENT_WEB_RELEASE_ROOT = "/assets/r";
export const AGENT_WEB_MODULE_ROUTES = Object.freeze([
  "/assets/app.js",
  "/assets/browser-app.js",
  "/assets/cloud-session-client.js",
  "/assets/direct-chat-client.js",
  "/assets/aginti-client.js",
  "/assets/aginti-protocol.js",
  "/assets/presentation-state.js",
  "/assets/pwa-assets.js",
  "/assets/safe-rendering.js",
  "/assets/katex.mjs",
]);

export function validateAgentWebRelease(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,95}$/u.test(value)) {
    throw new TypeError("releaseVersion must be a portable 1-96 character identifier");
  }
  return value;
}

export function agentWebBuildQuery(version) {
  return `?v=${encodeURIComponent(validateAgentWebRelease(version))}`;
}

export function normalizeAgentWebBasePath(value = "/") {
  if (typeof value !== "string" || value.length < 1 || value.length > 160
      || !/^\/[A-Za-z0-9._~/-]*$/u.test(value) || value.includes("//")
      || value.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("basePath must be a normalized injection-safe absolute path");
  }
  const withoutTrailing = value.length > 1 ? value.replace(/\/+$/u, "") : value;
  return withoutTrailing === "/" ? "/" : `${withoutTrailing}/`;
}

export function agentWebScopeIdentity(basePath = "/") {
  const scope = normalizeAgentWebBasePath(basePath);
  return [...new TextEncoder().encode(scope)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function versionedAgentWebAsset(pathname, version) {
  const path = normalizedPath(pathname, "asset pathname");
  if (!path.startsWith("/assets/")) throw new TypeError("versioned asset pathname must be below /assets/");
  return `${AGENT_WEB_RELEASE_ROOT}/${encodeURIComponent(validateAgentWebRelease(version))}${path.slice("/assets".length)}`;
}

export function agentWebCacheName(version, { basePath = "/" } = {}) {
  return `${AGENT_WEB_CACHE_PREFIX}${agentWebScopeIdentity(basePath)}-${validateAgentWebRelease(version)}`;
}

const THEMES = new Set(["bright", "dark", "system"]);

function codeUnitCompare(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function boundedText(value, name, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f<>]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizedPath(value, name, { trailingSlash = false } = {}) {
  if (typeof value !== "string" || value.length > 256 || !/^\/[A-Za-z0-9._~/-]*$/u.test(value)
      || value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${name} must be a normalized absolute path`);
  }
  if (trailingSlash) return value.endsWith("/") ? value : `${value}/`;
  return value.length > 1 ? value.replace(/\/$/u, "") : value;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function concatenate(parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function uint32(value) {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = new TextEncoder().encode(name);
  return concatenate([uint32(data.byteLength), type, data, uint32(crc32(concatenate([type, data])))]);
}

function adler32(value) {
  let a = 1;
  let b = 0;
  for (const byte of value) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function uncompressedZlib(value) {
  const blocks = [Uint8Array.of(0x78, 0x01)];
  for (let offset = 0; offset < value.byteLength;) {
    const length = Math.min(65_535, value.byteLength - offset);
    const final = offset + length === value.byteLength;
    blocks.push(Uint8Array.of(
      final ? 1 : 0,
      length & 0xff,
      length >>> 8,
      (~length) & 0xff,
      ((~length) >>> 8) & 0xff,
    ));
    blocks.push(value.slice(offset, offset + length));
    offset += length;
  }
  blocks.push(uint32(adler32(value)));
  return concatenate(blocks);
}

const iconCache = new Map();

export function createPwaIcon(size) {
  if (![192, 512].includes(size)) throw new TypeError("PWA icon size must be 192 or 512");
  if (iconCache.has(size)) return iconCache.get(size).slice();
  const rowBytes = Math.ceil(size / 8);
  const scanlines = new Uint8Array((rowBytes + 1) * size);
  const scale = size / 512;
  const bars = [[166, 235, 202, 336], [223, 165, 259, 336], [280, 201, 316, 336]];
  for (let y = 0; y < size; y += 1) {
    const py = y / scale;
    const row = y * (rowBytes + 1);
    for (let x = 0; x < size; x += 1) {
      const px = x / scale;
      const foreground = bars.some(([left, top, right, bottom]) => px >= left && px <= right && py >= top && py <= bottom);
      if (foreground) scanlines[row + 1 + (x >>> 3)] |= 1 << (7 - (x & 7));
    }
  }
  const ihdr = concatenate([uint32(size), uint32(size), Uint8Array.of(1, 3, 0, 0, 0)]);
  const palette = Uint8Array.of(20, 125, 117, 225, 255, 249);
  const png = concatenate([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", palette),
    pngChunk("IDAT", uncompressedZlib(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
  iconCache.set(size, png);
  return png.slice();
}

export function createPwaManifest({
  basePath = "/",
  name = "LazyingArt Agent",
  shortName = "Lazying Agent",
  version,
} = {}) {
  const scope = normalizeAgentWebBasePath(basePath);
  boundedText(name, "name", 80);
  boundedText(shortName, "shortName", 24);
  const iconBase = scope === "/" ? "" : scope.slice(0, -1);
  return Object.freeze({
    name,
    short_name: shortName,
    description: "A cloud presentation surface for AgInTi Agent with direct LocalLLM chat fallback.",
    id: scope,
    start_url: scope,
    scope,
    display: "standalone",
    background_color: "#f4f7f6",
    theme_color: "#f7faf9",
    orientation: "any",
    categories: Object.freeze(["productivity", "utilities"]),
    icons: Object.freeze([
      Object.freeze({ src: `${iconBase}${versionedAgentWebAsset("/assets/icon-192.png", version)}`, sizes: "192x192", type: "image/png", purpose: "any maskable" }),
      Object.freeze({ src: `${iconBase}${versionedAgentWebAsset("/assets/icon-512.png", version)}`, sizes: "512x512", type: "image/png", purpose: "any maskable" }),
    ]),
  });
}

function validatedShellAssets(value, scope) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) {
    throw new TypeError("shellAssets must contain 2-32 integrity entries");
  }
  const base = new URL(scope, "https://shell.invalid");
  const seen = new Set();
  let totalSize = 0;
  const assets = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
        || Object.getPrototypeOf(entry) !== Object.prototype
        || Object.keys(entry).sort(codeUnitCompare).join(",") !== "contentType,headers,sha256,size,url") {
      throw new TypeError(`shellAssets[${index}] is invalid`);
    }
    if (typeof entry.url !== "string" || entry.url.length > 320 || !entry.url.startsWith("/")
        || /[\\#\u0000-\u001f\u007f]/u.test(entry.url) || /%(?:2e|2f|5c)/iu.test(entry.url)) {
      throw new TypeError(`shellAssets[${index}].url is invalid`);
    }
    const target = new URL(entry.url, base);
    if (target.origin !== base.origin || !target.pathname.startsWith(scope)
        || target.username || target.password || target.hash || seen.has(target.pathname + target.search)) {
      throw new TypeError(`shellAssets[${index}].url is outside or duplicated within the scope`);
    }
    if (typeof entry.contentType !== "string" || ![
      "text/html", "application/manifest+json", "text/css", "text/javascript", "image/png",
    ].includes(entry.contentType)) throw new TypeError(`shellAssets[${index}].contentType is unsupported`);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new TypeError(`shellAssets[${index}].sha256 is invalid`);
    }
    if (entry.headers === null || typeof entry.headers !== "object" || Array.isArray(entry.headers)
        || Object.getPrototypeOf(entry.headers) !== Object.prototype || Object.keys(entry.headers).length > 16) {
      throw new TypeError(`shellAssets[${index}].headers is invalid`);
    }
    const headers = {};
    for (const [name, headerValue] of Object.entries(entry.headers).sort(([left], [right]) => codeUnitCompare(left, right))) {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)
          || ["cache-control", "content-length", "content-type", "set-cookie"].includes(name)
          || typeof headerValue !== "string" || headerValue.length < 1 || headerValue.length > 2_048
          || /[\r\n\u0000]/u.test(headerValue)) {
        throw new TypeError(`shellAssets[${index}].headers contains an invalid contract`);
      }
      headers[name] = headerValue;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 4 * 1024 * 1024) {
      throw new TypeError(`shellAssets[${index}].size is invalid`);
    }
    totalSize += entry.size;
    if (totalSize > 16 * 1024 * 1024) throw new TypeError("shellAssets exceed the total shell size bound");
    const url = target.pathname + target.search;
    seen.add(url);
    return Object.freeze({
      url,
      contentType: entry.contentType,
      headers: Object.freeze(headers),
      sha256: entry.sha256,
      size: entry.size,
    });
  });
  if (!seen.has(scope)) throw new TypeError("shellAssets must contain the exact navigation scope");
  return Object.freeze(assets);
}

export function createServiceWorkerSource({
  basePath = "/",
  version,
  contentDigest,
  shellAssets,
} = {}) {
  const scope = normalizeAgentWebBasePath(basePath);
  const releaseVersion = validateAgentWebRelease(version);
  if (typeof contentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(contentDigest)) {
    throw new TypeError("contentDigest must be a SHA-256 digest");
  }
  const shell = validatedShellAssets(shellAssets, scope);
  const base = scope === "/" ? "" : scope.slice(0, -1);
  const scopeIdentity = agentWebScopeIdentity(scope);
  const cacheScopePrefix = `${AGENT_WEB_CACHE_PREFIX}${scopeIdentity}-`;
  const cacheName = agentWebCacheName(releaseVersion, { basePath: scope });
  const metaKey = `${base}/.lazying-agent-cache-${scopeIdentity}.json`;
  const stateCacheName = `${AGENT_WEB_CACHE_PREFIX}state-${scopeIdentity}`;
  const activeKey = `${base}/.lazying-agent-active-${scopeIdentity}.json`;
  return `"use strict";\n\n`
    + `const VERSION = ${JSON.stringify(releaseVersion)};\n`
    + `const CONTENT_DIGEST = ${JSON.stringify(contentDigest)};\n`
    + `const BASE = ${JSON.stringify(base)};\n`
    + `const SCOPE_ID = ${JSON.stringify(scopeIdentity)};\n`
    + `const CACHE_SCOPE_PREFIX = ${JSON.stringify(cacheScopePrefix)};\n`
    + `const CACHE_NAME = ${JSON.stringify(cacheName)};\n`
    + `const META_KEY = ${JSON.stringify(metaKey)};\n`
    + `const STATE_CACHE_NAME = ${JSON.stringify(stateCacheName)};\n`
    + `const ACTIVE_KEY = ${JSON.stringify(activeKey)};\n`
    + `const SHELL = Object.freeze(${JSON.stringify(shell)});\n`
    + `const STATIC = new Set(SHELL.slice(1).map((asset) => asset.url));\n\n`
    + `async function digestHex(bytes) {\n`
    + `  const digest = await crypto.subtle.digest("SHA-256", bytes);\n`
    + `  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");\n`
    + `}\n\n`
    + `async function verifiedResponse(asset) {\n`
    + `  const expected = new URL(asset.url, self.location.origin).href;\n`
    + `  const response = await fetch(new Request(asset.url, { cache: "reload", credentials: "same-origin", redirect: "error" }));\n`
    + `  const contentType = String(response.headers.get("content-type") || "").toLowerCase().split(";", 1)[0].trim();\n`
    + `  const headersMatch = Object.entries(asset.headers).every(([name, value]) => response.headers.get(name) === value);\n`
    + `  if (!response.ok || response.status !== 200 || response.redirected || response.type === "opaque" || response.url !== expected\n`
    + `      || contentType !== asset.contentType || !headersMatch) throw new Error("PWA asset response contract mismatch");\n`
    + `  const bytes = await response.clone().arrayBuffer();\n`
    + `  if (bytes.byteLength !== asset.size || await digestHex(bytes) !== asset.sha256) throw new Error("PWA asset integrity mismatch");\n`
    + `  return { asset, response };\n`
    + `}\n\n`
    + `self.addEventListener("install", (event) => {\n`
    + `  event.waitUntil(Promise.all(SHELL.map(verifiedResponse)).then(async (responses) => {\n`
    + `    try {\n`
    + `      const cache = await caches.open(CACHE_NAME);\n`
    + `      await Promise.all(responses.map(({ asset, response }) => cache.put(asset.url, response)));\n`
    + `      await cache.put(META_KEY, new Response(JSON.stringify({ cacheName: CACHE_NAME, contentDigest: CONTENT_DIGEST, scopeId: SCOPE_ID, installedAt: Date.now() }), { headers: { "content-type": "application/json" } }));\n`
    + `    } catch (error) {\n`
    + `      await caches.delete(CACHE_NAME);\n`
    + `      throw error;\n`
    + `    }\n`
    + `  }));\n`
    + `});\n\n`
    + `self.addEventListener("message", (event) => {\n`
    + `  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();\n`
    + `});\n\n`
    + `async function cacheRecord(name) {\n`
    + `  if (!name.startsWith(CACHE_SCOPE_PREFIX)) return null;\n`
    + `  try {\n`
    + `    const metadata = await (await (await caches.open(name)).match(META_KEY))?.json();\n`
    + `    if (!metadata || Object.keys(metadata).sort().join(",") !== "cacheName,contentDigest,installedAt,scopeId"\n`
    + `        || metadata.cacheName !== name || metadata.scopeId !== SCOPE_ID || !/^[a-f0-9]{64}$/.test(metadata.contentDigest)\n`
    + `        || !name.endsWith("-" + metadata.contentDigest)\n`
    + `        || !Number.isFinite(metadata.installedAt)) return null;\n`
    + `    return { name, metadata };\n`
    + `  } catch { return null; }\n`
    + `}\n\n`
    + `async function activePointer() {\n`
    + `  try {\n`
    + `    const value = await (await (await caches.open(STATE_CACHE_NAME)).match(ACTIVE_KEY))?.json();\n`
    + `    if (!value || Object.keys(value).sort().join(",") !== "current,previous,scopeId" || value.scopeId !== SCOPE_ID\n`
    + `        || typeof value.current !== "string" || !value.current.startsWith(CACHE_SCOPE_PREFIX)\n`
    + `        || (value.previous !== null && (typeof value.previous !== "string" || !value.previous.startsWith(CACHE_SCOPE_PREFIX)))) return null;\n`
    + `    return value;\n`
    + `  } catch { return null; }\n`
    + `}\n\n`
    + `self.addEventListener("activate", (event) => {\n`
    + `  event.waitUntil(caches.keys().then(async (names) => {\n`
    + `    const records = (await Promise.all(names.map(cacheRecord))).filter(Boolean);\n`
    + `    const current = records.find((record) => record.name === CACHE_NAME);\n`
    + `    if (!current) throw new Error("current PWA cache metadata is unavailable");\n`
    + `    const pointer = await activePointer();\n`
    + `    const candidate = pointer?.current === CACHE_NAME ? pointer.previous : pointer?.current;\n`
    + `    const previous = candidate && records.some((record) => record.name === candidate) ? candidate : null;\n`
    + `    const keep = new Set([CACHE_NAME, previous].filter(Boolean));\n`
    + `    await (await caches.open(STATE_CACHE_NAME)).put(ACTIVE_KEY, new Response(JSON.stringify({ scopeId: SCOPE_ID, current: CACHE_NAME, previous }), { headers: { "content-type": "application/json" } }));\n`
    + `    await self.clients.claim();\n`
    + `    await Promise.all(names.map((name) => name.startsWith(CACHE_SCOPE_PREFIX) && !keep.has(name) ? caches.delete(name) : false));\n`
    + `  }));\n`
    + `});\n\n`
    + `self.addEventListener("fetch", (event) => {\n`
    + `  const request = event.request;\n`
    + `  const accept = String(request.headers.get("accept") || "").toLowerCase();\n`
    + `  if (request.method !== "GET" || request.headers.has("range") || accept.includes("text/event-stream")) return;\n`
    + `  const url = new URL(request.url);\n`
    + `  if (url.origin !== self.location.origin || url.hash || !url.pathname.startsWith(BASE + "/")) return;\n`
    + `  const relative = url.pathname.slice(BASE.length);\n`
    + `  if (relative.startsWith("/api/") || relative.startsWith("/agent/") || relative.startsWith("/v1/")) return;\n`
    + `  if (request.mode === "navigate" && !url.search && url.pathname === ${JSON.stringify(scope)}) {\n`
    + `    event.respondWith(fetch(request).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(${JSON.stringify(scope)})).then((cached) => cached || Response.error())));\n`
    + `    return;\n`
    + `  }\n`
    + `  const cacheKey = url.pathname + url.search;\n`
    + `  if (!STATIC.has(cacheKey)) return;\n`
    + `  event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(cacheKey).then((cached) => cached || Response.error())));\n`
    + `});\n`;
}

export function createAppShellHtml({
  basePath = "/",
  title = "LazyingArt Agent",
  loginPath = "/api/login",
  version,
} = {}) {
  const scope = normalizeAgentWebBasePath(basePath);
  const base = scope === "/" ? "" : scope.slice(0, -1);
  const safeTitle = escapeHtml(boundedText(title, "title", 80));
  const safeLoginPath = escapeHtml(normalizedPath(loginPath, "loginPath"));
  const build = agentWebBuildQuery(version);
  return `<!doctype html>
<html lang="en" data-theme="bright">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f7faf9" id="theme-color">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="same-origin">
  <title>${safeTitle}</title>
  <meta name="lazying-agent-release" content="${escapeHtml(validateAgentWebRelease(version))}">
  <meta name="lazying-agent-base-path" content="${scope}">
  <meta name="lazying-agent-service-worker" content="${base}/sw.js">
  <link rel="manifest" href="${base}/manifest.webmanifest${build}">
  <link rel="stylesheet" href="${base}${versionedAgentWebAsset("/assets/app.css", version)}">
</head>
<body>
  <main id="login-view" class="login-view" aria-labelledby="login-title">
    <form id="login-form" class="login-card" method="post" action="${safeLoginPath}" autocomplete="on">
      <p class="eyebrow">Private cloud workspace</p>
      <h1 id="login-title">${safeTitle}</h1>
      <p class="muted">Sign in to resume your server-held session. The app does not save your password.</p>
      <label>Username<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="128"></label>
      <label>Password<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
      <label class="remember"><input id="remember-session" name="remember" type="checkbox" checked> Keep this device signed in</label>
      <p id="login-error" class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary">Sign in</button>
      <p class="privacy-note">Password saving is handled only by your browser or password manager.</p>
    </form>
  </main>

  <div id="app-view" class="app-view" hidden>
    <aside id="sidebar" class="sidebar" aria-label="Conversations">
      <header class="brand"><span class="brand-mark" aria-hidden="true">LA</span><strong>${safeTitle}</strong></header>
      <button id="new-thread" class="primary" type="button">New conversation</button>
      <nav id="thread-list" class="thread-list" aria-label="Saved conversations"></nav>
      <footer>
        <span id="signed-in-user"></span>
        <button id="logout" type="button">Sign out</button>
      </footer>
    </aside>
    <button id="sidebar-scrim" class="sidebar-scrim" type="button" aria-label="Close conversations" hidden></button>

    <section id="workspace" class="workspace" data-mode="chat" data-status="idle">
      <header class="topbar">
        <button id="open-sidebar" class="icon-button" type="button" aria-label="Open conversations">☰</button>
        <div>
          <strong id="conversation-title">New conversation</strong>
          <span id="connection-state" class="connection-state" role="status">Connecting</span>
        </div>
        <div id="mode-switch" class="mode-switch" role="group" aria-label="Conversation mode" hidden>
          <button id="agent-mode" type="button" aria-pressed="false">Agent</button>
          <button id="chat-mode" type="button" aria-pressed="true">Chat</button>
        </div>
        <label class="theme-label">Theme
          <select id="theme-picker" autocomplete="off">
            <option value="bright" selected>Bright</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
      </header>

      <div id="offline-banner" class="notice" role="status" hidden>You are offline. Messages stay in the composer until the connection returns.</div>
      <div id="update-banner" class="notice" role="status" hidden>A safe app update is ready. <button id="apply-update" type="button">Update</button> <button id="defer-update" type="button">Later</button></div>
      <div id="context-indicator" class="context-indicator" data-testid="context-compaction" hidden><span id="context-indicator-text"></span></div>

      <div id="chat-scroll" class="chat-scroll">
        <section id="welcome" class="welcome">
          <p class="eyebrow" id="welcome-eyebrow">Direct LocalLLM chat</p>
          <h1 id="welcome-title">What can I help you work through?</h1>
          <p id="welcome-copy">Agent mode appears only after AgInTi proves its exact capability contract.</p>
        </section>
        <section id="messages" class="messages" aria-live="polite" aria-relevant="additions text"></section>
      </div>

      <aside id="activity-panel" class="activity-panel" aria-label="AgInTi run activity" hidden>
        <header><strong>Agent activity</strong><span id="run-state">Idle</span></header>
        <ol id="agent-plan" class="agent-plan" data-testid="agent-plan"></ol>
        <ol id="agent-timeline" class="agent-timeline" data-testid="tool-timeline"></ol>
        <section id="agent-artifacts" class="agent-artifacts" data-testid="artifact-panel"></section>
      </aside>

      <form id="composer" class="composer" autocomplete="off">
        <label class="sr-only" for="message-input">Message</label>
        <textarea id="message-input" name="message" rows="1" maxlength="32000" placeholder="Message LocalLLM" required></textarea>
        <div class="composer-actions">
          <button id="resume-run" type="button" hidden>Resume</button>
          <button id="stop-run" type="button" hidden>Stop</button>
          <button id="send-message" class="primary" type="submit">Send</button>
        </div>
      </form>
      <p class="footer-note">AgInTi owns Agent runs, tools, context, compaction, and artifacts. This UI is a presentation surface.</p>
    </section>
  </div>
  <button id="install-app" class="install-app" type="button" hidden>Install app</button>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <script type="module" src="${base}${versionedAgentWebAsset("/assets/app.js", version)}"></script>
</body>
</html>\n`;
}

export const BRIGHT_APP_CSS = `:root {
  color-scheme: light;
  --bg: #f4f7f6;
  --surface: #ffffff;
  --surface-soft: #eef4f2;
  --text: #17302d;
  --muted: #617571;
  --line: #d5e1de;
  --accent: #147d75;
  --accent-strong: #0d625c;
  --accent-soft: #d9f1ed;
  --danger: #a63838;
  --shadow: 0 18px 50px rgb(30 67 62 / 12%);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1716;
  --surface: #182321;
  --surface-soft: #202e2b;
  --text: #ecf5f2;
  --muted: #9fb3ae;
  --line: #314440;
  --accent: #62c8bc;
  --accent-strong: #8bd9d0;
  --accent-soft: #193d39;
  --danger: #ff9a9a;
  --shadow: 0 18px 50px rgb(0 0 0 / 32%);
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    color-scheme: dark;
    --bg: #0f1716; --surface: #182321; --surface-soft: #202e2b; --text: #ecf5f2;
    --muted: #9fb3ae; --line: #314440; --accent: #62c8bc; --accent-strong: #8bd9d0;
    --accent-soft: #193d39; --danger: #ff9a9a; --shadow: 0 18px 50px rgb(0 0 0 / 32%);
  }
}
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; background: var(--bg); color: var(--text); }
button, input, textarea, select { color: inherit; font: inherit; }
button, select, input, textarea { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; }
button { cursor: pointer; padding: .62rem .9rem; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary { border-color: var(--accent); background: var(--accent); color: white; font-weight: 650; }
.primary:hover { background: var(--accent-strong); }
.login-view { min-height: 100dvh; display: grid; place-items: center; padding: 1.25rem; }
.login-card { width: min(100%, 430px); display: grid; gap: 1rem; padding: clamp(1.5rem, 4vw, 2.5rem); background: var(--surface); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow); }
.login-card h1, .welcome h1 { margin: 0; letter-spacing: -.035em; }
.login-card label:not(.remember) { display: grid; gap: .4rem; font-weight: 600; }
.login-card input { min-height: 46px; padding: .7rem .8rem; }
.remember { display: flex; align-items: center; gap: .55rem; color: var(--muted); }
.remember input { width: 1.05rem; height: 1.05rem; }
.muted, .privacy-note, .footer-note { color: var(--muted); }
.privacy-note, .footer-note { font-size: .82rem; }
.form-error { margin: 0; color: var(--danger); }
.eyebrow { margin: 0; color: var(--accent); font-size: .78rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.app-view { min-height: 100dvh; display: grid; grid-template-columns: 280px minmax(0, 1fr); }
.sidebar { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 1rem; padding: 1rem; background: var(--surface); border-right: 1px solid var(--line); z-index: 4; }
.brand { display: flex; gap: .7rem; align-items: center; min-height: 44px; }
.brand-mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: var(--accent-soft); color: var(--accent-strong); font-size: .78rem; font-weight: 800; }
.thread-list { display: grid; gap: .35rem; overflow-y: auto; }
.thread-list button { overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.sidebar footer { display: grid; gap: .5rem; margin-top: auto; }
.workspace { min-width: 0; min-height: 100dvh; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto auto; }
.topbar { min-height: 66px; display: flex; align-items: center; gap: .8rem; padding: .7rem 1rem; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(16px); }
.topbar > div:nth-child(2) { display: grid; min-width: 0; margin-right: auto; }
.connection-state { color: var(--muted); font-size: .78rem; }
.mode-switch { display: flex; padding: .2rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }
.mode-switch button { border: 0; padding: .45rem .75rem; background: transparent; }
.mode-switch button[aria-pressed="true"] { background: var(--surface); color: var(--accent-strong); box-shadow: 0 1px 5px rgb(0 0 0 / 8%); }
.theme-label { display: flex; align-items: center; gap: .4rem; color: var(--muted); font-size: .8rem; }
.theme-label select { padding: .42rem; }
.notice, .context-indicator { margin: .65rem 1rem 0; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); color: var(--muted); }
.chat-scroll { overflow-y: auto; padding: clamp(1rem, 4vw, 3rem) max(1rem, calc((100% - 850px) / 2)); }
.welcome { margin: 11vh auto 2rem; max-width: 680px; text-align: center; }
.welcome p:last-child { color: var(--muted); }
.messages { display: grid; gap: 1.2rem; }
.message { max-width: min(86%, 760px); padding: .85rem 1rem; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); }
.message[data-role="user"] { justify-self: end; background: var(--accent-soft); }
.message[data-role="assistant"] { justify-self: start; }
.message pre { overflow-x: auto; padding: .8rem; border-radius: 10px; background: var(--surface-soft); }
.message table, .artifact-table { width: 100%; border-collapse: collapse; }
.message th, .message td, .artifact-table th, .artifact-table td { padding: .55rem; border: 1px solid var(--line); text-align: left; }
.table-scroll, .artifact-table-scroll { overflow-x: auto; }
.math-display { overflow-x: auto; padding: .5rem 0; }
.activity-panel { max-height: 40dvh; overflow-y: auto; padding: .75rem max(1rem, calc((100% - 850px) / 2)); border-top: 1px solid var(--line); background: var(--surface-soft); }
.activity-panel header { display: flex; justify-content: space-between; }
.agent-plan, .agent-timeline { display: grid; gap: .35rem; padding-left: 1.4rem; }
.agent-artifacts { display: grid; gap: .75rem; }
.artifact-plot { display: block; width: 100%; max-height: 420px; }
.plot-grid { stroke: var(--line); }
.plot-axis { stroke: var(--muted); }
.plot-tick { fill: var(--muted); font-size: 11px; }
.artifact-legend { display: flex; flex-wrap: wrap; gap: .7rem; padding: 0; list-style: none; }
.artifact-swatch { display: inline-block; width: .7rem; height: .7rem; margin-right: .35rem; border-radius: 50%; }
.artifact-swatch-0 { background: #147d75; }
.artifact-swatch-1 { background: #4472ca; }
.artifact-swatch-2 { background: #c55c37; }
.artifact-swatch-3 { background: #8c5bbd; }
.artifact-swatch-4 { background: #73802d; }
.artifact-swatch-5 { background: #bb4f7b; }
.artifact-swatch-6 { background: #427f9e; }
.artifact-swatch-7 { background: #9b6b2f; }
.artifact-rejected { color: var(--danger); }
.composer { display: flex; gap: .75rem; align-items: end; padding: .8rem max(1rem, calc((100% - 850px) / 2)); border-top: 1px solid var(--line); background: var(--surface); }
.composer textarea { min-height: 48px; max-height: 180px; flex: 1; resize: vertical; padding: .75rem; }
.composer-actions { display: flex; gap: .4rem; }
.footer-note { margin: 0; padding: 0 max(1rem, calc((100% - 850px) / 2)) .6rem; text-align: center; background: var(--surface); }
.icon-button { display: none; }
.sidebar-scrim { display: none; }
.install-app { position: fixed; right: 1rem; bottom: 1rem; box-shadow: var(--shadow); }
.toast { position: fixed; left: 50%; bottom: 1rem; z-index: 8; transform: translateX(-50%); padding: .7rem 1rem; border-radius: 12px; background: var(--text); color: var(--surface); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
[hidden] { display: none !important; }
@media (max-width: 760px) {
  .app-view { grid-template-columns: 1fr; }
  .sidebar { position: fixed; left: 0; width: min(84vw, 310px); transform: translateX(-102%); transition: transform .18s ease; box-shadow: var(--shadow); }
  .sidebar[data-open="true"] { transform: translateX(0); }
  .sidebar-scrim { position: fixed; inset: 0; z-index: 3; display: block; border: 0; border-radius: 0; background: rgb(0 0 0 / 30%); }
  .icon-button { display: inline-grid; }
  .theme-label { display: none; }
  .topbar { gap: .45rem; }
  .mode-switch button { padding-inline: .55rem; }
  .composer { flex-direction: column; align-items: stretch; }
  .composer-actions { justify-content: flex-end; }
  .message { max-width: 94%; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
`;

export function createBrowserRuntimeConfig({
  sessionEndpoint = "/api/session",
  agentTransportEndpoint = "/api/transport",
} = {}) {
  return Object.freeze({
    sessionEndpoint: normalizedPath(sessionEndpoint, "sessionEndpoint"),
    agentTransportEndpoint: normalizedPath(agentTransportEndpoint, "agentTransportEndpoint"),
  });
}

export async function offerPasswordManagerSave(form, navigatorObject = globalThis.navigator) {
  if (!form || typeof form !== "object") throw new TypeError("login form is required");
  const PasswordCredentialConstructor = globalThis.PasswordCredential;
  if (typeof PasswordCredentialConstructor !== "function" || typeof navigatorObject?.credentials?.store !== "function") return false;
  const credential = new PasswordCredentialConstructor(form);
  await navigatorObject.credentials.store(credential);
  return true;
}

export function applyTheme(theme, {
  document = globalThis.document,
  storage = globalThis.localStorage,
} = {}) {
  if (!THEMES.has(theme)) throw new TypeError("theme must be bright, dark, or system");
  if (!document?.documentElement?.dataset) throw new TypeError("documentElement dataset is unavailable");
  document.documentElement.dataset.theme = theme;
  try { storage?.setItem("lazying-agent-theme", theme); } catch { /* Theme persistence is optional. */ }
  return theme;
}

export function restoreTheme({
  document = globalThis.document,
  storage = globalThis.localStorage,
} = {}) {
  let theme = "bright";
  try {
    const stored = storage?.getItem("lazying-agent-theme");
    if (THEMES.has(stored)) theme = stored;
  } catch { /* Bright remains the fail-safe default. */ }
  return applyTheme(theme, { document, storage });
}
