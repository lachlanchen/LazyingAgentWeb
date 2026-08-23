import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { init as initializeEsmLexer, parse as parseEsm } from "es-module-lexer";

import {
  AGENT_WEB_GENERATOR_VERSION,
  AGENT_WEB_KATEX_VERSION,
  AGENT_WEB_MODULE_ROUTES,
  AGENT_WEB_RELEASE_ROOT,
  BRIGHT_APP_CSS,
  agentWebBuildQuery,
  agentWebCacheName,
  agentWebScopeIdentity,
  createAppShellHtml,
  createPwaIcon,
  createPwaManifest,
  createServiceWorkerSource,
  normalizeAgentWebBasePath,
  versionedAgentWebAsset,
} from "./pwa-assets.js";

export const AGENT_WEB_ESM_LEXER_VERSION = "2.3.1";
export const STANDALONE_ROOT_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'self'";
export const STANDALONE_SHELL_SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
});

const PLACEHOLDER_DIGEST = "0".repeat(64);
const PLACEHOLDER_RELEASE = `r-${PLACEHOLDER_DIGEST}`;
const KATEX_MODULE_URL = new URL(import.meta.resolve("katex/dist/katex.mjs"));
const KATEX_PACKAGE_URL = new URL(import.meta.resolve("katex/package.json"));
const ESM_LEXER_MODULE_URL = new URL(import.meta.resolve("es-module-lexer"));
const ESM_LEXER_PACKAGE_URL = new URL("../package.json", ESM_LEXER_MODULE_URL);
const GENERATOR_URL = new URL(import.meta.url);
const utf8 = new TextEncoder();
const assetMapBrand = new WeakSet();
const assetMapConstructorToken = Object.freeze({});

function codeUnitCompare(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

const LOCAL_MODULES = Object.freeze({
  "/assets/browser-app.js": new URL("./browser-app.js", import.meta.url),
  "/assets/cloud-session-client.js": new URL("./cloud-session-client.js", import.meta.url),
  "/assets/direct-chat-client.js": new URL("./direct-chat-client.js", import.meta.url),
  "/assets/vision-image-client.js": new URL("./vision-image-client.js", import.meta.url),
  "/assets/vision-image-sanitizer.js": new URL("./vision-image-sanitizer.js", import.meta.url),
  "/assets/aginti-client.js": new URL("./aginti-client.js", import.meta.url),
  "/assets/aginti-protocol.js": new URL("./aginti-protocol.js", import.meta.url),
  "/assets/presentation-state.js": new URL("./presentation-state.js", import.meta.url),
  "/assets/pwa-assets.js": new URL("./pwa-assets.js", import.meta.url),
  "/assets/safe-rendering.js": new URL("./safe-rendering.js", import.meta.url),
});

function exactOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("asset map options must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["bootstrapSource", "katexSource", "versionLabel", "basePath", "title", "loginPath", "name", "shortName"]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError("asset map options contain an unsupported field or accessor");
    }
  }
  return value;
}

function source(value, name, maximum = 2 * 1024 * 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\u0000/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function releaseLabel(value) {
  if (value === undefined) return "r";
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,23}$/u.test(value)) {
    throw new TypeError("versionLabel must be a portable 1-24 character label");
  }
  return value;
}

