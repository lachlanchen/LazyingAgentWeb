import {
  assertBoundedString,
  assertExactKeys,
  assertIdentifier,
  assertInteger
} from './validation.js';
import {
  AGINTI_RPC_PATHS,
  rpcPathIsMutation,
  validateAgentRequest,
  validateIdempotencyKey
} from './web/aginti-protocol.js';
import { verifyStandaloneAssetMap } from './web/asset-map.js';
import {
  validateVisionAttachmentRequest,
  validateVisionAttachmentsRequest
} from './vision-attachment.js';
import { WEB_RELEASE_HEADER_NAME } from './web/web-release.js';

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,95}$/u;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; charset=utf-8)?$/u;
const HEADER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._~-]{16,160}$/u;
const EVENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CONTENT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_MESSAGE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ENCODED_PATH_PATTERN = /%(?:2e|2f|5c)/iu;
const ARTIFACT_CONTENT_TARGET_PATTERN = /^\/api\/agent\/artifacts\/(art_[A-Za-z0-9_-]{32,86})\/content(?:\?v=([A-Za-z0-9][A-Za-z0-9._~-]{0,95})(?:&download=(1))?)?$/u;

export const CLOUD_HTTP_LIMITS = Object.freeze({
  requestTargetBytes: 2_048,
  cookieBytes: 4_096,
  loginBodyBytes: 2_048,
  sessionBodyBytes: 64,
  chatBodyBytes: 72 * 1024,
  visionChatBodyBytes: 24 * 1024 * 1024,
  agentBodyBytes: 64 * 1024,
  agentVisionBodyBytes: 24 * 1024 * 1024,
  responseJsonBytes: 512 * 1024,
  connectorDeltaBytes: 16 * 1024,
  connectorOutputBytes: 64 * 1024,
  bodyTimeoutMs: 5_000,
  visionBodyTimeoutMs: 240_000,
  dependencyTimeoutMs: 30_000,
  jobAdmissionTimeoutMs: 120_000,
  jobTimeoutMs: 600_000,
  visionJobTimeoutMs: 600_000,
  sseLifetimeMs: 30_000,
  ssePollMs: 100,
  concurrentBodies: 64,
  concurrentBodiesPerSource: 4,
  concurrentLogins: 8,
  concurrentLoginsPerSource: 2,
  concurrentStreams: 8,
  concurrentStreamsPerSession: 2,
  loginAttemptsPerMinute: 6,
  directChatJobs: 1
});

export const SESSION_COOKIE_NAME = '__Host-lazying_session';
export const CSRF_COOKIE_NAME = '__Host-lazying_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const IDEMPOTENCY_HEADER_NAME = 'idempotency-key';
export const CLIENT_RELEASE_HEADER_NAME = WEB_RELEASE_HEADER_NAME;
// The standalone listener is loopback-only. Caddy must delete caller values and
// overwrite both assertions on every upstream request; they are never accepted
// from a non-loopback socket peer.
export const TRUSTED_CLIENT_ADDRESS_HEADER = 'x-lazying-client-address';
export const TRUSTED_PUBLIC_AUTHORITY_HEADER = 'x-lazying-public-authority';

export const CLOUD_ROUTES = Object.freeze({
  login: '/api/login',
  session: '/api/session',
  logout: '/api/logout',
  chatCapabilities: '/api/chat/capabilities',
  chatThreadsList: '/api/chat/threads/list',
  chatThreadsCreate: '/api/chat/threads/create',
  chatThreadsGet: '/api/chat/threads/get',
  chatThreadsDelete: '/api/chat/threads/delete',
  chatMessagesList: '/api/chat/messages/list',
  chatAttachmentsGet: '/api/chat/attachments/get',
  chatRunsStart: '/api/chat/runs/start',
  chatRunsStatus: '/api/chat/runs/status',
  chatRunsEvents: '/api/chat/runs/events',
  chatRunsCancel: '/api/chat/runs/cancel'
});

export const CHAT_POST_ROUTES = Object.freeze([
  CLOUD_ROUTES.chatCapabilities,
  CLOUD_ROUTES.chatThreadsList,
  CLOUD_ROUTES.chatThreadsCreate,
  CLOUD_ROUTES.chatThreadsGet,
  CLOUD_ROUTES.chatThreadsDelete,
  CLOUD_ROUTES.chatMessagesList,
  CLOUD_ROUTES.chatAttachmentsGet,
  CLOUD_ROUTES.chatRunsStart,
  CLOUD_ROUTES.chatRunsStatus,
  CLOUD_ROUTES.chatRunsEvents,
  CLOUD_ROUTES.chatRunsCancel
]);

