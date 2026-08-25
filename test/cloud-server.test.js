import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProbeServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DirectChatStore } from '../src/chat-store.js';
import { DirectChatContextCoordinator } from '../src/chat-context.js';
import { createAgintiAgentAdapter } from '../src/aginti-adapter.js';
import { createCloudServer, resolveTrustedClientAddress } from '../src/cloud-server.js';
import { CLIENT_RELEASE_HEADER_NAME, CLOUD_HTTP_LIMITS } from '../src/http-contract.js';
import { CloudIndexStore } from '../src/store.js';
import { canonicalJson } from '../src/web/aginti-protocol.js';
import { createStandaloneAssetMap } from '../src/web/asset-map.js';
import { createPwaIcon } from '../src/web/pwa-assets.js';

const TEST_BOOTSTRAP = `
import './browser-app.js';
import './aginti-client.js';
import './aginti-protocol.js';
import './presentation-state.js';
import './pwa-assets.js';
import './safe-rendering.js';
import './katex.mjs';
`;
const OFFICIAL_ASSET_MAP = await createStandaloneAssetMap({
  bootstrapSource: TEST_BOOTSTRAP,
  versionLabel: 'test'
});
const RELEASE_ID = OFFICIAL_ASSET_MAP.releaseVersion;
const PUBLIC_ORIGIN = 'https://llm.test';
const USERNAME = 'lachlanchen';
const PASSWORD = 'correct horse battery staple';
const PRINCIPAL_ID = 'principal_account_one';
const IDEMPOTENCY = 'browser-action-00000001';

function appendLedgerEvent(ledger, type, payload, createdAt) {
  const seq = ledger.lastEventSeq + 1;
  const previousHash = ledger.lastEventHash || '0'.repeat(64);
  const envelope = {
    schemaVersion: '1',
    id: `${ledger.id}.${seq}`,
    seq,
    type,
    threadId: ledger.threadId,
    runId: ledger.id,
    createdAt,
    payload,
    previousHash
  };
  const event = Object.freeze({
    ...envelope,
    hash: createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex')
  });
  ledger.events.push(event);
  ledger.lastEventSeq = event.seq;
  ledger.lastEventHash = event.hash;
  return event;
}

async function reserveLoopbackPort() {
  const probe = createProbeServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function publicOriginFor(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = 'https:';
  return url.origin;
}

function testState(t, { connector, adapter, limits, visionEnabled = false, requestOutcomeObserver } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-cloud-server-test-'));
  const controlStore = new CloudIndexStore({ databasePath: join(root, 'control', 'index.sqlite') });
  const directChatStore = new DirectChatStore({
    databasePath: join(root, 'chat', 'chat.sqlite'),
    modelAlias: 'local-test',
    enableVisionAttachments: visionEnabled
  });
  const directChatContext = new DirectChatContextCoordinator({
    store: directChatStore,
    maxContextBytes: 512 * 1024,
    contextWindowTokens: 600_000,
    outputTokenReserve: 64_000,
    protocolTokenReserve: 32_000,
    minimumRecentTurns: 4
  });
  controlStore.provisionAccount({
    accountId: PRINCIPAL_ID,
    issuer: 'local-login',
    subject: USERNAME,
    displayName: 'Lachlan',
    idempotencyKey: 'account-provision-00000001'
  });
  const options = {
    releaseId: RELEASE_ID,
    assetMap: OFFICIAL_ASSET_MAP,
    publicOrigin: PUBLIC_ORIGIN,
    account: { username: USERNAME, principalId: PRINCIPAL_ID },
    passwordVerifier: Object.freeze({
      algorithm: 'scrypt',
      async verify(password) { return password === PASSWORD; }
    }),
    sessionStore: controlStore,
    controlStore,
    directChatStore,
    directChatContext,
    directChatConnector: connector,
    visionEnabled,
    agintiAdapter: adapter,
    requestOutcomeObserver,
    limits
  };
  const servers = new Set();
  const additionalStores = new Set();
  async function start(overrides = {}) {
    const port = await reserveLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const publicOrigin = publicOriginFor(baseUrl);
    const server = createCloudServer({ ...options, ...overrides, publicOrigin });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    servers.add(server);
    return { server, baseUrl, publicOrigin };
  }
  async function stop(server) {
    if (!servers.delete(server) || !server.listening) return;
    if (typeof server.shutdown === 'function') {
      await server.shutdown();
      return;
    }
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
  t.after(async () => {
    for (const server of servers) await stop(server);
    for (const store of additionalStores) store.close();
    directChatStore.close();
    controlStore.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    controlStore,
    directChatStore,
    options,
    start,
    stop,
    registerStore(store) {
      additionalStores.add(store);
      return store;
    }
  };
}

function publicBoundary(baseUrl, clientAddress = '203.0.113.10') {
  return {
    'x-lazying-public-authority': new URL(publicOriginFor(baseUrl)).host,
    'x-lazying-client-address': clientAddress
  };
}

function fetchMetadata(baseUrl, extra = {}, clientAddress) {
  return {
    ...publicBoundary(baseUrl, clientAddress),
    origin: publicOriginFor(baseUrl),
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...extra
  };
}

async function post(baseUrl, pathname, body, {
  cookie,
  csrf,
  idempotency,
  headers = {},
  signal,
  clientAddress,
  fetchMetadataPresent = true
} = {}) {
  const requestHeaders = (fetchMetadataPresent ? fetchMetadata : ((url, extra, address) => ({
    ...publicBoundary(url, address),
    origin: publicOriginFor(url),
    ...extra
  })))(baseUrl, {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    ...(idempotency ? { 'idempotency-key': idempotency } : {}),
    ...headers
  }, clientAddress);
  const serialized = JSON.stringify(body);
  if (!fetchMetadataPresent) {
    const target = new URL(baseUrl);
    return await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: pathname,
        method: 'POST',
        headers: { ...requestHeaders, 'content-length': String(Buffer.byteLength(serialized, 'utf8')) }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: responseHeaders
          }));
        });
      });
      request.once('error', reject);
      request.end(serialized);
    });
  }
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: requestHeaders,
    body: serialized
  });
}

async function artifactRequest(baseUrl, artifactId, {
  method = 'GET',
  cookie,
  range,
  release,
  urlRelease = RELEASE_ID,
  download = false,
  headers = {},
  fetchMetadataPresent = true
} = {}) {
  const target = new URL(`/api/agent/artifacts/${artifactId}/content`, baseUrl);
  if (urlRelease !== null) {
    target.search = `?v=${encodeURIComponent(urlRelease)}${download ? '&download=1' : ''}`;
  }
  return fetch(target, {
    method,
    redirect: 'error',
    headers: {
      ...publicBoundary(baseUrl),
      ...(fetchMetadataPresent ? {
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty'
      } : {}),
      ...(cookie ? { cookie } : {}),
      ...(range ? { range } : {}),
      ...(release ? { [CLIENT_RELEASE_HEADER_NAME]: release } : {}),
      ...headers
    }
  });
}

function responseCookies(response) {
  const values = response.headers.getSetCookie?.() ?? [];
  return values.length > 0 ? values : [response.headers.get('set-cookie')].filter(Boolean);
}

function cookiePair(value) {
  return value.split(';', 1)[0];
}

async function login(baseUrl, { password = PASSWORD, clientAddress, fetchMetadataPresent = true } = {}) {
  const response = await post(baseUrl, '/api/login', { username: USERNAME, password, remember: true }, {
    clientAddress,
    fetchMetadataPresent
  });
  const value = await response.json();
  if (!response.ok) return { response, value };
  const cookies = responseCookies(response);
  return {
    response,
    value,
    csrf: value.csrfToken,
    cookie: cookies.map(cookiePair).join('; '),
    setCookies: cookies
  };
}

async function waitFor(callback, { timeout = 2_000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await callback();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`condition was not reached; last value: ${JSON.stringify(last)}`);
}

async function rawStatus(baseUrl, {
  path = '/',
  headers = {},
  duplicateClientAddresses,
  duplicateAuthorities,
  setHost = true
} = {}) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path,
      method: 'GET',
      headers,
      setHost
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    if (duplicateClientAddresses) request.setHeader('x-lazying-client-address', duplicateClientAddresses);
    if (duplicateAuthorities) request.setHeader('x-lazying-public-authority', duplicateAuthorities);
    request.end();
  });
}

async function rawFramedRequest(baseUrl, request) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connectTcp(Number(target.port), target.hostname);
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw framed request did not close in time'));
    }, 1_000);
    socket.setEncoding('utf8');
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('connect', () => socket.write(request));
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function assertNoOwnerIdentity(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(source, /"accountId"/u);
}