function frozenHeaders(headers = {}) {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)
      || Object.getPrototypeOf(headers) !== Object.prototype) throw new TypeError("asset headers are invalid");
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || typeof value !== "string" || /[\r\n\u0000]/u.test(value)) {
      throw new TypeError("asset header is invalid");
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

function descriptor(contentType, body, {
  cacheControl = "no-store",
  headers = {},
} = {}) {
  if (typeof contentType !== "string" || !/^[a-z]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/u.test(contentType)) {
    throw new TypeError("asset contentType is invalid");
  }
  if (typeof body !== "string" && !(body instanceof Uint8Array)) throw new TypeError("asset body is invalid");
  return Object.freeze({
    contentType,
    cacheControl,
    headers: frozenHeaders(headers),
    body: body instanceof Uint8Array ? body.slice() : body,
  });
}

function cloneDescriptor(value) {
  return Object.freeze({
    contentType: value.contentType,
    cacheControl: value.cacheControl,
    headers: Object.freeze({ ...value.headers }),
    body: value.body instanceof Uint8Array ? value.body.slice() : value.body,
  });
}

function bodyBytes(body) {
  return body instanceof Uint8Array ? body : utf8.encode(body);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEntryRecords(entries) {
  return entries.map(([route, value]) => ({
    route,
    contentType: value.contentType,
    cacheControl: value.cacheControl,
    headers: Object.fromEntries(Object.entries(value.headers).sort(([left], [right]) => codeUnitCompare(left, right))),
    size: bodyBytes(value.body).byteLength,
    bodySha256: sha256(bodyBytes(value.body)),
  })).sort((left, right) => codeUnitCompare(left.route, right.route));
}

function digestEntrySet(entries, extra = {}) {
  return sha256(utf8.encode(JSON.stringify({
    schemaVersion: "1",
    entries: canonicalEntryRecords(entries),
    extra,
  })));
}

function canonicalMime(contentType) {
  return contentType.toLowerCase().split(";", 1)[0].trim();
}

function shellIntegrity(entries) {
  return Object.freeze(entries.map(([url, value]) => Object.freeze({
    url,
    contentType: canonicalMime(value.contentType),
    headers: Object.freeze(Object.fromEntries(Object.entries(value.headers).sort(([left], [right]) => codeUnitCompare(left, right)))),
    sha256: sha256(bodyBytes(value.body)),
    size: bodyBytes(value.body).byteLength,
  })));
}

async function moduleSpecifiers(value, name) {
  let imports;
  try {
    await initializeEsmLexer;
    [imports] = await parseEsm(value, name);
  } catch {
    throw new TypeError(`${name} is not valid ECMAScript module source`);
  }
  if (!Array.isArray(imports)) throw new TypeError(`${name} could not be lexed safely`);
  const results = [];
  for (const entry of imports) {
    if (entry === null || typeof entry !== "object" || !Number.isSafeInteger(entry.s) || !Number.isSafeInteger(entry.e)
        || !Number.isSafeInteger(entry.d) || entry.s < 0 || entry.e < entry.s || entry.e > value.length) {
      throw new TypeError(`${name} contains an invalid module-lexer record`);
    }
    if (entry.d === -2) continue;
    if (typeof entry.n !== "string") throw new TypeError(`${name} contains a non-literal dynamic import`);
    if (entry.n.length < 1 || entry.n.length > 512) throw new TypeError(`${name} contains an invalid module specifier`);
    results.push(entry.n);
  }
  return Object.freeze([...new Set(results)]);
}

function resolveModuleDependency(importerRoute, specifier, releaseNamespace) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new TypeError(`${importerRoute} contains a non-relative module import`);
  }
  if (/[\\?#\u0000-\u001f\u007f]/u.test(specifier) || /%(?:2e|2f|5c)/iu.test(specifier)) {
    throw new TypeError(`${importerRoute} contains a version-ambiguous module import`);
  }
  const resolved = new URL(specifier, `https://assets.invalid${importerRoute}`);
  if (resolved.origin !== "https://assets.invalid" || !resolved.pathname.startsWith(`${releaseNamespace}/`)) {
    throw new TypeError(`${importerRoute} imports outside its immutable release namespace`);
  }
  return resolved.pathname;
}

async function validateModuleGraph(entries, entryRoute, expectedRoutes, releaseNamespace) {
  const modules = new Map(entries.filter(([, value]) => canonicalMime(value.contentType) === "text/javascript"));
  const dependencies = new Map();
  for (const [route, value] of modules) {
    const imports = (await moduleSpecifiers(value.body, route))
      .map((specifier) => resolveModuleDependency(route, specifier, releaseNamespace));
    for (const dependency of imports) {
      if (!modules.has(dependency)) throw new TypeError(`${route} imports missing immutable module ${dependency}`);
    }
    dependencies.set(route, imports);
  }
  const visited = new Set();
  const queue = [entryRoute];
  while (queue.length) {
    const route = queue.shift();
    if (visited.has(route)) continue;
    if (!modules.has(route)) throw new TypeError(`PWA module entry is missing: ${route}`);
    visited.add(route);
    queue.push(...(dependencies.get(route) ?? []));
  }
  const unreachable = expectedRoutes.filter((route) => !visited.has(route));
  if (unreachable.length) throw new TypeError(`PWA bootstrap does not reach modules: ${unreachable.join(", ")}`);
  return Object.freeze([...visited].sort(codeUnitCompare));
}

function buildShellEntries({
  releaseVersion,
  basePath,
  title,
  loginPath,
  name,
  shortName,
  bootstrap,
  katex,
  localModules,
}) {
  const scope = normalizeAgentWebBasePath(basePath);
  const base = scope === "/" ? "" : scope.slice(0, -1);
  const versioned = (route) => `${base}${versionedAgentWebAsset(route, releaseVersion)}`;
  const manifest = createPwaManifest({ basePath: scope, name, shortName, version: releaseVersion });
  const secured = (contentType, body, headers = {}) => descriptor(contentType, body, {
    headers: { ...STANDALONE_SHELL_SECURITY_HEADERS, ...headers },
  });
  const root = secured("text/html; charset=utf-8", createAppShellHtml({ basePath: scope, title, loginPath, version: releaseVersion }), {
    "content-security-policy": STANDALONE_ROOT_CONTENT_SECURITY_POLICY,
  });
  return [
    [scope, root],
    [`${scope}${agentWebBuildQuery(releaseVersion)}`, root],
    [`${base}/manifest.webmanifest${agentWebBuildQuery(releaseVersion)}`, secured("application/manifest+json; charset=utf-8", `${JSON.stringify(manifest)}\n`)],
    [versioned("/assets/app.css"), secured("text/css; charset=utf-8", BRIGHT_APP_CSS)],
    [versioned("/assets/app.js"), secured("text/javascript; charset=utf-8", bootstrap)],
    [versioned("/assets/katex.mjs"), secured("text/javascript; charset=utf-8", katex)],
    [versioned("/assets/icon-192.png"), secured("image/png", createPwaIcon(192))],
    [versioned("/assets/icon-512.png"), secured("image/png", createPwaIcon(512))],
    ...localModules.map(([route, moduleSource]) => [
      versioned(route),
      secured("text/javascript; charset=utf-8", moduleSource),
    ]),
  ];
}

function workerDescriptor(body) {
  return descriptor("text/javascript; charset=utf-8", body, {
    cacheControl: "no-store, no-cache, must-revalidate",
    headers: { pragma: "no-cache", expires: "0" },
  });
}

function checkedMapMetadata(value) {
  const keys = [
    "releaseVersion", "contentDigest", "finalMapDigest", "finalDigestContext", "generatorVersion", "moduleLexerVersion",
    "basePath", "scopeIdentity", "cacheName", "buildQuery", "releaseNamespace", "serviceWorkerRoute", "shellRoutes", "moduleRoutes",
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort(codeUnitCompare).join("\u0000") !== [...keys].sort(codeUnitCompare).join("\u0000")) {
    throw new TypeError("asset map metadata is invalid");
  }
  for (const key of ["contentDigest", "finalMapDigest"]) {
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key])) throw new TypeError(`asset map ${key} is invalid`);
  }
  for (const key of ["releaseVersion", "generatorVersion", "moduleLexerVersion", "basePath", "scopeIdentity", "cacheName", "buildQuery", "releaseNamespace", "serviceWorkerRoute"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new TypeError(`asset map ${key} is invalid`);
  }
  if (!Array.isArray(value.shellRoutes) || !Array.isArray(value.moduleRoutes)
      || [...value.shellRoutes, ...value.moduleRoutes].some((route) => typeof route !== "string" || !route.startsWith("/"))) {
    throw new TypeError("asset map route metadata is invalid");
  }
  const context = value.finalDigestContext;
  if (context === null || typeof context !== "object" || Array.isArray(context)
      || Object.keys(context).sort(codeUnitCompare).join("\u0000") !== ["contentDigest", "esmLexerSourceSha256", "esmLexerVersion", "generatorVersion", "katexVersion"].sort(codeUnitCompare).join("\u0000")
      || context.contentDigest !== value.contentDigest || context.generatorVersion !== value.generatorVersion
      || context.esmLexerVersion !== value.moduleLexerVersion || context.katexVersion !== AGENT_WEB_KATEX_VERSION
      || typeof context.esmLexerSourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(context.esmLexerSourceSha256)) {
    throw new TypeError("asset map final digest context is invalid");
  }
  return value;
}