export const CHAT_MUTATION_ROUTES = Object.freeze([
  CLOUD_ROUTES.chatThreadsCreate,
  CLOUD_ROUTES.chatThreadsDelete,
  CLOUD_ROUTES.chatRunsStart,
  CLOUD_ROUTES.chatRunsCancel
]);

export const AGENT_TRANSPORT_PREFIX = '/api/transport';
export const AGENT_ARTIFACT_CONTENT_PREFIX = '/api/agent/artifacts/';
export const AGENT_ROUTE_MAP = Object.freeze(Object.fromEntries(
  Object.values(AGINTI_RPC_PATHS).map((nativePath) => [`${AGENT_TRANSPORT_PREFIX}${nativePath}`, nativePath])
));

const DYNAMIC_POST_ROUTES = new Set([
  CLOUD_ROUTES.login,
  CLOUD_ROUTES.session,
  CLOUD_ROUTES.logout,
  ...CHAT_POST_ROUTES,
  ...Object.keys(AGENT_ROUTE_MAP)
]);
const CHAT_MUTATIONS = new Set(CHAT_MUTATION_ROUTES);

export class CloudHttpError extends Error {
  constructor(status, code, message, { retryAfter, cause } = {}) {
    super(message, { cause });
    this.name = 'CloudHttpError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function invalid(message = 'The request is invalid.') {
  throw new CloudHttpError(400, 'invalid_request', message);
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function exactObject(value, required, optional, name) {
  try {
    return assertExactKeys(value, { required, optional }, name);
  } catch (error) {
    throw new CloudHttpError(400, 'invalid_request', `${name} is invalid.`, { cause: error });
  }
}

function identifier(value, name) {
  try {
    return assertIdentifier(value, name);
  } catch (error) {
    throw new CloudHttpError(400, 'invalid_request', `${name} is invalid.`, { cause: error });
  }
}

function integer(value, name, limits) {
  try {
    return assertInteger(value, name, limits);
  } catch (error) {
    throw new CloudHttpError(400, 'invalid_request', `${name} is invalid.`, { cause: error });
  }
}

function text(value, name, {
  minimum = 1,
  maximum,
  trim = false,
  allowControl = false,
  allowMessageFormatting = false
} = {}) {
  if (typeof value !== 'string' || utf8Bytes(value) < minimum || utf8Bytes(value) > maximum) {
    invalid(`${name} is invalid.`);
  }
  if (!allowControl && (allowMessageFormatting
    ? UNSAFE_MESSAGE_CONTROL_PATTERN.test(value)
    : CONTROL_PATTERN.test(value))) invalid(`${name} is invalid.`);
  const result = trim ? value.trim() : value;
  if (trim && utf8Bytes(result) < minimum) invalid(`${name} is invalid.`);
  return result;
}

function cursor(revision, hash) {
  const checkedRevision = integer(revision, 'expectedRevision', { min: 0, max: 2_000 });
  if ((checkedRevision === 0 && hash !== null) || (checkedRevision > 0 && !EVENT_HASH_PATTERN.test(hash))) {
    invalid('The ledger cursor is invalid.');
  }
  return Object.freeze({ revision: checkedRevision, hash });
}

export function validateReleaseId(value) {
  if (typeof value !== 'string' || !RELEASE_ID_PATTERN.test(value)) {
    throw new TypeError('releaseId must be a portable immutable release identifier');
  }
  return value;
}

export function validatePublicOrigin(value) {
  if (typeof value !== 'string') throw new TypeError('publicOrigin is required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('publicOrigin must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function validateAccountConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('account must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, 'username') || !Object.hasOwn(value, 'principalId')) {
    throw new TypeError('account must contain only username and principalId');
  }
  let username;
  let principalId;
  try {
    username = assertBoundedString(value.username, 'username', { min: 1, max: 128 });
    principalId = assertIdentifier(value.principalId, 'principalId');
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(principalId)) {
      throw new TypeError('principalId must match the frozen LazyEdge opaque principal contract');
    }
  } catch (error) {
    throw new TypeError('account is invalid', { cause: error });
  }
  return Object.freeze({ username, principalId });
}

function validateDescriptor(route, descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError(`asset ${route} has no descriptor`);
  }
  if (typeof descriptor.contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(descriptor.contentType.toLowerCase())) {
    throw new TypeError(`asset ${route} has an invalid content type`);
  }
  if (typeof descriptor.cacheControl !== 'string' || descriptor.cacheControl.length > 160 || /[\r\n\u0000]/u.test(descriptor.cacheControl)) {
    throw new TypeError(`asset ${route} has an invalid cache policy`);
  }
  const body = typeof descriptor.body === 'string'
    ? Buffer.from(descriptor.body, 'utf8')
    : (descriptor.body instanceof Uint8Array ? Buffer.from(descriptor.body) : null);
  if (!body || body.byteLength < 1 || body.byteLength > 4 * 1024 * 1024) {
    throw new TypeError(`asset ${route} has an invalid body`);
  }
  const sourceHeaders = descriptor.headers ?? {};
  if (sourceHeaders === null || typeof sourceHeaders !== 'object' || Array.isArray(sourceHeaders)) {
    throw new TypeError(`asset ${route} has invalid headers`);
  }
  const headers = {};
  for (const [rawName, headerValue] of Object.entries(sourceHeaders)) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || typeof headerValue !== 'string' || /[\r\n\u0000]/u.test(headerValue)) {
      throw new TypeError(`asset ${route} has an invalid header`);
    }
    if (['set-cookie', 'content-length', 'content-type', 'cache-control', 'connection', 'transfer-encoding'].includes(name)) {
      throw new TypeError(`asset ${route} tries to control a reserved response header`);
    }
    headers[name] = headerValue;
  }
  return Object.freeze({
    contentType: descriptor.contentType,
    cacheControl: descriptor.cacheControl,
    headers: Object.freeze(headers),
    body
  });
}