test('refuses mismatched release identities and forged changed-body maps before listening', () => {
  const root = mkdtempSync(join(tmpdir(), 'lazying-cloud-release-test-'));
  const controlStore = new CloudIndexStore({ databasePath: join(root, 'control', 'index.sqlite') });
  const directChatStore = new DirectChatStore({ databasePath: join(root, 'chat', 'chat.sqlite') });
  controlStore.provisionAccount({
    accountId: PRINCIPAL_ID,
    issuer: 'local-login',
    subject: USERNAME,
    idempotencyKey: 'account-release-00000001'
  });
  const common = {
    publicOrigin: PUBLIC_ORIGIN,
    account: { username: USERNAME, principalId: PRINCIPAL_ID },
    passwordVerifier: { algorithm: 'scrypt', verify: async () => false },
    sessionStore: controlStore,
    controlStore,
    directChatStore
  };
  try {
    assert.throws(
      () => createCloudServer({ ...common, releaseId: 'manual', assetMap: OFFICIAL_ASSET_MAP }),
      /does not match/u
    );
    const forged = Object.freeze({
      ...Object.fromEntries([
        'releaseVersion', 'contentDigest', 'finalMapDigest', 'finalDigestContext', 'generatorVersion',
        'moduleLexerVersion', 'basePath', 'scopeIdentity', 'cacheName', 'buildQuery', 'releaseNamespace',
        'serviceWorkerRoute', 'shellRoutes', 'moduleRoutes'
      ].map((key) => [key, OFFICIAL_ASSET_MAP[key]])),
      routes: OFFICIAL_ASSET_MAP.routes,
      get(route) {
        const value = OFFICIAL_ASSET_MAP.get(route);
        return route.endsWith('/app.js') ? { ...value, body: `${value.body}\n// forged change` } : value;
      }
    });
    assert.throws(
      () => createCloudServer({ ...common, releaseId: RELEASE_ID, assetMap: forged }),
      /factory-authenticated/u
    );
  } finally {
    directChatStore.close();
    controlStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a Direct Chat adapter without deletion authority before listening', (t) => {
  const state = testState(t);
  const incomplete = new Proxy(state.directChatStore, {
    get(target, property, receiver) {
      if (property === 'deleteThread') return undefined;
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => createCloudServer({ ...state.options, directChatStore: incomplete }),
    /deleteThread\(\)/u
  );
});

test('serves stable update metadata with HEAD parity and immutable caching only in the release namespace', async (t) => {
  const state = testState(t);
  const { baseUrl } = await state.start();
  const root = await fetch(`${baseUrl}/`, { headers: publicBoundary(baseUrl) });
  const rootHead = await fetch(`${baseUrl}/`, { method: 'HEAD', headers: publicBoundary(baseUrl) });
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.match(root.headers.get('content-security-policy'), /script-src 'self'/u);
  assert.match(root.headers.get('content-security-policy'), /default-src 'none'/u);
  assert.doesNotMatch(root.headers.get('content-security-policy'), /unsafe-|https?:|data:|cdn/iu);
  assert.equal(root.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(root.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(root.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(rootHead.headers.get('content-length'), root.headers.get('content-length'));
  assert.equal(await rootHead.text(), '');
  const versionedRoot = await fetch(`${baseUrl}/?v=${RELEASE_ID}`, { headers: publicBoundary(baseUrl) });
  assert.equal(versionedRoot.status, 200);
  assert.equal(versionedRoot.headers.get('cache-control'), 'no-store');
  assert.equal(await versionedRoot.text(), await root.clone().text());

  const worker = await fetch(`${baseUrl}/sw.js`, { headers: publicBoundary(baseUrl) });
  const workerHead = await fetch(`${baseUrl}/sw.js`, { method: 'HEAD', headers: publicBoundary(baseUrl) });
  assert.equal(worker.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  assert.equal(worker.headers.get('pragma'), 'no-cache');
  assert.equal(worker.headers.get('expires'), '0');
  assert.equal(workerHead.headers.get('content-length'), worker.headers.get('content-length'));
  assert.match(await worker.text(), new RegExp(RELEASE_ID, 'u'));

  const immutable = await fetch(`${baseUrl}/assets/r/${RELEASE_ID}/app.js`, { headers: publicBoundary(baseUrl) });
  assert.equal(immutable.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const manifest = await fetch(`${baseUrl}/manifest.webmanifest?v=${RELEASE_ID}`, { headers: publicBoundary(baseUrl) });
  assert.equal(manifest.headers.get('cache-control'), 'no-store');
  assert.equal(CLOUD_HTTP_LIMITS.directChatJobs, 1);
});

test('outer request deadline covers the longest bounded body reader without relaxing connection limits', async (t) => {
  const state = testState(t);
  const { server: defaultServer } = await state.start();
  assert.equal(defaultServer.requestTimeout, CLOUD_HTTP_LIMITS.visionBodyTimeoutMs + 30_000);
  assert.ok(defaultServer.requestTimeout > CLOUD_HTTP_LIMITS.visionBodyTimeoutMs);
  assert.equal(defaultServer.headersTimeout, 10_000);
  assert.equal(defaultServer.keepAliveTimeout, 5_000);

  const { server: maximumServer } = await state.start({
    limits: { bodyTimeoutMs: 15_000, visionBodyTimeoutMs: 120_000 }
  });
  assert.equal(maximumServer.requestTimeout, 150_000);
  assert.equal(maximumServer.headersTimeout, 10_000);
  assert.equal(maximumServer.keepAliveTimeout, 5_000);
});

test('rejects framed bodies on every static GET and HEAD before waiting for payload bytes', async (t) => {
  const state = testState(t);
  const { baseUrl, publicOrigin } = await state.start();
  const authority = new URL(publicOrigin).host;
  for (const method of ['GET', 'HEAD']) {
    const response = await rawFramedRequest(baseUrl, [
      `${method} / HTTP/1.1`,
      `Host: ${authority}`,
      `X-Lazying-Public-Authority: ${authority}`,
      'X-Lazying-Client-Address: 203.0.113.10',
      'Content-Length: 4096',
      'Connection: keep-alive',
      '',
      '{'
    ].join('\r\n'));
    assert.match(response, /^HTTP\/1\.1 400 /u, method);
    assert.match(response, /\r\nconnection: close\r\n/iu, method);
    if (method === 'GET') assert.match(response, /unexpected_body/u, method);
  }
});

test('rejects non-exact routes, encoded paths, dynamic queries, and authority bypasses', async (t) => {
  const state = testState(t);
  const { baseUrl } = await state.start();
  const matrix = [
    ['/api/chat/threads/list/', 400],
    ['/api/chat/threads/list?limit=1', 400],
    ['/api/chat/threads/delete?threadId=owned', 400],
    ['/api/chat/%74hreads/list', 400],
    ['/api/chat%2fthreads/list', 400],
    ['/agent/v1/capabilities', 404],
    ['/v1/chat/completions', 404],
    ['/api/app-release', 404],
    ['/api/transport/agent/v1/capabilities/', 400],
    ['/sw.js?v=old', 400]
  ];
  for (const [pathname, expected] of matrix) {
    const response = await post(baseUrl, pathname, {});
    assert.equal(response.status, expected, pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
  }
  const method = await fetch(`${baseUrl}/api/chat/threads/list`, { headers: publicBoundary(baseUrl) });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  const wrongRootVersion = await fetch(`${baseUrl}/?v=release-wrong`, { headers: publicBoundary(baseUrl) });
  assert.equal(wrongRootVersion.status, 400);
});

test('requires exact public authority and one loopback-Caddy client-address assertion', async (t) => {
  const state = testState(t);
  const { baseUrl, publicOrigin } = await state.start();
  assert.equal(await rawStatus(baseUrl, {
    headers: { 'x-lazying-public-authority': new URL(publicOrigin).host }
  }), 403);
  assert.equal(await rawStatus(baseUrl, {
    headers: { 'x-lazying-public-authority': 'wrong.test', 'x-lazying-client-address': '203.0.113.10' }
  }), 421);
  assert.equal(await rawStatus(baseUrl, {
    headers: { ...publicBoundary(baseUrl), 'x-lazying-client-address': '203.0.113.10, 198.51.100.8' }
  }), 403);
  assert.equal(await rawStatus(baseUrl, {
    headers: { 'x-lazying-public-authority': new URL(publicOrigin).host },
    duplicateClientAddresses: ['203.0.113.10', '198.51.100.8']
  }), 403);
  assert.equal(await rawStatus(baseUrl, {
    headers: { 'x-lazying-client-address': '203.0.113.10' }
  }), 421);
  assert.equal(await rawStatus(baseUrl, {
    headers: { 'x-lazying-client-address': '203.0.113.10' },
    duplicateAuthorities: [new URL(publicOrigin).host, new URL(publicOrigin).host]
  }), 421);
  assert.equal(await rawStatus(baseUrl, {
    headers: { ...publicBoundary(baseUrl), host: 'wrong.test' }
  }), 421);
  assert.equal(await rawStatus(baseUrl, {
    headers: publicBoundary(baseUrl),
    setHost: false
  }), 400); // Node's HTTP/1.1 parser rejects a missing Host before the handler runs.
  assert.equal(await rawStatus(baseUrl, { headers: publicBoundary(baseUrl) }), 200);

  assert.throws(() => resolveTrustedClientAddress({
    socket: { remoteAddress: '198.51.100.2' },
    rawHeaders: ['X-Lazying-Client-Address', '203.0.113.10'],
    headers: { 'x-lazying-client-address': '203.0.113.10' }
  }), /untrusted peer/u);
});

test('uses secure browser cookies, session-bound CSRF, generic failures, and owner isolation', async (t) => {
  const state = testState(t);
  state.controlStore.provisionAccount({
    accountId: 'account-other',
    issuer: 'local-login',
    subject: 'other-user',
    idempotencyKey: 'account-other-00000001'
  });
  state.directChatStore.createThread({
    accountId: 'account-other',
    threadId: 'foreign-thread',
    title: 'Private',
    idempotencyKey: 'foreign-thread-0000001'
  });
  const { baseUrl } = await state.start();

  const badOrigin = await post(baseUrl, '/api/login', { username: USERNAME, password: PASSWORD, remember: true }, {
    headers: { origin: 'https://evil.test' }
  });
  assert.equal(badOrigin.status, 403);
  const badLogin = await login(baseUrl, { password: 'wrong password value' });
  assert.equal(badLogin.response.status, 401);
  assert.doesNotMatch(JSON.stringify(badLogin.value), /wrong password|lachlanchen/u);

  const auth = await login(baseUrl);
  assert.equal(auth.response.status, 200);
  assert.deepEqual(Object.keys(auth.value).sort(), ['authenticated', 'csrfToken', 'username']);
  assert.equal(auth.value.authenticated, true);
  assert.equal(auth.value.username, USERNAME);
  assert.equal(auth.setCookies.length, 2);
  const sessionSetCookie = auth.setCookies.find((value) => value.startsWith('__Host-lazying_session='));
  assert.match(sessionSetCookie, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=/u);
  const rawSessionToken = cookiePair(sessionSetCookie).split('=', 2)[1];
  assert.doesNotMatch(JSON.stringify(auth.value), new RegExp(rawSessionToken, 'u'));
  assert.doesNotMatch(JSON.stringify(auth.value), new RegExp(PASSWORD, 'u'));

  const secondAuth = await login(baseUrl);
  assert.notEqual(secondAuth.csrf, auth.csrf);
  const crossedSession = await post(baseUrl, '/api/session', {}, {
    cookie: auth.cookie,
    csrf: secondAuth.csrf
  });
  assert.equal(crossedSession.status, 403);

  const missingCsrf = await post(baseUrl, '/api/session', {}, { cookie: auth.cookie });
  assert.equal(missingCsrf.status, 403);
  const wrongCsrf = await post(baseUrl, '/api/session', {}, { cookie: auth.cookie, csrf: 'x'.repeat(43) });
  assert.equal(wrongCsrf.status, 403);
  const restored = await post(baseUrl, '/api/session', {}, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), auth.value);

  const list = await post(baseUrl, '/api/chat/threads/list', {}, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { threads: [] });
  const created = await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'owned-public-thread', title: 'Owner stays private'
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-owned-public-001' });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assertNoOwnerIdentity(createdBody);
  assert.equal(createdBody.thread.threadId, 'owned-public-thread');
  const ownedList = await post(baseUrl, '/api/chat/threads/list', {}, { cookie: auth.cookie, csrf: auth.csrf });
  const ownedListBody = await ownedList.json();
  assertNoOwnerIdentity(ownedListBody);
  assert.deepEqual(ownedListBody.threads.map((thread) => thread.threadId), ['owned-public-thread']);
  const ownedMessages = await post(baseUrl, '/api/chat/messages/list', {
    threadId: 'owned-public-thread', afterRevision: 0, limit: 20
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assertNoOwnerIdentity(await ownedMessages.json());
  const foreign = await post(baseUrl, '/api/chat/threads/get', { threadId: 'foreign-thread' }, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(foreign.status, 404);
});

test('iOS/PWA requests with missing or partial Fetch Metadata stay exact-origin, session-bound, release-compatible, and observable', async (t) => {
  const outcomes = [];
  const state = testState(t, { requestOutcomeObserver: (outcome) => outcomes.push(outcome) });
  const { baseUrl } = await state.start();

  const auth = await login(baseUrl, { fetchMetadataPresent: false });
  assert.equal(auth.response.status, 200, 'exact-origin mobile login remains available');
  assert.equal(auth.response.headers.get(CLIENT_RELEASE_HEADER_NAME), RELEASE_ID);

  const restored = await post(baseUrl, '/api/session', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    fetchMetadataPresent: false
  });
  assert.equal(restored.status, 200, 'mobile session restore retains its existing session + CSRF checks');

  const legacyList = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    fetchMetadataPresent: false
  });
  assert.equal(legacyList.status, 200, 'an already-open legacy PWA may omit the new release header');
  assert.deepEqual(await legacyList.json(), { threads: [] });
  assert.equal(legacyList.headers.get(CLIENT_RELEASE_HEADER_NAME), RELEASE_ID);

  const wrongOrigin = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    fetchMetadataPresent: false,
    headers: { origin: 'https://attacker.invalid' }
  });
  assert.equal(wrongOrigin.status, 403, 'missing Fetch Metadata never relaxes the exact-Origin boundary');
  assert.equal((await wrongOrigin.json()).error.code, 'origin_rejected');

  const missingCsrf = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    fetchMetadataPresent: false
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'fetch_metadata_rejected');

  const partialMetadata = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    fetchMetadataPresent: false,
    headers: { 'sec-fetch-mode': 'cors' }
  });
  assert.equal(partialMetadata.status, 200, 'valid partial WebKit metadata uses the authenticated fallback');
  assert.deepEqual(await partialMetadata.json(), { threads: [] });

  const partialMissingCsrf = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    fetchMetadataPresent: false,
    headers: { 'sec-fetch-dest': 'empty' }
  });
  assert.equal(partialMissingCsrf.status, 403);
  assert.equal((await partialMissingCsrf.json()).error.code, 'fetch_metadata_rejected');

  const partialWrongMetadata = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    fetchMetadataPresent: false,
    headers: { 'sec-fetch-mode': 'no-cors' }
  });
  assert.equal(partialWrongMetadata.status, 403);
  assert.equal((await partialWrongMetadata.json()).error.code, 'fetch_metadata_rejected');

  const wrongMetadata = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(wrongMetadata.status, 403);
  assert.equal((await wrongMetadata.json()).error.code, 'fetch_metadata_rejected');

  const rejectedCreate = await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'ios-release-rejected-thread',
    title: 'must not persist'
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'ios-release-rejected-0001',
    headers: { [CLIENT_RELEASE_HEADER_NAME]: `stale-${'b'.repeat(64)}` }
  });
  assert.equal(rejectedCreate.status, 409);
  assert.equal(rejectedCreate.headers.get(CLIENT_RELEASE_HEADER_NAME), RELEASE_ID);
  assert.equal((await rejectedCreate.json()).error.code, 'client_release_mismatch');

  const stillEmpty = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    fetchMetadataPresent: false
  });
  assert.deepEqual(await stillEmpty.json(), { threads: [] }, 'release rejection happens before mutation ingestion');

  assert(outcomes.some((outcome) => outcome.fetchMetadata === 'missing'
    && outcome.release === 'missing' && outcome.result === 'accepted'));
  assert(outcomes.some((outcome) => outcome.fetchMetadata === 'partial'
    && outcome.release === 'missing' && outcome.result === 'accepted'));
  assert(outcomes.some((outcome) => outcome.errorCode === 'fetch_metadata_rejected'
    && outcome.fetchMetadata === 'invalid'));
  assert(outcomes.some((outcome) => outcome.errorCode === 'client_release_mismatch'
    && outcome.release === 'mismatch'));
  for (const outcome of outcomes) {
    assert.deepEqual(Object.keys(outcome).sort(), [
      'errorCode', 'fetchMetadata', 'release', 'result', 'route', 'schemaVersion', 'status', 'timestamp'
    ]);
    const serialized = JSON.stringify(outcome);
    assert.doesNotMatch(serialized, /ios-release-rejected-thread|must not persist|lachlanchen|correct horse/i);
    assert.equal(serialized.includes(auth.csrf), false);
    for (const cookie of auth.cookie.split('; ')) assert.equal(serialized.includes(cookie), false);
  }
});