class StandalonePwaAssetMap {
  #entries;

  constructor(token, entries, metadata) {
    if (token !== assetMapConstructorToken) throw new TypeError("Standalone PWA asset maps can only be created by the production factory");
    checkedMapMetadata(metadata);
    this.#entries = new Map(entries.map(([route, value]) => [route, cloneDescriptor(value)]));
    this.routes = Object.freeze([...this.#entries.keys()].sort(codeUnitCompare));
    for (const [key, value] of Object.entries(metadata)) this[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
    assetMapBrand.add(this);
    Object.freeze(this);
  }

  has(requestTarget) { return this.#entries.has(requestTarget); }

  get(requestTarget) {
    const value = this.#entries.get(requestTarget);
    return value === undefined ? undefined : cloneDescriptor(value);
  }
}

Object.freeze(StandalonePwaAssetMap.prototype);

function snapshotEntries(assetMap) {
  return assetMap.routes.map((route) => {
    const value = assetMap.get(route);
    if (!value) throw new TypeError(`PWA asset ${route} is missing`);
    return [route, value];
  });
}

export function verifyStandaloneAssetMap(assetMap) {
  if (!(assetMap instanceof StandalonePwaAssetMap) || !assetMapBrand.has(assetMap)) throw new TypeError("assetMap is not a factory-authenticated map");
  if (typeof assetMap.contentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(assetMap.contentDigest)
      || !assetMap.releaseVersion.endsWith(`-${assetMap.contentDigest}`)) {
    throw new TypeError("PWA release is not bound to its content digest");
  }
  if (assetMap.scopeIdentity !== agentWebScopeIdentity(assetMap.basePath)
      || assetMap.cacheName !== agentWebCacheName(assetMap.releaseVersion, { basePath: assetMap.basePath })) {
    throw new TypeError("PWA cache identity is not bound to its normalized scope");
  }
  const versionedRoot = `${assetMap.basePath}${agentWebBuildQuery(assetMap.releaseVersion)}`;
  if (!assetMap.has(versionedRoot)) throw new TypeError("PWA versioned navigation route is missing");
  for (const route of assetMap.shellRoutes) if (!assetMap.has(route)) throw new TypeError(`PWA shell route is missing: ${route}`);
  const worker = assetMap.get(assetMap.serviceWorkerRoute);
  if (!worker || worker.cacheControl !== "no-store, no-cache, must-revalidate"
      || worker.headers.pragma !== "no-cache" || worker.headers.expires !== "0") {
    throw new TypeError("service worker response must disable intermediary caching");
  }
  const entries = snapshotEntries(assetMap);
  if (digestEntrySet(entries, assetMap.finalDigestContext) !== assetMap.finalMapDigest) {
    throw new TypeError("PWA final map digest verification failed");
  }
  return assetMap;
}

export const validateStandaloneAssetMap = verifyStandaloneAssetMap;

export async function createStandaloneAssetMap(options = {}) {
  const input = exactOptions(options);
  const bootstrap = source(input.bootstrapSource, "bootstrapSource", 512 * 1024);
  const basePath = normalizeAgentWebBasePath(input.basePath ?? "/");
  const label = releaseLabel(input.versionLabel);
  const title = input.title ?? "LazyingArt Agent";
  const loginPath = input.loginPath ?? "/api/login";
  const name = input.name ?? "LazyingArt Agent";
  const shortName = input.shortName ?? "Lazying Agent";
  const [installedKatex, katexPackageText, generatorSource, esmLexerSource, esmLexerPackageText, ...moduleTexts] = await Promise.all([
    readFile(KATEX_MODULE_URL, "utf8"),
    readFile(KATEX_PACKAGE_URL, "utf8"),
    readFile(GENERATOR_URL, "utf8"),
    readFile(ESM_LEXER_MODULE_URL, "utf8"),
    readFile(ESM_LEXER_PACKAGE_URL, "utf8"),
    ...Object.values(LOCAL_MODULES).map((url) => readFile(url, "utf8")),
  ]);
  const katexPackage = JSON.parse(katexPackageText);
  const esmLexerPackage = JSON.parse(esmLexerPackageText);
  if (katexPackage.version !== AGENT_WEB_KATEX_VERSION) throw new TypeError(`installed KaTeX must be exactly ${AGENT_WEB_KATEX_VERSION}`);
  if (esmLexerPackage.version !== AGENT_WEB_ESM_LEXER_VERSION) throw new TypeError(`installed es-module-lexer must be exactly ${AGENT_WEB_ESM_LEXER_VERSION}`);
  if (input.katexSource !== undefined && source(input.katexSource, "katexSource") !== installedKatex) {
    throw new TypeError(`katexSource must exactly match installed pinned KaTeX ${AGENT_WEB_KATEX_VERSION}`);
  }
  const katex = installedKatex;
  const localModules = Object.keys(LOCAL_MODULES).map((route, index) => [route, source(moduleTexts[index], route)]);
  const placeholderShell = buildShellEntries({
    releaseVersion: PLACEHOLDER_RELEASE,
    basePath,
    title,
    loginPath,
    name,
    shortName,
    bootstrap,
    katex,
    localModules,
  });
  const base = basePath === "/" ? "" : basePath.slice(0, -1);
  const placeholderWorker = createServiceWorkerSource({
    basePath,
    version: PLACEHOLDER_RELEASE,
    contentDigest: PLACEHOLDER_DIGEST,
    shellAssets: shellIntegrity(placeholderShell),
  });
  const templateEntries = [...placeholderShell, [`${base}/sw.js`, workerDescriptor(placeholderWorker)]];
  const templateContext = Object.freeze({
    generatorVersion: AGENT_WEB_GENERATOR_VERSION,
    generatorSourceSha256: sha256(utf8.encode(generatorSource)),
    esmLexerVersion: AGENT_WEB_ESM_LEXER_VERSION,
    esmLexerSourceSha256: sha256(utf8.encode(esmLexerSource)),
    katexVersion: AGENT_WEB_KATEX_VERSION,
  });
  const contentDigest = digestEntrySet(templateEntries, templateContext);
  const releaseVersion = `${label}-${contentDigest}`;
  const shellEntries = buildShellEntries({ releaseVersion, basePath, title, loginPath, name, shortName, bootstrap, katex, localModules });
  const versioned = (route) => `${base}${versionedAgentWebAsset(route, releaseVersion)}`;
  const releaseNamespace = `${base}${AGENT_WEB_RELEASE_ROOT}/${encodeURIComponent(releaseVersion)}`;
  const expectedModuleRoutes = AGENT_WEB_MODULE_ROUTES.map(versioned);
  const reachableModules = await validateModuleGraph(shellEntries, versioned("/assets/app.js"), expectedModuleRoutes, releaseNamespace);
  const serviceWorkerRoute = `${base}/sw.js`;
  const shellRoutes = shellEntries.map(([route]) => route);
  const worker = createServiceWorkerSource({
    basePath,
    version: releaseVersion,
    contentDigest,
    shellAssets: shellIntegrity(shellEntries),
  });
  const entries = [...shellEntries, [serviceWorkerRoute, workerDescriptor(worker)]];
  const finalDigestContext = Object.freeze({
    contentDigest,
    generatorVersion: AGENT_WEB_GENERATOR_VERSION,
    esmLexerVersion: AGENT_WEB_ESM_LEXER_VERSION,
    esmLexerSourceSha256: sha256(utf8.encode(esmLexerSource)),
    katexVersion: AGENT_WEB_KATEX_VERSION,
  });
  const finalMapDigest = digestEntrySet(entries, finalDigestContext);
  const map = new StandalonePwaAssetMap(assetMapConstructorToken, entries, {
    releaseVersion,
    contentDigest,
    finalMapDigest,
    finalDigestContext,
    generatorVersion: AGENT_WEB_GENERATOR_VERSION,
    moduleLexerVersion: AGENT_WEB_ESM_LEXER_VERSION,
    basePath,
    scopeIdentity: agentWebScopeIdentity(basePath),
    cacheName: agentWebCacheName(releaseVersion, { basePath }),
    buildQuery: agentWebBuildQuery(releaseVersion),
    releaseNamespace,
    serviceWorkerRoute,
    shellRoutes,
    moduleRoutes: reachableModules,
  });
  for (const logicalRoute of ["/assets/app.css", ...AGENT_WEB_MODULE_ROUTES, "/assets/icon-192.png", "/assets/icon-512.png"]) {
    if (map.has(`${base}${logicalRoute}`)) throw new TypeError("unversioned release asset leaked into the map");
  }
  return verifyStandaloneAssetMap(map);
}