function validateStaticTarget(target) {
  if (typeof target !== 'string' || target.length < 1 || utf8Bytes(target) > CLOUD_HTTP_LIMITS.requestTargetBytes) {
    throw new TypeError('asset route is invalid');
  }
  if (!target.startsWith('/') || target.includes('#') || target.includes('\\') || CONTROL_PATTERN.test(target) || ENCODED_PATH_PATTERN.test(target)) {
    throw new TypeError(`asset route ${target} is not normalized`);
  }
  const [pathname, ...queryParts] = target.split('?');
  if (queryParts.length > 1 || pathname.includes('//') || (pathname !== '/' && pathname.endsWith('/'))
      || pathname.split('/').some((part) => part === '.' || part === '..')) {
    throw new TypeError(`asset route ${target} is not normalized`);
  }
  if (queryParts.length === 1 && (!queryParts[0] || /[^A-Za-z0-9._~=&-]/u.test(queryParts[0]))) {
    throw new TypeError(`asset route ${target} has an unsafe query`);
  }
  return { pathname, hasQuery: queryParts.length === 1 };
}

function sourceProvesRelease(source, releaseId, kind) {
  const escaped = releaseId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (kind === 'html') {
    return new RegExp(`<meta\\s+name=["']lazying-agent-release["']\\s+content=["']${escaped}["']`, 'u').test(source)
      || new RegExp(`<meta\\s+content=["']${escaped}["']\\s+name=["']lazying-agent-release["']`, 'u').test(source);
  }
  return new RegExp(`(?:const\\s+VERSION\\s*=|release(?:Id|Version)\\s*:)\\s*["']${escaped}["']`, 'u').test(source);
}