test('deletes Direct Chat only through the exact authenticated cursor-bound mutation', async (t) => {
  const state = testState(t);
  const active = state.directChatStore.createThread({
    accountId: PRINCIPAL_ID,
    threadId: 'delete-active-thread',
    title: 'Active',
    idempotencyKey: 'create-delete-active-0001'
  });
  state.directChatStore.startTurn({
    accountId: PRINCIPAL_ID,
    threadId: active.threadId,
    messageId: 'delete-active-message',
    content: 'This accepted send is still running.',
    generationId: 'delete-active-generation',
    assistantMessageId: 'delete-active-assistant',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'start-delete-active-0001'
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);

  const create = await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'delete-owned-thread',
    title: 'Delete me'
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'create-delete-owned-0001'
  });
  const thread = (await create.json()).thread;
  const body = {
    threadId: thread.threadId,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash
  };
  const missingCsrf = await post(baseUrl, '/api/chat/threads/delete', body, {
    cookie: auth.cookie,
    idempotency: 'delete-owned-thread-0001'
  });
  assert.equal(missingCsrf.status, 403);
  const missingIdempotency = await post(baseUrl, '/api/chat/threads/delete', body, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(missingIdempotency.status, 400);
  const extraField = await post(baseUrl, '/api/chat/threads/delete', { ...body, accountId: PRINCIPAL_ID }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'delete-owned-extra-0001'
  });
  assert.equal(extraField.status, 400);
  const stale = await post(baseUrl, '/api/chat/threads/delete', {
    ...body,
    expectedRevision: 1,
    expectedHash: 'a'.repeat(64)
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'delete-owned-stale-0001'
  });
  assert.equal(stale.status, 409);

  const activeThread = state.directChatStore.getThread(PRINCIPAL_ID, active.threadId);
  const activeDelete = await post(baseUrl, '/api/chat/threads/delete', {
    threadId: active.threadId,
    expectedRevision: activeThread.revision,
    expectedHash: activeThread.ledgerHash
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'delete-active-thread-0001'
  });
  assert.equal(activeDelete.status, 409);

  const deletion = await post(baseUrl, '/api/chat/threads/delete', body, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'delete-owned-thread-0001'
  });
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deleted: true, threadId: thread.threadId });
  const replay = await post(baseUrl, '/api/chat/threads/delete', body, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'delete-owned-thread-0001'
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { deleted: true, threadId: thread.threadId });
  const list = await post(baseUrl, '/api/chat/threads/list', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.deepEqual((await list.json()).threads.map((item) => item.threadId), [active.threadId]);
});

test('bounds oversized and slow login bodies before password verification', async (t) => {
  let verifications = 0;
  const state = testState(t, { limits: { bodyTimeoutMs: 50 } });
  const verifier = Object.freeze({
    algorithm: 'scrypt',
    async verify() { verifications += 1; return false; }
  });
  const { server, baseUrl } = await state.start({ passwordVerifier: verifier });
  const oversized = await post(baseUrl, '/api/login', {
    username: USERNAME,
    password: 'x'.repeat(3_000),
    remember: true
  });
  assert.equal(oversized.status, 413);
  assert.equal(verifications, 0);

  const address = server.address();
  const slowStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/login',
      method: 'POST',
      headers: fetchMetadata(baseUrl, { 'content-type': 'application/json' })
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.write('{"username":');
  });
  assert.equal(slowStatus, 408);
  assert.equal(verifications, 0);
});

test('keys login rate admission by the Caddy-asserted client address instead of loopback', async (t) => {
  const state = testState(t, { limits: { loginAttemptsPerMinute: 2 } });
  const { baseUrl } = await state.start();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = await login(baseUrl, { password: 'wrong', clientAddress: '203.0.113.20' });
    assert.equal(failed.response.status, 401);
  }
  const limited = await login(baseUrl, { password: PASSWORD, clientAddress: '203.0.113.20' });
  assert.equal(limited.response.status, 429);
  const independent = await login(baseUrl, { clientAddress: '203.0.113.21' });
  assert.equal(independent.response.status, 200);
});

test('keeps Agent mode disabled and passes only server-derived adapter context', async (t) => {
  const contexts = [];
  const adapter = {
    async rpc(path, body, context) {
      contexts.push({ path, body, context });
      return {
        schemaVersion: '1',
        enabled: false,
        agent: { kind: 'aginti', label: 'AgInTi Agent' },
        model: { label: 'LocalLLM' },
        actions: { cancel: false, resume: false, retry: false },
        attachments: { enabled: false },
        artifacts: { kinds: ['plot', 'table', 'markdown'], schemaVersion: '1' }
      };
    },
    capabilities(context) { return this.rpc('/agent/v1/capabilities', {}, context); }
  };
  const state = testState(t, { adapter });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  const capabilities = await post(baseUrl, '/api/transport/agent/v1/capabilities', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).enabled, false);
  assert.equal(contexts.length, 1);
  assert.deepEqual(Object.keys(contexts[0].context).sort(), ['browserSession', 'principalId', 'signal']);
  assert.equal(contexts[0].context.principalId, PRINCIPAL_ID);
  assert.match(contexts[0].context.browserSession, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(contexts[0].context.browserSession, /__Host|lachlanchen/u);
  assert.deepEqual(state.controlStore.listThreads({ accountId: PRINCIPAL_ID }), []);

  const forgedSearch = await post(baseUrl, '/api/transport/agent/v1/runs/start', {
    threadId: 'thr_00000000-0000-4000-8000-000000000000',
    input: { text: 'search despite disabled capability', search: { mode: 'web', limit: 5 } }
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: IDEMPOTENCY });
  assert.equal(forgedSearch.status, 409);
  assert.equal(contexts.some(({ path }) => path === '/agent/v1/runs/start'), false, 'disabled Search never reaches AgInTi');
  assert.deepEqual(Object.keys(contexts.at(-1).context).sort(), ['browserSession', 'principalId', 'signal']);

  const unavailableState = testState(t);
  const unavailable = await unavailableState.start();
  const unavailableAuth = await login(unavailable.baseUrl);
  const disabled = await post(unavailable.baseUrl, '/api/transport/agent/v1/capabilities', {}, {
    cookie: unavailableAuth.cookie,
    csrf: unavailableAuth.csrf
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).enabled, false);
  const bypass = await post(unavailable.baseUrl, '/api/transport/agent/v1/runs/start', {
    threadId: 'thr_00000000-0000-4000-8000-000000000000',
    input: { text: 'hello' }
  }, { cookie: unavailableAuth.cookie, csrf: unavailableAuth.csrf, idempotency: IDEMPOTENCY });
  assert.equal(bypass.status, 503);
});

test('preflights negotiated Agent Search and forwards one exact run without a LocalLLM browser route', async (t) => {
  const calls = [];
  const threadId = 'thr_12345678-1234-4123-8123-123456789abc';
  const runId = 'run_abcdefab-cdef-4abc-8def-abcdefabcdef';
  const capability = {
    schemaVersion: '1',
    enabled: true,
    agent: { kind: 'aginti', label: 'AgInTi Agent' },
    model: { label: 'LocalLLM' },
    actions: { cancel: true, resume: true, retry: false },
    attachments: { enabled: false },
    search: { enabled: true, modes: ['web', 'papers', 'both'], maximumSources: 12 },
    artifacts: { kinds: ['plot', 'table', 'markdown', 'sources'], schemaVersion: '1' }
  };
  const adapter = {
    async capabilities(context) {
      calls.push({ path: '/agent/v1/capabilities', body: {}, context });
      return capability;
    },
    async rpc(path, body, context) {
      calls.push({ path, body, context });
      return {
        schemaVersion: '1',
        run: {
          id: runId,
          threadId,
          previousRunId: null,
          status: 'starting',
          createdAt: '2026-08-20T08:00:00.000Z',
          startedAt: null,
          completedAt: null,
          cancelRequestedAt: null,
          output: '',
          error: null,
          authority: { kind: 'aginti', snapshotHash: null, runtimeRevision: null, contextDigest: null },
          eventCursor: { firstSeq: 1, lastSeq: 0, lastHash: '0'.repeat(64), prunedThroughSeq: 0 }
        }
      };
    }
  };
  const state = testState(t, { adapter });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  const search = { mode: 'both', limit: 7 };
  const response = await post(baseUrl, '/api/transport/agent/v1/runs/start', {
    threadId,
    input: { text: 'Compare current evidence', search }
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: IDEMPOTENCY });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).run.id, runId);
  assert.deepEqual(calls.map(({ path }) => path), ['/agent/v1/capabilities', '/agent/v1/runs/start']);
  assert.deepEqual(calls[1].body, { threadId, input: { text: 'Compare current evidence', search } });
  assert.deepEqual(Object.keys(calls[0].context).sort(), ['browserSession', 'principalId', 'signal']);
  assert.equal(calls[1].context.idempotencyKey, IDEMPOTENCY);

  const beforeInvalid = calls.length;
  const invalid = await post(baseUrl, '/api/transport/agent/v1/runs/start', {
    threadId,
    input: { text: 'Too many', search: { mode: 'web', limit: 21 } }
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'browser-action-00000002' });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, beforeInvalid);

  for (const path of ['/api/transport/localllm/search', '/api/localllm/search', '/api/search']) {
    const direct = await post(baseUrl, path, {
      query: 'must not exist'
    }, { cookie: auth.cookie, csrf: auth.csrf });
    assert.equal(direct.status, 404);
  }
  assert.equal(calls.length, beforeInvalid);
});