export function snapshotAndValidateAssetMap(assetMap, releaseIdInput) {
  const releaseId = validateReleaseId(releaseIdInput);
  verifyStandaloneAssetMap(assetMap);
  if (!assetMap || !Array.isArray(assetMap.routes) || typeof assetMap.get !== 'function') {
    throw new TypeError('assetMap must provide exact routes and get()');
  }
  const declaredRelease = assetMap.releaseId ?? assetMap.releaseVersion;
  if (declaredRelease !== releaseId) throw new TypeError('assetMap release does not match releaseId');
  if (typeof assetMap.contentDigest !== 'string' || !CONTENT_DIGEST_PATTERN.test(assetMap.contentDigest)
      || !declaredRelease.includes(assetMap.contentDigest)) {
    throw new TypeError('assetMap release must contain its full content-derived SHA-256 digest');
  }
  if (typeof assetMap.releaseNamespace !== 'string'
      || !assetMap.releaseNamespace.endsWith(`/assets/r/${releaseId}`)
      || assetMap.releaseNamespace.includes('?')) {
    throw new TypeError('assetMap release namespace does not prove releaseId');
  }
  if (assetMap.serviceWorkerRoute !== '/sw.js') {
    throw new TypeError('assetMap must expose the current worker at stable /sw.js');
  }

  const routeSet = new Set();
  const descriptors = new Map();
  const versionedRootTarget = `/?v=${releaseId}`;
  const manifestTarget = `/manifest.webmanifest?v=${releaseId}`;
  for (const route of assetMap.routes) {
    const normalized = validateStaticTarget(route);
    if (routeSet.has(route)) throw new TypeError(`asset route ${route} is duplicated`);
    if (normalized.hasQuery && route !== manifestTarget && route !== versionedRootTarget) {
      throw new TypeError('only the exact release-bound root and manifest queries may be static asset targets');
    }
    routeSet.add(route);
    descriptors.set(route, validateDescriptor(route, assetMap.get(route)));
  }
  for (const required of ['/', versionedRootTarget, manifestTarget, '/sw.js']) {
    if (!descriptors.has(required)) throw new TypeError(`assetMap is missing ${required}`);
  }
  const root = descriptors.get('/');
  const versionedRoot = descriptors.get(versionedRootTarget);
  const worker = descriptors.get('/sw.js');
  if (!root.contentType.toLowerCase().startsWith('text/html')
      || !sourceProvesRelease(root.body.toString('utf8'), releaseId, 'html')) {
    throw new TypeError('root HTML does not prove releaseId');
  }
  if (versionedRoot.contentType !== root.contentType || versionedRoot.cacheControl !== root.cacheControl
      || JSON.stringify(versionedRoot.headers) !== JSON.stringify(root.headers)
      || !versionedRoot.body.equals(root.body)) {
    throw new TypeError('versioned root must exactly mirror the stable no-store shell');
  }
  if (!worker.contentType.toLowerCase().startsWith('text/javascript')
      || !sourceProvesRelease(worker.body.toString('utf8'), releaseId, 'worker')) {
    throw new TypeError('service worker does not prove releaseId');
  }
  const workerCache = worker.cacheControl.toLowerCase();
  if (!workerCache.includes('no-store') || !workerCache.includes('no-cache')) {
    throw new TypeError('/sw.js must be no-store and no-cache');
  }
  if (String(worker.headers.pragma ?? '').toLowerCase() !== 'no-cache' || worker.headers.expires !== '0') {
    throw new TypeError('/sw.js must disable intermediary caching');
  }
  for (const route of routeSet) {
    if (route.startsWith(`${assetMap.releaseNamespace}/`) && route.includes('?')) {
      throw new TypeError('immutable release assets must not contain a query');
    }
  }

  const immutableRoutes = new Set([
    ...[...routeSet].filter((route) => route.startsWith(`${assetMap.releaseNamespace}/`)),
    // The manifest target is exact-release-addressed just like the asset
    // namespace. A successor release necessarily uses a different URL, while
    // the stable root and worker remain the uncached discovery authorities.
    manifestTarget
  ]);
  return Object.freeze({
    releaseId,
    contentDigest: assetMap.contentDigest,
    releaseNamespace: assetMap.releaseNamespace,
    routes: Object.freeze([...routeSet]),
    has: (target) => descriptors.has(target),
    isImmutable: (target) => immutableRoutes.has(target),
    get(target) {
      const value = descriptors.get(target);
      if (!value) return undefined;
      return Object.freeze({
        contentType: value.contentType,
        cacheControl: value.cacheControl,
        headers: value.headers,
        body: Buffer.from(value.body)
      });
    }
  });
}

export function classifyRequestTarget(rawTarget, assets) {
  if (typeof rawTarget !== 'string' || rawTarget.length < 1 || utf8Bytes(rawTarget) > CLOUD_HTTP_LIMITS.requestTargetBytes
      || !rawTarget.startsWith('/') || rawTarget.includes('#') || rawTarget.includes('\\')
      || CONTROL_PATTERN.test(rawTarget) || ENCODED_PATH_PATTERN.test(rawTarget)) {
    return Object.freeze({ kind: 'invalid' });
  }
  if (assets.has(rawTarget)) return Object.freeze({ kind: 'asset', target: rawTarget });
  const artifactContent = ARTIFACT_CONTENT_TARGET_PATTERN.exec(rawTarget);
  if (artifactContent) {
    return Object.freeze({
      kind: 'agent_artifact',
      pathname: rawTarget,
      artifactId: artifactContent[1],
      releaseId: artifactContent[2] ?? null,
      download: artifactContent[3] === '1'
    });
  }
  if (rawTarget.startsWith(AGENT_ARTIFACT_CONTENT_PREFIX)) return Object.freeze({ kind: 'invalid' });
  if (rawTarget.includes('?')) return Object.freeze({ kind: 'invalid' });
  if (rawTarget.includes('//') || (rawTarget !== '/' && rawTarget.endsWith('/'))
      || rawTarget.split('/').some((part) => part === '.' || part === '..') || rawTarget.includes('%')) {
    return Object.freeze({ kind: 'invalid' });
  }
  if (DYNAMIC_POST_ROUTES.has(rawTarget)) {
    return Object.freeze({
      kind: Object.hasOwn(AGENT_ROUTE_MAP, rawTarget) ? 'agent' : (rawTarget.startsWith('/api/chat/') ? 'chat' : 'session'),
      pathname: rawTarget,
      nativeAgentPath: AGENT_ROUTE_MAP[rawTarget]
    });
  }
  return Object.freeze({ kind: 'not_found' });
}

export function bodyLimitForRoute(pathname) {
  if (pathname === CLOUD_ROUTES.login) return CLOUD_HTTP_LIMITS.loginBodyBytes;
  if (pathname === CLOUD_ROUTES.session || pathname === CLOUD_ROUTES.logout) return CLOUD_HTTP_LIMITS.sessionBodyBytes;
  if (pathname === CLOUD_ROUTES.chatRunsStart) return CLOUD_HTTP_LIMITS.visionChatBodyBytes;
  if (pathname.startsWith('/api/chat/')) return CLOUD_HTTP_LIMITS.chatBodyBytes;
  if (pathname === `${AGENT_TRANSPORT_PREFIX}${AGINTI_RPC_PATHS.runsStart}`
      || pathname === `${AGENT_TRANSPORT_PREFIX}${AGINTI_RPC_PATHS.runsResume}`) {
    return CLOUD_HTTP_LIMITS.agentVisionBodyBytes;
  }
  if (pathname.startsWith(`${AGENT_TRANSPORT_PREFIX}/agent/v1/`)) return CLOUD_HTTP_LIMITS.agentBodyBytes;
  throw new TypeError('route has no body limit');
}

export function routeRequiresIdempotency(pathname, nativeAgentPath) {
  return CHAT_MUTATIONS.has(pathname) || (nativeAgentPath !== undefined && rpcPathIsMutation(nativeAgentPath));
}

export function validateRequestIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new CloudHttpError(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required.');
  }
  return value;
}

export function validateLoginBody(value) {
  const body = exactObject(value, ['username', 'password', 'remember'], ['sessionMode'], 'login request');
  const username = text(body.username, 'username', { maximum: 128 });
  const password = text(body.password, 'password', { maximum: 1_024, allowControl: true });
  if (typeof body.remember !== 'boolean') invalid('remember is invalid.');
  if (body.sessionMode !== undefined && body.sessionMode !== 'ephemeral-memory') {
    invalid('sessionMode is invalid.');
  }
  return Object.freeze({
    username,
    password,
    remember: body.remember,
    ...(body.sessionMode === undefined ? {} : { sessionMode: body.sessionMode })
  });
}

export function validateEmptyBody(value, name = 'request') {
  exactObject(value, [], [], name);
  return Object.freeze({});
}