test('uses its own AgInTi adapter contract over application-neutral LazyEdge transport', async (t) => {
  const upstreamRequests = [];
  const runId = 'run_abcdefab-cdef-4abc-8def-abcdefabcdef';
  const threadId = 'thr_12345678-1234-4123-8123-123456789abc';
  const runLedger = {
    id: runId,
    threadId,
    status: 'running',
    events: [],
    lastEventSeq: 0,
    lastEventHash: '',
    prunedThroughSeq: 0,
    prunedEventHash: ''
  };
  const streamedEvent = appendLedgerEvent(
    runLedger,
    'run.status',
    { status: 'running' },
    '2026-08-20T08:00:00.000Z'
  );
  const adapter = createAgintiAgentAdapter({
    upstream: 'http://127.0.0.1:9009',
    credentialProvider: async () => 'aginti-native-internal-token-0123456789abcdef',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      upstreamRequests.push({ url, headers: new Headers(init.headers), body });
      if (url.endsWith('/agent/v1/runs/events')) {
        if (body.afterSeq === 1) return new Response('', { status: 400 });
        return new Response(
          `id: ${streamedEvent.id}\nevent: ${streamedEvent.type}\ndata: ${JSON.stringify(streamedEvent)}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
        );
      }
      if (url.endsWith('/agent/v1/threads/create')) {
        return new Response('', { status: 503 });
      }
      return new Response(JSON.stringify({
        schemaVersion: '1',
        enabled: false,
        agent: { kind: 'aginti', label: 'AgInTi Agent' },
        model: { label: 'LocalLLM' },
        actions: { cancel: false, resume: false, retry: false },
        attachments: { enabled: false },
        artifacts: { kinds: ['plot', 'table', 'markdown'], schemaVersion: '1' }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const state = testState(t, { adapter });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  const capabilities = await post(baseUrl, '/api/transport/agent/v1/capabilities', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).enabled, false);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, 'http://127.0.0.1:9009/agent/v1/capabilities');
  assert.equal(upstreamRequests[0].headers.get('x-aginti-principal-id'), PRINCIPAL_ID);
  assert.match(upstreamRequests[0].headers.get('x-aginti-browser-session-id'), /^[a-f0-9]{64}$/u);
  assert.equal(upstreamRequests[0].headers.get('idempotency-key'), null);
  assert.equal(upstreamRequests[0].headers.get('x-lazyedge-principal-id'), null);
  const events = await post(baseUrl, '/api/transport/agent/v1/runs/events', {
    runId,
    afterSeq: 0,
    afterHash: '0'.repeat(64)
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(events.status, 200);
  const eventText = await events.text();
  assert.match(eventText, new RegExp(`id: ${runId}\\.1`, 'u'));
  assert.match(eventText, /event: run\.status/u);
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[1].headers.get('x-aginti-principal-id'), PRINCIPAL_ID);
  assert.equal(upstreamRequests[1].headers.get('idempotency-key'), null);
  assert.deepEqual(upstreamRequests[1].body, {
    runId,
    afterSeq: 0,
    afterHash: '0'.repeat(64)
  });

  const missingHashCalls = upstreamRequests.length;
  const missingHash = await post(baseUrl, '/api/transport/agent/v1/runs/events', {
    runId,
    afterSeq: 0
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(missingHash.status, 400);
  assert.equal(upstreamRequests.length, missingHashCalls);

  const rejectedCursor = await post(baseUrl, '/api/transport/agent/v1/runs/events', {
    runId,
    afterSeq: 1,
    afterHash: streamedEvent.hash
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(rejectedCursor.status, 400);
  assert.match(rejectedCursor.headers.get('content-type'), /^application\/json/u);
  assert.deepEqual((await rejectedCursor.json()).error, {
    code: 'agent_unavailable',
    message: 'The Agent request was not accepted.'
  });

  await assert.rejects(adapter.rpc('/agent/v1/threads/create', { title: 'Header probe' }, {
    principalId: PRINCIPAL_ID,
    browserSession: 'a'.repeat(64),
    idempotencyKey: IDEMPOTENCY
  }));
  assert.equal(upstreamRequests.length, 4);
  assert.equal(upstreamRequests[3].headers.get('idempotency-key'), IDEMPOTENCY);
  assert.equal(upstreamRequests[3].headers.get('x-aginti-principal-id'), PRINCIPAL_ID);
  assert.equal(upstreamRequests[3].headers.get('x-lazyedge-idempotency-key'), null);
});

test('streams owner-bound local Agent files through authenticated no-cache GET, HEAD, and ranges', async (t) => {
  const artifactId = `art_${'a'.repeat(64)}`;
  const goneArtifactId = `art_${'b'.repeat(64)}`;
  const content = Buffer.from('%PDF-1.7\nlocal artifact\n', 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const calls = [];
  let ownerSession = null;
  const adapter = {
    async rpc() { throw new Error('unexpected Agent RPC'); },
    async capabilities() { throw new Error('historical artifact reads must not renegotiate creation'); },
    async artifactContent(input, context) {
      calls.push({ input, context });
      if (ownerSession === null) ownerSession = context.browserSession;
      if (context.browserSession !== ownerSession) return Object.freeze({ status: 404 });
      if (input.artifactId === goneArtifactId) return Object.freeze({ status: 410 });
      let start = input.range?.start ?? 0;
      let end = input.range?.end === undefined ? content.byteLength - 1 : Math.min(input.range.end, content.byteLength - 1);
      if (start >= content.byteLength) return Object.freeze({ status: 416 });
      const selected = content.subarray(start, end + 1);
      return Object.freeze({
        status: input.range === undefined ? 200 : 206,
        filename: 'résumé.pdf',
        mime: 'application/pdf',
        totalBytes: content.byteLength,
        selectedBytes: selected.byteLength,
        sha256,
        range: input.range === undefined ? null : Object.freeze({ start, end, total: content.byteLength }),
        body: input.metadataOnly === true ? null : new Response(selected).body
      });
    }
  };
  const state = testState(t, { adapter });
  const { baseUrl } = await state.start();
  const first = await login(baseUrl);

  const full = await artifactRequest(baseUrl, artifactId, {
    cookie: first.cookie,
    release: RELEASE_ID
  });
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);
  assert.equal(full.headers.get('content-type'), 'application/pdf');
  assert.equal(full.headers.get('content-length'), String(content.byteLength));
  assert.equal(full.headers.get('cache-control'), 'no-store, private');
  assert.equal(full.headers.get('pragma'), 'no-cache');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('etag'), `"${sha256}"`);
  assert.match(full.headers.get('content-disposition'), /^inline; filename="resume\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf$/u);
  assert.match(full.headers.get('content-security-policy'), /^sandbox;/u);
  assert.equal(calls[0].context.principalId, PRINCIPAL_ID);
  assert.match(calls[0].context.browserSession, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(calls[0].context).sort(), ['browserSession', 'principalId', 'signal']);
  assert.deepEqual(calls[0].input, { artifactId });

  const download = await artifactRequest(baseUrl, artifactId, {
    cookie: first.cookie,
    download: true
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="resume\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf$/u);

  const mobileHead = await artifactRequest(baseUrl, artifactId, {
    method: 'HEAD',
    cookie: first.cookie,
    fetchMetadataPresent: false
  });
  assert.equal(mobileHead.status, 200, 'iOS/PWA may omit Fetch Metadata on a local attachment request');
  assert.equal(mobileHead.headers.get('content-length'), String(content.byteLength));
  assert.deepEqual(calls.at(-1).input, { artifactId, metadataOnly: true });

  const navigation = await artifactRequest(baseUrl, artifactId, {
    cookie: first.cookie,
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  });
  assert.equal(navigation.status, 200, 'the rendered same-origin Open link is admitted as a navigation');
  assert.deepEqual(Buffer.from(await navigation.arrayBuffer()), content);

  const partial = await artifactRequest(baseUrl, artifactId, {
    cookie: first.cookie,
    range: 'bytes=5-10'
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 5-10/${content.byteLength}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), content.subarray(5, 11));
  assert.deepEqual(calls.at(-1).input, { artifactId, range: { start: 5, end: 10 } });

  const head = await artifactRequest(baseUrl, artifactId, {
    method: 'HEAD',
    cookie: first.cookie,
    range: 'bytes=2-'
  });
  assert.equal(head.status, 206);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get('content-length'), String(content.byteLength - 2));
  assert.equal(head.headers.get('x-artifact-content-length'), String(content.byteLength - 2));
  assert.equal(head.headers.get('content-range'), `bytes 2-${content.byteLength - 1}/${content.byteLength}`);
  assert.deepEqual(calls.at(-1).input, { artifactId, metadataOnly: true, range: { start: 2 } });

  const unsatisfied = await artifactRequest(baseUrl, artifactId, {
    cookie: first.cookie,
    range: `bytes=${content.byteLength}-`
  });
  assert.equal(unsatisfied.status, 416);
  assert.equal((await unsatisfied.json()).error.code, 'range_not_satisfiable');

  const gone = await artifactRequest(baseUrl, goneArtifactId, { cookie: first.cookie });
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error.code, 'artifact_content_gone');
  assert.equal(gone.headers.get('cache-control'), 'no-store, private');

  const second = await login(baseUrl);
  const foreignSession = await artifactRequest(baseUrl, artifactId, { cookie: second.cookie });
  assert.equal(foreignSession.status, 404);
  assert.equal((await foreignSession.json()).error.code, 'not_found');
  assert.notEqual(calls.at(-1).context.browserSession, ownerSession);
});

test('an aborted artifact stream releases admission even when a hostile upstream cancel never settles', async (t) => {
  const artifactId = `art_${'d'.repeat(64)}`;
  const content = Buffer.from('ab', 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  let contentCalls = 0;
  let cancelCalls = 0;
  const adapter = {
    async rpc() { throw new Error('unexpected Agent RPC'); },
    async capabilities() { throw new Error('historical artifact reads must not renegotiate creation'); },
    async artifactContent() {
      contentCalls += 1;
      if (contentCalls > 1) return Object.freeze({ status: 404 });
      let reads = 0;
      const reader = {
        read() {
          reads += 1;
          return reads === 1
            ? Promise.resolve({ done: false, value: new Uint8Array([content[0]]) })
            : new Promise(() => {});
        },
        cancel() {
          cancelCalls += 1;
          return new Promise(() => {});
        },
        releaseLock() { throw new Error('hostile reader retains a pending read'); }
      };
      return Object.freeze({
        status: 200,
        filename: 'abort.pdf',
        mime: 'application/pdf',
        totalBytes: content.byteLength,
        selectedBytes: content.byteLength,
        sha256,
        range: null,
        body: { getReader: () => reader }
      });
    }
  };
  const state = testState(t, {
    adapter,
    limits: { concurrentStreams: 1, concurrentStreamsPerSession: 1 }
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  const target = new URL(`/api/agent/artifacts/${artifactId}/content`, baseUrl);
  target.search = `?v=${RELEASE_ID}`;

  await new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method: 'GET',
      headers: {
        ...publicBoundary(baseUrl),
        cookie: auth.cookie,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty'
      }
    }, (response) => {
      response.once('error', () => {});
      response.once('data', () => {
        response.destroy();
        request.destroy();
        resolve();
      });
    });
    request.once('error', (error) => {
      if (error.code === 'ECONNRESET') resolve();
      else reject(error);
    });
    request.end();
  });
  for (let attempt = 0; attempt < 50 && cancelCalls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(cancelCalls, 1);

  const admitted = await artifactRequest(baseUrl, artifactId, { cookie: auth.cookie });
  assert.equal(admitted.status, 404, 'the disconnected stream cannot retain the sole session admission slot');
  assert.equal(contentCalls, 2);
});

test('file artifact ingress rejects auth, release, method, path, and range confusion before streaming', async (t) => {
  const artifactId = `art_${'c'.repeat(64)}`;
  let calls = 0;
  let capabilityCalls = 0;
  const adapter = {
    async rpc() { throw new Error('unexpected Agent RPC'); },
    async capabilities() {
      capabilityCalls += 1;
      throw new Error('historical artifact reads must not renegotiate creation');
    },
    async artifactContent() { calls += 1; return Object.freeze({ status: 404 }); }
  };
  const state = testState(t, { adapter });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);

  const unauthenticated = await artifactRequest(baseUrl, artifactId);
  assert.equal(unauthenticated.status, 401);
  assert.equal(calls, 0);

  const stale = await artifactRequest(baseUrl, artifactId, {
    cookie: auth.cookie,
    release: `release-${'f'.repeat(64)}`
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'client_release_mismatch');
  assert.equal(calls, 0);

  const staleUrl = await artifactRequest(baseUrl, artifactId, {
    cookie: auth.cookie,
    urlRelease: `release-${'f'.repeat(64)}`
  });
  assert.equal(staleUrl.status, 409);
  assert.equal((await staleUrl.json()).error.code, 'client_release_mismatch');
  assert.equal(calls, 0);

  for (const range of ['bytes=-4', 'bytes=0-1,4-5', 'items=0-1', 'bytes=8-2']) {
    const invalidRange = await artifactRequest(baseUrl, artifactId, { cookie: auth.cookie, range });
    assert.equal(invalidRange.status, 400, range);
  }
  assert.equal(calls, 0);

  const malformed = await artifactRequest(baseUrl, 'art_short', { cookie: auth.cookie });
  assert.equal(malformed.status, 400);
  const encoded = await fetch(`${baseUrl}/api/agent/artifacts/${artifactId}%2fextra/content`, {
    headers: { ...publicBoundary(baseUrl), cookie: auth.cookie }
  });
  assert.equal(encoded.status, 400);
  const queryConfusion = await fetch(
    `${baseUrl}/api/agent/artifacts/${artifactId}/content?v=${RELEASE_ID}&v=${RELEASE_ID}`,
    { headers: { ...publicBoundary(baseUrl), cookie: auth.cookie } }
  );
  assert.equal(queryConfusion.status, 400);
  for (const query of [
    `download=1&v=${RELEASE_ID}`,
    `v=${RELEASE_ID}&download=0`,
    `v=${RELEASE_ID}&download=1&download=1`,
  ]) {
    const invalidDisposition = await fetch(
      `${baseUrl}/api/agent/artifacts/${artifactId}/content?${query}`,
      { headers: { ...publicBoundary(baseUrl), cookie: auth.cookie } }
    );
    assert.equal(invalidDisposition.status, 400, query);
  }
  assert.equal(calls, 0);

  const wrongMethod = await post(baseUrl, `/api/agent/artifacts/${artifactId}/content`, {}, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
  assert.equal(calls, 0);

  const crossSite = await artifactRequest(baseUrl, artifactId, {
    cookie: auth.cookie,
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSite.status, 403);
  assert.equal(calls, 0);

  const missingRelease = await artifactRequest(baseUrl, artifactId, {
    cookie: auth.cookie,
    urlRelease: null
  });
  assert.equal(missingRelease.status, 409);
  assert.equal((await missingRelease.json()).error.code, 'client_release_mismatch');
  assert.equal(capabilityCalls, 0, 'an unpinned Safari navigation fails before byte transport');

  const historical = await artifactRequest(baseUrl, artifactId, { cookie: auth.cookie });
  assert.equal(historical.status, 404);
  assert.equal((await historical.json()).error.code, 'not_found');
  assert.equal(capabilityCalls, 0, 'historical reads do not renegotiate the current creation capability');
  assert.equal(calls, 1, 'a release-pinned authenticated historical read reaches AgInTi ownership enforcement');
});

test('logout revokes only its browser session and reports native Agent cancellation as a release gate', async (t) => {
  const adapter = {
    rpc() { throw new Error('not used'); },
    capabilities() { throw new Error('not used'); }
  };
  const state = testState(t, { adapter });
  state.controlStore.registerThread({
    accountId: PRINCIPAL_ID,
    threadId: 'agent-thread-kept',
    title: 'Durable Agent pointer',
    idempotencyKey: 'agent-thread-kept-00001'
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  const logout = await post(baseUrl, '/api/logout', {}, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { signedOut: true, agentCancellationPending: true });
  assert.ok(state.controlStore.getThread(PRINCIPAL_ID, 'agent-thread-kept'));

  const restored = await post(baseUrl, '/api/session', {}, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { authenticated: false });
});

test('starts a user turn and generation through the one atomic store mutation', async (t) => {
  let connectorDispatches = 0;
  const connector = {
    async generate() {
      connectorDispatches += 1;
      return (async function* () { yield 'Recovered'; })();
    }
  };
  const state = testState(t, { connector });
  const atomicOnlyStore = new Proxy(state.directChatStore, {
    get(target, property) {
      if (property === 'sendUserMessage' || property === 'startGeneration') {
        return () => { throw new Error('legacy split mutation must not be called'); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const { baseUrl } = await state.start({ directChatStore: atomicOnlyStore });
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', { threadId: 'chat-recoverable', title: '' }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-recoverable-1'
  });
  const body = {
    threadId: 'chat-recoverable',
    messageId: 'message-recoverable-user',
    generationId: 'generation-recoverable',
    assistantMessageId: 'message-recoverable-assistant',
    content: 'Please recover\nwith\tnormal formatting.\r\nExactly once.',
    expectedRevision: 0,
    expectedHash: null
  };
  const rejectedControl = await post(baseUrl, '/api/chat/runs/start', {
    ...body,
    content: 'Please recover\u000bwith an unsafe control.'
  }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-recoverable-bad-control'
  });
  assert.equal(rejectedControl.status, 400);
  assert.equal(connectorDispatches, 0);
  assert.deepEqual(state.directChatStore.listMessages({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-recoverable'
  }), []);
  const first = await post(baseUrl, '/api/chat/runs/start', body, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-recoverable-01'
  });
  assert.equal(first.status, 202);
  assertNoOwnerIdentity(await first.json());
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-recoverable',
    generationId: 'generation-recoverable'
  })?.status === 'completed');
  assert.equal(connectorDispatches, 1);
  assert.deepEqual(state.directChatStore.listMessages({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-recoverable'
  }).map((message) => message.content), [body.content, 'Recovered']);

  const retry = await post(baseUrl, '/api/chat/runs/start', body, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-recoverable-01'
  });
  assert.equal(retry.status, 202);
  const replay = await retry.json();
  assertNoOwnerIdentity(replay);
  assert.equal(replay.generation.status, 'completed');
  assert.equal(connectorDispatches, 1);
});

test('validates, stores, dispatches, and previews one private image through the fixed vision model', async (t) => {
  const image = Buffer.from(createPwaIcon(192));
  const imageBase64 = image.toString('base64');
  const dispatches = [];
  const connector = {
    async generate(input) {
      dispatches.push(input);
      assert.equal(input.modelAlias, 'localllm-vision');
      assert.equal(input.context.messages.at(-1).role, 'user');
      assert.equal(input.visionAttachment.mediaType, 'image/png');
      assert.equal(input.visionAttachment.width, 192);
      assert.equal(input.visionAttachment.height, 192);
      assert.deepEqual(input.visionAttachment.content, image);
      return (async function* () { yield `Vision response ${dispatches.length}`; })();
    }
  };
  const state = testState(t, { connector, visionEnabled: true });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);

  const capabilities = await post(baseUrl, '/api/chat/capabilities', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    visionInput: true,
    visionMediaTypes: ['image/jpeg', 'image/png'],
    maximumImageBytes: 4 * 1024 * 1024
  });
  assert.equal((await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'chat-vision', title: 'Vision'
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'create-chat-vision-000001'
  })).status, 201);

  const malformed = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-vision',
    messageId: 'message-vision-malformed-user',
    generationId: 'generation-vision-malformed',
    assistantMessageId: 'message-vision-malformed-assistant',
    content: 'This invalid image must not commit.',
    expectedRevision: 0,
    expectedHash: null,
    attachment: {
      attachmentId: 'image-vision-malformed',
      mediaType: 'image/png',
      data: Buffer.from('not an image').toString('base64')
    }
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-malformed-01'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_attachment');
  assert.equal(state.directChatStore.getThread(PRINCIPAL_ID, 'chat-vision').revision, 0);

  const attachment = {
    attachmentId: 'image-vision-0000000000000001',
    mediaType: 'image/png',
    data: imageBase64
  };
  const startBody = {
    threadId: 'chat-vision',
    messageId: 'message-vision-user',
    generationId: 'generation-vision',
    assistantMessageId: 'message-vision-assistant',
    content: 'Describe this image precisely.',
    expectedRevision: 0,
    expectedHash: null,
    attachment
  };
  const started = await post(baseUrl, '/api/chat/runs/start', startBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-00000001'
  });
  assert.equal(started.status, 202);
  const startedBody = await started.json();
  assertNoOwnerIdentity(startedBody);
  assert.equal(startedBody.generation.modelAlias, 'localllm-vision');
  assert.doesNotMatch(JSON.stringify(startedBody), new RegExp(imageBase64, 'u'));
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-vision',
    generationId: 'generation-vision'
  })?.status === 'completed');
  assert.equal(dispatches.length, 1);

  const messagesResponse = await post(baseUrl, '/api/chat/messages/list', {
    threadId: 'chat-vision', afterRevision: 0, limit: 20
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(messagesResponse.status, 200);
  const messagesBody = await messagesResponse.json();
  assertNoOwnerIdentity(messagesBody);
  assert.equal(messagesBody.messages[0].attachment.attachmentId, attachment.attachmentId);
  assert.equal(messagesBody.messages[0].attachment.mediaType, 'image/png');
  assert.equal(messagesBody.messages[0].attachment.byteLength, image.byteLength);
  assert.equal(Object.hasOwn(messagesBody.messages[0].attachment, 'data'), false);
  assert.equal(Object.hasOwn(messagesBody.messages[0].attachment, 'content'), false);
  assert.doesNotMatch(JSON.stringify(messagesBody), new RegExp(imageBase64, 'u'));

  const preview = await post(baseUrl, '/api/chat/attachments/get', {
    threadId: 'chat-vision', attachmentId: attachment.attachmentId
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(preview.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image);

  const missingPreview = await post(baseUrl, '/api/chat/attachments/get', {
    threadId: 'chat-vision', attachmentId: 'image-vision-missing'
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(missingPreview.status, 404);

  const thread = state.directChatStore.getThread(PRINCIPAL_ID, 'chat-vision');
  const followup = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-vision',
    messageId: 'message-vision-followup-user',
    generationId: 'generation-vision-followup',
    assistantMessageId: 'message-vision-followup-assistant',
    content: 'Now focus on the proportions.',
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-followup-01'
  });
  assert.equal(followup.status, 202);
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-vision',
    generationId: 'generation-vision-followup'
  })?.status === 'completed');
  assert.equal(dispatches.length, 2);
  assert.deepEqual(dispatches[1].visionAttachment.content, image);
});

test('persists and dispatches one ordered multi-image message atomically', async (t) => {
  const image = Buffer.from(createPwaIcon(192));
  const dispatches = [];
  const state = testState(t, {
    visionEnabled: true,
    connector: {
      async generate(input) {
        dispatches.push(input);
        assert.equal(input.visionAttachment, undefined);
        assert.deepEqual(
          input.visionAttachments.map((attachment) => attachment.attachmentId),
          ['image-multi-first-00000001', 'image-multi-second-0000001']
        );
        return (async function* () { yield 'Compared both images'; })();
      }
    }
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  assert.equal((await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'chat-multi-vision', title: 'Multi vision'
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'create-chat-multi-vision-01'
  })).status, 201);
  const attachments = [
    { attachmentId: 'image-multi-first-00000001', mediaType: 'image/png', data: image.toString('base64') },
    { attachmentId: 'image-multi-second-0000001', mediaType: 'image/png', data: image.toString('base64') }
  ];
  const started = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-multi-vision',
    messageId: 'message-multi-vision-user',
    generationId: 'generation-multi-vision',
    assistantMessageId: 'message-multi-vision-assistant',
    content: 'Compare these two images in order.',
    expectedRevision: 0,
    expectedHash: null,
    attachments
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-multi-vision-01'
  });
  assert.equal(started.status, 202);
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-multi-vision',
    generationId: 'generation-multi-vision'
  })?.status === 'completed');
  assert.equal(dispatches.length, 1);
  const listed = await post(baseUrl, '/api/chat/messages/list', {
    threadId: 'chat-multi-vision', afterRevision: 0, limit: 20, attachmentSchema: 2
  }, { cookie: auth.cookie, csrf: auth.csrf });
  const messages = (await listed.json()).messages;
  assert.deepEqual(
    messages[0].attachments.map((attachment) => attachment.attachmentId),
    attachments.map((attachment) => attachment.attachmentId)
  );
  assert.equal(Object.hasOwn(messages[0], 'attachment'), false);

  const legacyListed = await post(baseUrl, '/api/chat/messages/list', {
    threadId: 'chat-multi-vision', afterRevision: 0, limit: 20
  }, { cookie: auth.cookie, csrf: auth.csrf });
  const legacyMessage = (await legacyListed.json()).messages[0];
  assert.equal(legacyMessage.attachment.attachmentId, attachments[0].attachmentId);
  assert.equal(Object.hasOwn(legacyMessage, 'attachments'), false);

  const ambiguous = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-multi-vision',
    messageId: 'message-multi-ambiguous-user',
    generationId: 'generation-multi-ambiguous',
    assistantMessageId: 'message-multi-ambiguous-assistant',
    content: 'Reject ambiguous attachment shapes.',
    expectedRevision: 2,
    expectedHash: state.directChatStore.getThread(PRINCIPAL_ID, 'chat-multi-vision').ledgerHash,
    attachment: attachments[0],
    attachments
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-multi-ambiguous-01'
  });
  assert.equal(ambiguous.status, 400);
  assert.equal((await ambiguous.json()).error.code, 'invalid_attachment');
});

test('gives an authenticated vision upload a longer bounded body deadline', async (t) => {
  const state = testState(t, {
    visionEnabled: true,
    connector: {
      async generate() { return (async function* () { yield 'accepted'; })(); }
    },
    limits: { bodyTimeoutMs: 50, visionBodyTimeoutMs: 1_000 }
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'chat-slow-vision-upload', title: ''
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'create-chat-slow-vision-01'
  });
  const image = Buffer.from(createPwaIcon(192));
  const body = JSON.stringify({
    threadId: 'chat-slow-vision-upload',
    messageId: 'message-slow-vision-user',
    generationId: 'generation-slow-vision',
    assistantMessageId: 'message-slow-vision-assistant',
    content: 'Inspect this image.',
    expectedRevision: 0,
    expectedHash: null,
    attachment: {
      attachmentId: 'image-slow-vision-00000001',
      mediaType: 'image/png',
      data: image.toString('base64')
    }
  });
  const target = new URL(baseUrl);
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: '/api/chat/runs/start',
      method: 'POST',
      headers: fetchMetadata(baseUrl, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body, 'utf8')),
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'idempotency-key': 'start-chat-slow-vision-01'
      })
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    const split = Math.floor(body.length / 2);
    request.write(body.slice(0, split));
    setTimeout(() => request.end(body.slice(split)), 100);
  });
  assert.equal(result.status, 202, result.body);
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-slow-vision-upload',
    generationId: 'generation-slow-vision'
  })?.status === 'completed');
});

test('keeps vision capability and new image persistence fail-closed when disabled', async (t) => {
  let dispatches = 0;
  const state = testState(t, {
    connector: {
      async generate() {
        dispatches += 1;
        return (async function* () { yield 'must not run'; })();
      }
    }
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  const capabilities = await post(baseUrl, '/api/chat/capabilities', {}, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.deepEqual(await capabilities.json(), {
    visionInput: false,
    visionMediaTypes: [],
    maximumImageBytes: 0
  });
  await post(baseUrl, '/api/chat/threads/create', {
    threadId: 'chat-vision-disabled', title: ''
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'create-chat-vision-disabled-01'
  });
  const image = Buffer.from(createPwaIcon(192));
  const rejected = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-vision-disabled',
    messageId: 'message-vision-disabled-user',
    generationId: 'generation-vision-disabled',
    assistantMessageId: 'message-vision-disabled-assistant',
    content: 'Do not persist this image.',
    expectedRevision: 0,
    expectedHash: null,
    attachment: {
      attachmentId: 'image-vision-disabled',
      mediaType: 'image/png',
      data: image.toString('base64')
    }
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-disabled-01'
  });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'vision_unavailable');
  assert.equal(state.directChatStore.getThread(PRINCIPAL_ID, 'chat-vision-disabled').revision, 0);
  assert.equal(dispatches, 0);
});

test('rollback server exactly replays a large committed image turn while rejecting every new vision mutation', async (t) => {
  let enabledDispatches = 0;
  const state = testState(t, {
    visionEnabled: true,
    connector: {
      async generate() {
        enabledDispatches += 1;
        return (async function* () { yield 'Committed vision response'; })();
      }
    }
  });
  const first = await state.start();
  const auth = await login(first.baseUrl);
  const threadId = 'chat-vision-rollback-replay';
  assert.equal((await post(first.baseUrl, '/api/chat/threads/create', {
    threadId,
    title: 'Vision rollback replay'
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'create-chat-vision-rollback-01'
  })).status, 201);

  const image = Buffer.from(createPwaIcon(512));
  const startBody = {
    threadId,
    messageId: 'message-vision-rollback-user',
    generationId: 'generation-vision-rollback',
    assistantMessageId: 'message-vision-rollback-assistant',
    content: `Describe this image without losing the committed request. ${'x'.repeat(40 * 1024)}`,
    expectedRevision: 0,
    expectedHash: null,
    attachment: {
      attachmentId: 'image-vision-rollback-00000001',
      mediaType: 'image/png',
      data: image.toString('base64')
    }
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(startBody), 'utf8');
  assert.ok(encodedBytes > CLOUD_HTTP_LIMITS.chatBodyBytes, 'the replay exercises the former disabled 72 KiB cap');
  assert.ok(encodedBytes < CLOUD_HTTP_LIMITS.visionChatBodyBytes);

  // Treat the accepted response as lost; only durable state may authorize the retry after rollback.
  await post(first.baseUrl, '/api/chat/runs/start', startBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-rollback-01'
  });
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId,
    generationId: startBody.generationId
  })?.status === 'completed');
  assert.equal(enabledDispatches, 1);
  await state.stop(first.server);
  const beforeRollback = {
    thread: state.directChatStore.getThread(PRINCIPAL_ID, threadId),
    messages: state.directChatStore.listMessages({ accountId: PRINCIPAL_ID, threadId }),
    generation: state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId,
      generationId: startBody.generationId
    }),
    attachment: state.directChatStore.getVisionAttachment({
      accountId: PRINCIPAL_ID,
      threadId,
      attachmentId: startBody.attachment.attachmentId
    })
  };
  state.directChatStore.close();

  const rollbackStore = state.registerStore(new DirectChatStore({
    databasePath: join(state.root, 'chat', 'chat.sqlite'),
    modelAlias: 'local-test',
    enableVisionAttachments: false
  }));
  let rollbackStartCalls = 0;
  const observedRollbackStore = new Proxy(rollbackStore, {
    get(target, property) {
      if (property === 'startTurn') {
        return (input) => {
          rollbackStartCalls += 1;
          return target.startTurn(input);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const rollbackContext = new DirectChatContextCoordinator({
    store: rollbackStore,
    maxContextBytes: 512 * 1024,
    contextWindowTokens: 600_000,
    outputTokenReserve: 64_000,
    protocolTokenReserve: 32_000,
    minimumRecentTurns: 4
  });
  let rollbackDispatches = 0;
  const second = await state.start({
    directChatStore: observedRollbackStore,
    directChatContext: rollbackContext,
    visionEnabled: false,
    directChatConnector: {
      async generate() {
        rollbackDispatches += 1;
        return (async function* () { yield 'must never dispatch'; })();
      }
    }
  });

  const replay = await post(second.baseUrl, '/api/chat/runs/start', startBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-rollback-01'
  });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).generation.status, 'completed');
  assert.equal(rollbackStartCalls, 1, 'the exact retry reaches the store replay authority');
  assert.equal(rollbackDispatches, 0);

  const mismatched = await post(second.baseUrl, '/api/chat/runs/start', {
    ...startBody,
    content: `${startBody.content}!`
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-rollback-01'
  });
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).error.code, 'idempotency_conflict');
  assert.equal(rollbackStartCalls, 2, 'a mismatched retry is rejected by the store receipt');

  const malformed = await post(second.baseUrl, '/api/chat/runs/start', {
    ...startBody,
    messageId: 'message-vision-rollback-malformed-user',
    generationId: 'generation-vision-rollback-malformed',
    assistantMessageId: 'message-vision-rollback-malformed-assistant',
    content: 'Malformed image input must be validated before the disabled feature gate.',
    expectedRevision: beforeRollback.thread.revision,
    expectedHash: beforeRollback.thread.ledgerHash,
    attachment: {
      attachmentId: 'image-vision-rollback-malformed',
      mediaType: 'image/png',
      data: Buffer.from('not an image').toString('base64')
    }
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-rollback-malformed'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_attachment');

  const newImage = await post(second.baseUrl, '/api/chat/runs/start', {
    ...startBody,
    messageId: 'message-vision-rollback-new-user',
    generationId: 'generation-vision-rollback-new',
    assistantMessageId: 'message-vision-rollback-new-assistant',
    content: 'A genuinely new image turn must remain disabled.',
    expectedRevision: beforeRollback.thread.revision,
    expectedHash: beforeRollback.thread.ledgerHash,
    attachment: {
      ...startBody.attachment,
      attachmentId: 'image-vision-rollback-new-0001'
    }
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-rollback-new-01'
  });
  assert.equal(newImage.status, 503);
  assert.equal((await newImage.json()).error.code, 'vision_unavailable');

  const newTextFollowup = await post(second.baseUrl, '/api/chat/runs/start', {
    threadId,
    messageId: 'message-vision-rollback-text-user',
    generationId: 'generation-vision-rollback-text',
    assistantMessageId: 'message-vision-rollback-text-assistant',
    content: 'A new text follow-up must not silently invoke the disabled vision model.',
    expectedRevision: beforeRollback.thread.revision,
    expectedHash: beforeRollback.thread.ledgerHash
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-vision-rollback-text-01'
  });
  assert.equal(newTextFollowup.status, 503);
  assert.equal((await newTextFollowup.json()).error.code, 'vision_unavailable');
  assert.equal(rollbackDispatches, 0);
  assert.deepEqual({
    thread: rollbackStore.getThread(PRINCIPAL_ID, threadId),
    messages: rollbackStore.listMessages({ accountId: PRINCIPAL_ID, threadId }),
    generation: rollbackStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId,
      generationId: startBody.generationId
    }),
    attachment: rollbackStore.getVisionAttachment({
      accountId: PRINCIPAL_ID,
      threadId,
      attachmentId: startBody.attachment.attachmentId
    })
  }, beforeRollback, 'rollback replay and rejected requests do not alter durable chat state');
});

test('does not redispatch a partially streamed stateless generation after restart', async (t) => {
  let firstSignal;
  const firstConnector = {
    async generate({ modelAlias, context, replay, signal, ...extra }) {
      assert.equal(modelAlias, 'local-test');
      assert.deepEqual(extra, {});
      assert.equal(context.schema, 'lazying.direct-chat.context.v1');
      assert.equal(context.messages.at(-1).content, 'Hello');
      assert.deepEqual(replay, { deltaCount: 0, lastDeltaHash: null });
      firstSignal = signal;
      return (async function* () {
        yield 'A';
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      })();
    }
  };
  const state = testState(t, { connector: firstConnector });
  const first = await state.start();
  const auth = await login(first.baseUrl);
  const create = await post(first.baseUrl, '/api/chat/threads/create', {
    threadId: 'chat-restart',
    title: 'Restart test'
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-restart-0001' });
  assert.equal(create.status, 201);
  const startBody = {
    threadId: 'chat-restart',
    messageId: 'message-restart-user',
    generationId: 'generation-restart',
    assistantMessageId: 'message-restart-assistant',
    content: 'Hello',
    expectedRevision: 0,
    expectedHash: null
  };
  const started = await post(first.baseUrl, '/api/chat/runs/start', startBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-restart-00001'
  });
  assert.equal(started.status, 202);
  await waitFor(() => {
    const generation = state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: 'chat-restart',
      generationId: 'generation-restart'
    });
    return generation?.deltaCount === 1 && generation.status === 'in_progress';
  });
  await state.stop(first.server);
  assert.equal(firstSignal.aborted, true);
  assert.equal(firstSignal.reason.code, 'server_stopping');
  assert.equal(state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-restart',
    generationId: 'generation-restart'
  }).status, 'in_progress');

  let secondDispatches = 0;
  const secondConnector = {
    async generate() {
      secondDispatches += 1;
      return (async function* () { yield 'B'; })();
    }
  };
  const second = await state.start({ directChatConnector: secondConnector });
  const replay = await post(second.baseUrl, '/api/chat/runs/start', startBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-restart-00001'
  });
  assert.equal(replay.status, 202);
  const failed = await waitFor(() => {
    const value = state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-restart',
    generationId: 'generation-restart'
    });
    return value?.status === 'failed' ? value : null;
  });
  assert.equal(failed.failureCode, 'provider_unavailable');
  assert.equal(secondDispatches, 0);
  const messages = await post(second.baseUrl, '/api/chat/messages/list', {
    threadId: 'chat-restart', afterRevision: 0, limit: 20
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(messages.status, 200);
  assert.deepEqual((await messages.json()).messages.map((message) => message.content), ['Hello']);
  const persisted = state.directChatStore.replayGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-restart',
    generationId: 'generation-restart',
    afterSequence: 0,
    limit: 20
  });
  assert.deepEqual(persisted.deltas.map((delta) => delta.content), ['A']);

  const completedReplay = await post(second.baseUrl, '/api/chat/runs/start', startBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-restart-00001'
  });
  assert.equal(completedReplay.status, 202);
  assert.equal((await completedReplay.json()).generation.status, 'failed');
});

test('status recovery reconciles an abrupt partial-delta crash without redispatch', async (t) => {
  const state = testState(t);
  const thread = state.directChatStore.createThread({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-abrupt-partial',
    title: '',
    idempotencyKey: 'create-chat-abrupt-partial-01'
  });
  const turn = state.directChatStore.startTurn({
    accountId: PRINCIPAL_ID,
    threadId: thread.threadId,
    messageId: 'message-abrupt-partial-user',
    content: 'Never duplicate this run',
    generationId: 'generation-abrupt-partial',
    assistantMessageId: 'message-abrupt-partial-assistant',
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: 'start-chat-abrupt-partial-01'
  });
  const ownerToken = 'abrupt-partial-owner-000000000000000000';
  const lease = state.directChatStore.claimGenerationLease({
    accountId: PRINCIPAL_ID,
    threadId: thread.threadId,
    generationId: turn.generation.generationId,
    ownerToken,
    ttlMs: 1_000
  });
  state.directChatStore.markGenerationDispatchStarted({
    accountId: PRINCIPAL_ID,
    threadId: thread.threadId,
    generationId: turn.generation.generationId,
    ownerToken,
    fence: lease.fence
  });
  state.directChatStore.appendGenerationDelta({
    accountId: PRINCIPAL_ID,
    threadId: thread.threadId,
    generationId: turn.generation.generationId,
    expectedSequence: 0,
    expectedHash: null,
    content: 'persisted before crash',
    dispatchLease: { ownerToken, fence: lease.fence }
  });

  const replacementStore = state.registerStore(new DirectChatStore({
    databasePath: join(state.root, 'chat', 'chat.sqlite'),
    modelAlias: 'local-test'
  }));
  const replacementContext = new DirectChatContextCoordinator({
    store: replacementStore,
    maxContextBytes: 512 * 1024,
    contextWindowTokens: 600_000,
    outputTokenReserve: 64_000,
    protocolTokenReserve: 32_000,
    minimumRecentTurns: 4
  });
  let connectorCalls = 0;
  const { baseUrl } = await state.start({
    directChatStore: replacementStore,
    directChatContext: replacementContext,
    directChatConnector: {
      async generate() {
        connectorCalls += 1;
        return (async function* () { yield 'must never run'; })();
      }
    }
  });
  const auth = await login(baseUrl);
  const status = () => post(baseUrl, '/api/chat/runs/status', {
    threadId: thread.threadId,
    generationId: turn.generation.generationId
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal((await status()).status, 200);
  assert.equal(connectorCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal((await status()).status, 200);
  const failed = await waitFor(() => {
    const generation = replacementStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: thread.threadId,
      generationId: turn.generation.generationId
    });
    return generation?.status === 'failed' ? generation : null;
  });
  assert.equal(failed.failureCode, 'provider_unavailable');
  assert.equal(connectorCalls, 0);
  assert.deepEqual(replacementStore.replayGeneration({
    accountId: PRINCIPAL_ID,
    threadId: thread.threadId,
    generationId: turn.generation.generationId,
    afterSequence: 0,
    limit: 10
  }).deltas.map((delta) => delta.content), ['persisted before crash']);
});

test('fences overlapping cloud dispatchers and resolves an ambiguous zero-delta restart without redispatch', async (t) => {
  let firstDispatches = 0;
  let secondDispatches = 0;
  let firstSignal;
  const firstConnector = {
    async generate({ signal }) {
      firstDispatches += 1;
      firstSignal = signal;
      return (async function* () {
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      })();
    }
  };
  const secondConnector = {
    async generate() {
      secondDispatches += 1;
      return (async function* () { yield 'duplicate'; })();
    }
  };
  const state = testState(t, { connector: firstConnector });
  const first = await state.start();
  const second = await state.start({ directChatConnector: secondConnector });
  const auth = await login(first.baseUrl);
  await post(first.baseUrl, '/api/chat/threads/create', {
    threadId: 'chat-overlap', title: 'Overlap'
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-overlap-0001' });
  const body = {
    threadId: 'chat-overlap',
    messageId: 'message-overlap-user',
    generationId: 'generation-overlap',
    assistantMessageId: 'message-overlap-assistant',
    content: 'Run exactly once',
    expectedRevision: 0,
    expectedHash: null
  };
  const started = await post(first.baseUrl, '/api/chat/runs/start', body, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-overlap-00001'
  });
  assert.equal(started.status, 202);
  await waitFor(() => firstDispatches === 1);
  assert.equal(state.directChatStore.getGenerationLease({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-overlap',
    generationId: 'generation-overlap'
  }).phase, 'dispatch_started');

  const overlapping = await post(second.baseUrl, '/api/chat/runs/start', body, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-overlap-00001'
  });
  assert.equal(overlapping.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstDispatches, 1);
  assert.equal(secondDispatches, 0);

  await state.stop(first.server);
  assert.equal(firstSignal.aborted, true);
  assert.equal(state.directChatStore.getGenerationLease({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-overlap',
    generationId: 'generation-overlap'
  }).phase, 'interrupted');

  const recovered = await post(second.baseUrl, '/api/chat/runs/start', body, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: 'start-chat-overlap-00001'
  });
  assert.equal(recovered.status, 202);
  const terminal = await waitFor(() => {
    const value = state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: 'chat-overlap',
      generationId: 'generation-overlap'
    });
    return value?.status === 'failed' ? value : null;
  });
  assert.equal(terminal.failureCode, 'provider_unavailable');
  assert.equal(firstDispatches, 1);
  assert.equal(secondDispatches, 0);
});

test('queues a different generation across BFF processes until global inference capacity is free', async (t) => {
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let firstDispatches = 0;
  let secondDispatches = 0;
  const firstConnector = {
    async generate() {
      firstDispatches += 1;
      return (async function* () {
        await firstMayFinish;
        yield 'first result';
      })();
    }
  };
  const secondConnector = {
    async generate() {
      secondDispatches += 1;
      return (async function* () { yield 'second result'; })();
    }
  };
  const state = testState(t, { connector: firstConnector });
  const first = await state.start();
  const second = await state.start({ directChatConnector: secondConnector });
  const auth = await login(first.baseUrl);
  for (const [baseUrl, threadId] of [
    [first.baseUrl, 'chat-global-first'],
    [second.baseUrl, 'chat-global-second']
  ]) {
    const created = await post(baseUrl, '/api/chat/threads/create', {
      threadId,
      title: threadId
    }, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      idempotency: `create-${threadId}-0001`
    });
    assert.equal(created.status, 201);
  }
  const start = (baseUrl, suffix) => post(baseUrl, '/api/chat/runs/start', {
    threadId: `chat-global-${suffix}`,
    messageId: `message-global-${suffix}-user`,
    generationId: `generation-global-${suffix}`,
    assistantMessageId: `message-global-${suffix}-assistant`,
    content: `Run ${suffix}`,
    expectedRevision: 0,
    expectedHash: null
  }, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    idempotency: `start-chat-global-${suffix}-00001`
  });

  assert.equal((await start(first.baseUrl, 'first')).status, 202);
  await waitFor(() => firstDispatches === 1);
  assert.equal((await start(second.baseUrl, 'second')).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(secondDispatches, 0);
  assert.equal(state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-global-second',
    generationId: 'generation-global-second'
  }).status, 'in_progress');

  releaseFirst();
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-global-first',
    generationId: 'generation-global-first'
  })?.status === 'completed');
  const secondCompleted = await waitFor(() => {
    const generation = state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: 'chat-global-second',
      generationId: 'generation-global-second'
    });
    return generation?.status === 'completed' ? generation : null;
  });
  assert.equal(secondCompleted.status, 'completed');
  assert.equal(firstDispatches, 1);
  assert.equal(secondDispatches, 1);
});

test('fails a globally queued generation truthfully if its admission deadline expires', async (t) => {
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let firstDispatches = 0;
  let secondDispatches = 0;
  const state = testState(t, {
    connector: {
      async generate() {
        firstDispatches += 1;
        return (async function* () {
          await firstMayFinish;
          yield 'first result';
        })();
      }
    }
  });
  // Keep the admission owner alive well beyond the assertion window. A busy
  // CI runner must not make this fixture release the global slot before the
  // deliberately short second deadline is observed.
  const first = await state.start({ limits: { jobTimeoutMs: 10_000 } });
  const second = await state.start({
    directChatConnector: {
      async generate() {
        secondDispatches += 1;
        return (async function* () { yield 'must not run'; })();
      }
    },
    limits: { jobTimeoutMs: 50 }
  });
  const auth = await login(first.baseUrl);
  const startThread = async (baseUrl, suffix) => {
    assert.equal((await post(baseUrl, '/api/chat/threads/create', {
      threadId: `chat-deadline-${suffix}`,
      title: ''
    }, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      idempotency: `create-chat-deadline-${suffix}-01`
    })).status, 201);
    return post(baseUrl, '/api/chat/runs/start', {
      threadId: `chat-deadline-${suffix}`,
      messageId: `message-deadline-${suffix}-user`,
      generationId: `generation-deadline-${suffix}`,
      assistantMessageId: `message-deadline-${suffix}-assistant`,
      content: suffix,
      expectedRevision: 0,
      expectedHash: null
    }, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      idempotency: `start-chat-deadline-${suffix}-0001`
    });
  };
  assert.equal((await startThread(first.baseUrl, 'first')).status, 202);
  await waitFor(() => firstDispatches === 1);
  assert.equal((await startThread(second.baseUrl, 'second')).status, 202);
  const failed = await waitFor(() => {
    const generation = state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: 'chat-deadline-second',
      generationId: 'generation-deadline-second'
    });
    return generation?.status === 'failed' ? generation : null;
  });
  assert.equal(failed.failureCode, 'timeout');
  assert.equal(secondDispatches, 0);
  releaseFirst();
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-deadline-first',
    generationId: 'generation-deadline-first'
  })?.status === 'completed');
});

test('SSE disconnect stops only delivery; cancellation stops the durable generation', async (t) => {
  let connectorAborted = false;
  const connector = {
    async generate({ signal }) {
      signal.addEventListener('abort', () => { connectorAborted = true; }, { once: true });
      return (async function* () {
        yield 'streaming';
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      })();
    }
  };
  const state = testState(t, { connector, limits: { ssePollMs: 5, sseLifetimeMs: 1_000 } });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', { threadId: 'chat-sse', title: '' }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-sse-000001'
  });
  await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-sse',
    messageId: 'message-sse-user',
    generationId: 'generation-sse',
    assistantMessageId: 'message-sse-assistant',
    content: 'Stream',
    expectedRevision: 0,
    expectedHash: null
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-sse-0000001' });
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-sse',
    generationId: 'generation-sse'
  })?.deltaCount === 1);

  const abort = new AbortController();
  const events = await post(baseUrl, '/api/chat/runs/events', {
    threadId: 'chat-sse', generationId: 'generation-sse', afterSequence: 0
  }, { cookie: auth.cookie, csrf: auth.csrf, signal: abort.signal });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get('cache-control'), 'no-store');
  const first = await events.body.getReader().read();
  const firstText = new TextDecoder().decode(first.value);
  assert.match(firstText, /event: delta/u);
  assertNoOwnerIdentity(firstText);
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connectorAborted, false);
  assert.equal(state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-sse',
    generationId: 'generation-sse'
  }).status, 'in_progress');

  const cancelled = await post(baseUrl, '/api/chat/runs/cancel', {
    threadId: 'chat-sse', generationId: 'generation-sse'
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'cancel-chat-sse-000001' });
  assert.equal(cancelled.status, 200);
  const cancelledBody = await cancelled.json();
  assertNoOwnerIdentity(cancelledBody);
  assert.equal(cancelledBody.generation.status, 'cancelled');
  await waitFor(() => connectorAborted);
});

test('hard SSE lifetime gives a healthy reader an exact reconnect cursor', async (t) => {
  let connectorAborted = false;
  const connector = {
    async generate({ signal }) {
      signal.addEventListener('abort', () => { connectorAborted = true; }, { once: true });
      return (async function* () {
        yield 'vision';
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      })();
    }
  };
  const state = testState(t, { connector, limits: { ssePollMs: 5, sseLifetimeMs: 100 } });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', { threadId: 'chat-sse-reconnect', title: '' }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-sse-reconnect-01'
  });
  await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-sse-reconnect',
    messageId: 'message-sse-reconnect-user',
    generationId: 'generation-sse-reconnect',
    assistantMessageId: 'message-sse-reconnect-assistant',
    content: 'Inspect',
    expectedRevision: 0,
    expectedHash: null
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-sse-reconnect-01' });
  await waitFor(() => state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-sse-reconnect',
    generationId: 'generation-sse-reconnect'
  })?.deltaCount === 1);

  const events = await post(baseUrl, '/api/chat/runs/events', {
    threadId: 'chat-sse-reconnect', generationId: 'generation-sse-reconnect', afterSequence: 0
  }, { cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(events.status, 200);
  const body = await events.text();
  assert.match(body, /id: 1\nevent: delta\n/u);
  assert.match(body, /event: reconnect\ndata: \{"afterSequence":1\}\n\n$/u);
  assertNoOwnerIdentity(body);
  assert.equal(state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-sse-reconnect',
    generationId: 'generation-sse-reconnect'
  }).status, 'in_progress');
  assert.equal(connectorAborted, false);

  await post(baseUrl, '/api/chat/runs/cancel', {
    threadId: 'chat-sse-reconnect', generationId: 'generation-sse-reconnect'
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'cancel-chat-sse-reconnect-01' });
  await waitFor(() => connectorAborted);
});

test('bounds event streams globally and per browser session, then releases slots on detach', async (t) => {
  const state = testState(t, {
    limits: { concurrentStreams: 2, concurrentStreamsPerSession: 1, sseLifetimeMs: 1_000, ssePollMs: 5 }
  });
  state.directChatStore.createThread({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-stream-admission',
    title: '',
    idempotencyKey: 'create-stream-admission-01'
  });
  const message = state.directChatStore.sendUserMessage({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-stream-admission',
    messageId: 'message-stream-admission',
    content: 'wait',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'message-stream-admission-1'
  });
  state.directChatStore.startGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-stream-admission',
    generationId: 'generation-stream-admission',
    assistantMessageId: 'assistant-stream-admission',
    expectedRevision: message.revision,
    expectedHash: message.messageHash,
    idempotencyKey: 'generation-stream-admission'
  });
  const { baseUrl } = await state.start();
  const firstAuth = await login(baseUrl, { clientAddress: '203.0.113.31' });
  const secondAuth = await login(baseUrl, { clientAddress: '203.0.113.32' });
  const thirdAuth = await login(baseUrl, { clientAddress: '203.0.113.33' });
  const streamBody = {
    threadId: 'chat-stream-admission', generationId: 'generation-stream-admission', afterSequence: 0
  };
  const firstAbort = new AbortController();
  const first = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: firstAuth.cookie, csrf: firstAuth.csrf, signal: firstAbort.signal
  });
  assert.equal(first.status, 200);
  const sameSession = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: firstAuth.cookie, csrf: firstAuth.csrf
  });
  assert.equal(sameSession.status, 429);
  assert.equal(sameSession.headers.get('retry-after'), '2');
  const secondAbort = new AbortController();
  const second = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: secondAuth.cookie, csrf: secondAuth.csrf, signal: secondAbort.signal
  });
  assert.equal(second.status, 200);
  const globallyLimited = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: thirdAuth.cookie, csrf: thirdAuth.csrf
  });
  assert.equal(globallyLimited.status, 429);
  firstAbort.abort();
  secondAbort.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const recoveredAbort = new AbortController();
  const recovered = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: thirdAuth.cookie, csrf: thirdAuth.csrf, signal: recoveredAbort.signal
  });
  assert.equal(recovered.status, 200);
  recoveredAbort.abort();
});

test('hard SSE lifetime releases a slot even when the client stops reading', async (t) => {
  const state = testState(t);
  state.directChatStore.createThread({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-backpressure',
    title: '',
    idempotencyKey: 'create-chat-backpressure-01'
  });
  const message = state.directChatStore.sendUserMessage({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-backpressure',
    messageId: 'message-backpressure',
    content: 'wait',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'message-chat-backpressure-01'
  });
  state.directChatStore.startGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-backpressure',
    generationId: 'generation-backpressure',
    assistantMessageId: 'assistant-backpressure',
    expectedRevision: message.revision,
    expectedHash: message.messageHash,
    idempotencyKey: 'generation-chat-backpressure-01'
  });
  const floodStore = new Proxy(state.directChatStore, {
    get(target, property) {
      if (property === 'replayGeneration') {
        return ({ afterSequence }) => ({
          generation: target.getGeneration({
            accountId: PRINCIPAL_ID,
            threadId: 'chat-backpressure',
            generationId: 'generation-backpressure'
          }),
          deltas: Array.from({ length: 200 }, (_, index) => ({
            accountId: PRINCIPAL_ID,
            threadId: 'chat-backpressure',
            generationId: 'generation-backpressure',
            sequence: afterSequence + index + 1,
            content: 'x'.repeat(16 * 1024),
            contentBytes: 16 * 1024,
            previousHash: index === 0 ? null : 'a'.repeat(64),
            deltaHash: 'b'.repeat(64),
            createdAt: '2026-08-20T00:00:00.000Z'
          })),
          hasMore: true
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const { baseUrl } = await state.start({
    directChatStore: floodStore,
    limits: {
      concurrentStreams: 1,
      concurrentStreamsPerSession: 1,
      sseLifetimeMs: 100,
      ssePollMs: 5
    }
  });
  const auth = await login(baseUrl);
  const streamBody = {
    threadId: 'chat-backpressure',
    generationId: 'generation-backpressure',
    afterSequence: 0
  };
  const first = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: auth.cookie,
    csrf: auth.csrf
  });
  assert.equal(first.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const secondAbort = new AbortController();
  const second = await post(baseUrl, '/api/chat/runs/events', streamBody, {
    cookie: auth.cookie,
    csrf: auth.csrf,
    signal: secondAbort.signal
  });
  assert.equal(second.status, 200);
  secondAbort.abort();
  await first.body?.cancel().catch(() => {});
});

test('fails a non-cooperative Direct Chat connector at the bounded job timeout', async (t) => {
  const connector = {
    generate() { return new Promise(() => {}); }
  };
  const state = testState(t, { connector, limits: { jobTimeoutMs: 50 } });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', { threadId: 'chat-timeout', title: '' }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-timeout-001'
  });
  await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-timeout',
    messageId: 'message-timeout-user',
    generationId: 'generation-timeout',
    assistantMessageId: 'message-timeout-assistant',
    content: 'Timeout',
    expectedRevision: 0,
    expectedHash: null
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-timeout-0001' });
  const generation = await waitFor(() => {
    const value = state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: 'chat-timeout',
      generationId: 'generation-timeout'
    });
    return value?.status === 'failed' ? value : null;
  });
  assert.equal(generation.failureCode, 'timeout');
});

test('gives accepted vision inference its separate bounded job timeout', async (t) => {
  const image = Buffer.from(createPwaIcon(192));
  const connector = {
    generate() { return new Promise(() => {}); }
  };
  const state = testState(t, {
    visionEnabled: true,
    connector,
    limits: { jobTimeoutMs: 50, visionJobTimeoutMs: 250 }
  });
  const { baseUrl } = await state.start();
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', { threadId: 'chat-vision-timeout', title: '' }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-vision-timeout-01'
  });
  const started = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-vision-timeout',
    messageId: 'message-vision-timeout-user',
    generationId: 'generation-vision-timeout',
    assistantMessageId: 'message-vision-timeout-assistant',
    content: 'Inspect this image without using the text deadline.',
    expectedRevision: 0,
    expectedHash: null,
    attachment: {
      attachmentId: 'image-vision-timeout-000001',
      mediaType: 'image/png',
      data: image.toString('base64')
    }
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-vision-timeout-001' });
  assert.equal(started.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const active = state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-vision-timeout',
    generationId: 'generation-vision-timeout'
  });
  assert.equal(active.status, 'in_progress', 'the shorter text deadline does not interrupt accepted vision work');
  const failed = await waitFor(() => {
    const value = state.directChatStore.getGeneration({
      accountId: PRINCIPAL_ID,
      threadId: 'chat-vision-timeout',
      generationId: 'generation-vision-timeout'
    });
    return value?.status === 'failed' ? value : null;
  });
  assert.equal(failed.failureCode, 'timeout');
});

test('graceful shutdown aborts and drains background generation work before store handoff', async (t) => {
  let connectorSignal;
  let entered = false;
  const connector = {
    generate({ signal }) {
      connectorSignal = signal;
      entered = true;
      return new Promise(() => {});
    }
  };
  const state = testState(t, { connector, limits: { jobTimeoutMs: 5_000 } });
  const { server, baseUrl } = await state.start();
  const auth = await login(baseUrl);
  await post(baseUrl, '/api/chat/threads/create', { threadId: 'chat-shutdown', title: '' }, {
    cookie: auth.cookie, csrf: auth.csrf, idempotency: 'create-chat-shutdown-001'
  });
  const started = await post(baseUrl, '/api/chat/runs/start', {
    threadId: 'chat-shutdown',
    messageId: 'message-shutdown-user',
    generationId: 'generation-shutdown',
    assistantMessageId: 'message-shutdown-assistant',
    content: 'Wait for shutdown',
    expectedRevision: 0,
    expectedHash: null
  }, { cookie: auth.cookie, csrf: auth.csrf, idempotency: 'start-chat-shutdown-0001' });
  assert.equal(started.status, 202);
  await waitFor(() => entered);
  const handler = server.listeners('request')[0];
  assert.equal(handler.activeDirectChatJobs, 1);
  await server.shutdown();
  assert.equal(server.listening, false);
  assert.equal(connectorSignal.aborted, true);
  assert.equal(connectorSignal.reason.code, 'server_stopping');
  assert.equal(handler.activeDirectChatJobs, 0);
  assert.equal(state.directChatStore.getGeneration({
    accountId: PRINCIPAL_ID,
    threadId: 'chat-shutdown',
    generationId: 'generation-shutdown'
  }).status, 'in_progress');
});