export function validateChatRequest(pathname, value) {
  switch (pathname) {
    case CLOUD_ROUTES.chatCapabilities:
      return validateEmptyBody(value, 'chat capabilities request');
    case CLOUD_ROUTES.chatThreadsList: {
      const body = exactObject(value, [], ['limit'], 'chat thread list');
      return Object.freeze({ limit: integer(body.limit ?? 50, 'limit', { min: 1, max: 200 }) });
    }
    case CLOUD_ROUTES.chatThreadsCreate: {
      const body = exactObject(value, ['threadId'], ['title'], 'chat thread creation');
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        title: text(body.title ?? '', 'title', { minimum: 0, maximum: 512 })
      });
    }
    case CLOUD_ROUTES.chatThreadsGet: {
      const body = exactObject(value, ['threadId'], [], 'chat thread lookup');
      return Object.freeze({ threadId: identifier(body.threadId, 'threadId') });
    }
    case CLOUD_ROUTES.chatThreadsDelete: {
      const body = exactObject(
        value,
        ['threadId', 'expectedRevision', 'expectedHash'],
        [],
        'chat thread deletion'
      );
      const expected = cursor(body.expectedRevision, body.expectedHash);
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        expectedRevision: expected.revision,
        expectedHash: expected.hash
      });
    }
    case CLOUD_ROUTES.chatMessagesList: {
      const body = exactObject(value, ['threadId'], ['afterRevision', 'limit', 'attachmentSchema'], 'chat message list');
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        afterRevision: integer(body.afterRevision ?? 0, 'afterRevision', { min: 0, max: 2_000 }),
        limit: integer(body.limit ?? 100, 'limit', { min: 1, max: 200 }),
        attachmentSchema: integer(body.attachmentSchema ?? 1, 'attachmentSchema', { min: 1, max: 2 })
      });
    }
    case CLOUD_ROUTES.chatAttachmentsGet: {
      const body = exactObject(value, ['threadId', 'attachmentId'], [], 'chat attachment lookup');
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        attachmentId: identifier(body.attachmentId, 'attachmentId')
      });
    }
    case CLOUD_ROUTES.chatRunsStart: {
      const body = exactObject(value, [
        'threadId', 'messageId', 'generationId', 'assistantMessageId',
        'content', 'expectedRevision', 'expectedHash'
      ], ['attachment', 'attachments'], 'chat run start');
      const expected = cursor(body.expectedRevision, body.expectedHash);
      const normalized = {
        threadId: identifier(body.threadId, 'threadId'),
        messageId: identifier(body.messageId, 'messageId'),
        generationId: identifier(body.generationId, 'generationId'),
        assistantMessageId: identifier(body.assistantMessageId, 'assistantMessageId'),
        content: text(body.content, 'content', {
          maximum: 64 * 1024,
          trim: true,
          allowMessageFormatting: true
        }),
        expectedRevision: expected.revision,
        expectedHash: expected.hash
      };
      if (body.attachment !== undefined && body.attachments !== undefined) {
        throw new CloudHttpError(400, 'invalid_attachment', 'Use either attachment or attachments, not both.');
      }
      let attachments;
      if (body.attachments !== undefined) {
        try {
          attachments = validateVisionAttachmentsRequest(body.attachments);
        } catch (error) {
          throw new CloudHttpError(400, 'invalid_attachment', 'The image attachments are invalid.', { cause: error });
        }
      } else if (body.attachment !== undefined) {
        try {
          attachments = Object.freeze([validateVisionAttachmentRequest(body.attachment)]);
        } catch (error) {
          throw new CloudHttpError(400, 'invalid_attachment', 'The image attachment is invalid.', { cause: error });
        }
      }
      return Object.freeze({
        ...normalized,
        ...(attachments === undefined ? {} : { attachments })
      });
    }
    case CLOUD_ROUTES.chatRunsStatus: {
      const body = exactObject(value, ['threadId', 'generationId'], [], 'chat run status');
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        generationId: identifier(body.generationId, 'generationId')
      });
    }
    case CLOUD_ROUTES.chatRunsEvents: {
      const body = exactObject(value, ['threadId', 'generationId'], ['afterSequence'], 'chat run events');
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        generationId: identifier(body.generationId, 'generationId'),
        afterSequence: integer(body.afterSequence ?? 0, 'afterSequence', { min: 0, max: 8_192 })
      });
    }
    case CLOUD_ROUTES.chatRunsCancel: {
      const body = exactObject(value, ['threadId', 'generationId'], [], 'chat run cancellation');
      return Object.freeze({
        threadId: identifier(body.threadId, 'threadId'),
        generationId: identifier(body.generationId, 'generationId')
      });
    }
    default:
      throw new CloudHttpError(404, 'not_found', 'The requested route does not exist.');
  }
}

export function validateTransportAgentRequest(nativePath, value) {
  try {
    return validateAgentRequest(nativePath, value);
  } catch (error) {
    throw new CloudHttpError(
      error?.code === 'NOT_FOUND' ? 404 : 400,
      error?.code === 'NOT_FOUND' ? 'not_found' : 'invalid_agent_request',
      error?.code === 'NOT_FOUND' ? 'The requested route does not exist.' : 'The Agent request is invalid.',
      { cause: error }
    );
  }
}

export function validateAgentIdempotencyKey(value) {
  try {
    return validateIdempotencyKey(value);
  } catch (error) {
    throw new CloudHttpError(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required.', { cause: error });
  }
}
