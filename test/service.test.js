import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadServiceConfig } from '../src/service-config.js';
import {
  checkStandaloneServiceHealth,
  checkStandaloneServiceConfiguration,
  createStandaloneServiceEdgeRouteManifest,
  createStandaloneService
} from '../src/service.js';
import { verifyStandaloneAssetMap } from '../src/web/asset-map.js';

const PASSWORD_RECORD = 'scrypt$v=1$n=131072,r=8,p=1$ABEiM0RVZneImaq7zN3u_w$ODwJaN-PM0aUzMtLvhFdDx1N8hFXxjq516BA_8qqt8ZvPCFPrAO-5S8bx0vVTiFV-6f3T9LPL5YPBEUJ6yTR2Q';
const LOCAL_TOKEN = 'service-local-token-0000000000001';
const AGINTI_TOKEN = 'service-aginti-token-0000000000001';

function serviceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-service-test-'));
  const credentialsDirectory = join(root, 'credentials');
  const configPath = join(root, 'service.json');
  const cloudIndexDatabase = join(root, 'state', 'cloud', 'index.sqlite');
  const directChatDatabase = join(root, 'state', 'chat', 'chat.sqlite');
  mkdirSync(credentialsDirectory, { mode: 0o700 });
  writeFileSync(join(credentialsDirectory, 'login-password-hash'), PASSWORD_RECORD, { mode: 0o400 });
  writeFileSync(join(credentialsDirectory, 'localllm-token'), LOCAL_TOKEN, { mode: 0o400 });
  writeFileSync(join(credentialsDirectory, 'aginti-token'), AGINTI_TOKEN, { mode: 0o400 });
  const config = {
    schema: 'lazying-agent-service/v1',
    listen: { host: '127.0.0.1', port: 18_544 },
    publicOrigin: 'https://llm.test',
    account: {
      username: 'lachlanchen',
      principalId: 'principal_account_one',
      displayName: 'Lachlan'
    },
    state: { cloudIndexDatabase, directChatDatabase },
    pwa: {
      versionLabel: 'service-test',
      title: 'LazyingArt Agent',
      name: 'LazyingArt Agent',
      shortName: 'Lazying Agent'
    },
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-test'],
      defaultModelAlias: 'localllm-test'
    },
    aginti: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:18009'
    },
    credentials: {
      passwordHash: 'login-password-hash',
      localLlmToken: 'localllm-token',
      agintiToken: 'aginti-token'
    }
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config,
    configPath,
    credentialsDirectory,
    cloudIndexDatabase,
    directChatDatabase,
    loadedConfig: loadServiceConfig({ configPath, credentialsDirectory })
  };
}

class FakeServer extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.listening = false;
    this.listenCalls = [];
    this.shutdownCalls = 0;
  }

  listen(port, host, callback) {
    this.listenCalls.push({ port, host });
    this.port = port;
    this.host = host;
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  address() {
    return this.listening ? { address: this.host, family: 'IPv4', port: this.port } : null;
  }

  async shutdown() {
    this.shutdownCalls += 1;
    const wasListening = this.listening;
    this.listening = false;
    if (wasListening) this.emit('close');
  }
}

function serviceHarness(config) {
  const captured = { serverOptions: null, requests: [] };
  const fakeServer = new FakeServer(config.listen.port);
  const serverFactory = (options) => {
    captured.serverOptions = options;
    return fakeServer;
  };
  const fetchImpl = async (url, init) => {
    captured.requests.push({ url, init });
    if (url === 'http://127.0.0.1:18009/agent/v1/capabilities') {
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
    return new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'localllm-test', object: 'model', created: 1, owned_by: 'local' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { captured, fakeServer, serverFactory, fetchImpl };
}

test('configuration check validates credentials and branded PWA without creating state', async (t) => {
  const state = serviceFixture(t);
  assert.equal(existsSync(join(state.root, 'state')), false);

  const report = await checkStandaloneServiceConfiguration(state.loadedConfig);

  assert.equal(report.valid, true);
  assert.equal(report.listen.address, undefined);
  assert.deepEqual(report.listen, { host: '127.0.0.1', port: state.config.listen.port });
  assert.equal(report.serviceWorkerRoute, '/sw.js');
  assert.match(report.releaseId, /^service-test-[a-f0-9]{64}$/u);
  assert.equal(report.agentEnabled, false);
  assert.equal(report.agentConfigured, true);
  assert.equal(existsSync(join(state.root, 'state')), false);
  const output = JSON.stringify(report);
  assert.equal(output.includes(PASSWORD_RECORD), false);
  assert.equal(output.includes(LOCAL_TOKEN), false);
  assert.equal(output.includes(AGINTI_TOKEN), false);
});

test('operator health inspects missing stores independently without creating state', async (t) => {
  const state = serviceFixture(t);
  const harness = serviceHarness(state.config);
  assert.equal(existsSync(join(state.root, 'state')), false);

  const report = await checkStandaloneServiceHealth(state.loadedConfig, {
    fetchImpl: harness.fetchImpl,
    dependencyTimeoutMs: 50,
    clock: () => new Date('2026-08-23T09:00:00.000Z')
  });

  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.storage.cloudIndexStore, {
    state: 'unavailable',
    reason: 'storage_unavailable'
  });
  assert.deepEqual(report.storage.directChatStore, {
    state: 'unavailable',
    reason: 'storage_unavailable'
  });
  assert.equal(report.dependencies.localLlm.state, 'ready');
  assert.equal(report.dependencies.aginti.state, 'ready');
  assert.equal(report.dependencies.lazyEdge.healthClaim, false);
  assert.equal(existsSync(join(state.root, 'state')), false);
  assert.deepEqual(new Set(harness.captured.requests.map(({ url }) => url)), new Set([
    'http://127.0.0.1:18008/v1/models',
    'http://127.0.0.1:18009/agent/v1/capabilities'
  ]));
  const output = JSON.stringify(report);
  assert.equal(output.includes(state.cloudIndexDatabase), false);
  assert.equal(output.includes(state.directChatDatabase), false);
  assert.equal(output.includes(LOCAL_TOKEN), false);
  assert.equal(output.includes(AGINTI_TOKEN), false);
});

test('edge route manifest binds the proxy allowlist to the exact candidate PWA', async (t) => {
  const state = serviceFixture(t);
  assert.equal(existsSync(join(state.root, 'state')), false);

  const [report, manifest] = await Promise.all([
    checkStandaloneServiceConfiguration(state.loadedConfig),
    createStandaloneServiceEdgeRouteManifest(state.loadedConfig)
  ]);

  assert.equal(manifest.schema, 'lazying-agent-web/edge-route-manifest/v1');
  assert.equal(manifest.publicOrigin, state.config.publicOrigin);
  assert.equal(manifest.releaseId, report.releaseId);
  assert.deepEqual(manifest.methods, ['GET', 'HEAD']);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.methods), true);
  assert.equal(Object.isFrozen(manifest.paths), true);
  assert.equal(Object.isFrozen(manifest.requestTargets), true);
  assert.deepEqual(manifest.paths, [...manifest.paths].sort());
  assert.equal(new Set(manifest.paths).size, manifest.paths.length);
  assert.equal(manifest.paths.every((pathname) => pathname.startsWith('/') && !pathname.includes('?')), true);
  assert.equal(manifest.requestTargets.length, manifest.paths.length + 1);
  assert.equal(manifest.paths.includes('/'), true);
  assert.equal(manifest.paths.includes('/manifest.webmanifest'), true);
  assert.equal(manifest.paths.includes('/sw.js'), true);
  assert.equal(
    manifest.requestTargets.includes(`/manifest.webmanifest?v=${manifest.releaseId}`),
    true
  );
  assert.equal(manifest.requestTargets.includes(`/?v=${manifest.releaseId}`), true);
  const immutablePaths = manifest.paths.filter((pathname) => pathname.startsWith('/assets/'));
  assert.equal(immutablePaths.length, manifest.paths.length - 3);
  assert.equal(
    immutablePaths.every((pathname) => pathname.startsWith(`/assets/r/${manifest.releaseId}/`)),
    true
  );
  assert.equal(existsSync(join(state.root, 'state')), false);
  const output = JSON.stringify(manifest);
  assert.equal(output.includes(PASSWORD_RECORD), false);
  assert.equal(output.includes(LOCAL_TOKEN), false);
  assert.equal(output.includes(AGINTI_TOKEN), false);
});

test('constructs decoupled stores, LocalLLM, context, PWA, and an exact loopback server', async (t) => {
  const state = serviceFixture(t);
  const harness = serviceHarness(state.config);
  const service = await createStandaloneService({
    loadedConfig: state.loadedConfig,
    fetchImpl: harness.fetchImpl,
    serverFactory: harness.serverFactory
  });
  t.after(async () => { await service.shutdown(); });

  const options = harness.captured.serverOptions;
  assert.equal(options.agintiAdapter, service.agintiAdapter);
  assert.ok(service.agintiAdapter);
  assert.equal(options.directChatStore, service.directChatStore);
  assert.equal(options.directChatContext, service.directChatContext);
  assert.equal(options.directChatConnector, service.directChatConnector);
  assert.equal(service.directChatSummarizer.locality, 'local');
  assert.equal(options.controlStore, service.controlStore);
  assert.equal(options.sessionStore, service.controlStore);
  assert.equal(options.releaseId, service.releaseId);
  assert.equal(service.agentEnabled, false);
  assert.equal(service.assetMap.serviceWorkerRoute, '/sw.js');
  assert.equal(verifyStandaloneAssetMap(service.assetMap), service.assetMap);
  assert.equal(service.releaseId.endsWith(`-${service.assetMap.contentDigest}`), true);
  assert.equal(service.assetMap.get('/sw.js').cacheControl, 'no-store, no-cache, must-revalidate');
  assert.notEqual(state.cloudIndexDatabase, state.directChatDatabase);
  assert.equal(existsSync(state.cloudIndexDatabase), true);
  assert.equal(existsSync(state.directChatDatabase), true);
  assert.equal(lstatSync(state.cloudIndexDatabase).mode & 0o077, 0);
  assert.equal(lstatSync(state.directChatDatabase).mode & 0o077, 0);
  assert.equal(service.account.id, state.config.account.principalId);
  assert.equal(service.controlStore.getAccount(state.config.account.principalId).subject, 'lachlanchen');

  const readiness = await service.directChatConnector.readiness();
  assert.deepEqual(readiness, { ready: true, availableModelAliases: ['localllm-test'] });
  assert.equal(harness.captured.requests.length, 1);
  assert.equal(harness.captured.requests[0].url, 'http://127.0.0.1:18008/v1/models');
  assert.equal(harness.captured.requests[0].init.headers.authorization, `Bearer ${LOCAL_TOKEN}`);

  const agentCapabilities = await service.agintiAdapter.capabilities({
    principalId: state.config.account.principalId,
    browserSession: 'a'.repeat(64)
  });
  assert.equal(agentCapabilities.enabled, false);
  assert.equal(harness.captured.requests.length, 2);
  assert.equal(harness.captured.requests[1].init.headers.get('authorization'), `Bearer ${AGINTI_TOKEN}`);
  assert.equal(harness.captured.requests[1].init.headers.get('x-aginti-principal-id'), state.config.account.principalId);
  assert.equal(harness.captured.requests[1].init.headers.get('x-lazyedge-principal-id'), null);

  const first = await service.start();
  const second = await service.start();
  assert.deepEqual(first, { address: '127.0.0.1', port: state.config.listen.port });
  assert.deepEqual(second, first);
  assert.deepEqual(harness.fakeServer.listenCalls, [
    { host: '127.0.0.1', port: state.config.listen.port }
  ]);
  await service.shutdown();
  await service.shutdown();
  assert.equal(harness.fakeServer.shutdownCalls, 1);
});

test('operator health reads both initialized stores without taking service ownership', async (t) => {
  const state = serviceFixture(t);
  const serviceHarnessValue = serviceHarness(state.config);
  const service = await createStandaloneService({
    loadedConfig: state.loadedConfig,
    fetchImpl: serviceHarnessValue.fetchImpl,
    serverFactory: serviceHarnessValue.serverFactory
  });
  t.after(async () => { await service.shutdown(); });
  const healthHarness = serviceHarness(state.config);
  const before = [state.cloudIndexDatabase, state.directChatDatabase].map((pathname) => {
    const stat = lstatSync(pathname);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  });

  const report = await checkStandaloneServiceHealth(state.loadedConfig, {
    fetchImpl: healthHarness.fetchImpl,
    dependencyTimeoutMs: 50
  });

  assert.equal(report.status, 'ready');
  assert.equal(report.component.releaseId, service.releaseId);
  assert.equal(report.storage.cloudIndexStore.state, 'ready');
  assert.equal(report.storage.cloudIndexStore.schemaVersion, 1);
  assert.equal(report.storage.directChatStore.state, 'ready');
  assert.equal(report.storage.directChatStore.schemaVersion, 2);
  assert.equal(service.controlStore.healthCheck().ready, true);
  assert.equal(service.directChatStore.healthCheck().ready, true);
  assert.equal(report.scope.publicHttpEndpoint, false);
  assert.equal(report.dependencies.lazyEdge.state, 'not_probed');
  assert.deepEqual(
    [state.cloudIndexDatabase, state.directChatDatabase].map((pathname) => {
      const stat = lstatSync(pathname);
      return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    }),
    before
  );
  await service.shutdown();
});

test('operator health keeps storage and AgInTi visible when LocalLLM credentials fail', async (t) => {
  const state = serviceFixture(t);
  const bootstrapHarness = serviceHarness(state.config);
  const service = await createStandaloneService({
    loadedConfig: state.loadedConfig,
    fetchImpl: bootstrapHarness.fetchImpl,
    serverFactory: bootstrapHarness.serverFactory
  });
  await service.shutdown();
  rmSync(join(state.credentialsDirectory, 'localllm-token'));
  const healthHarness = serviceHarness(state.config);

  const report = await checkStandaloneServiceHealth(state.loadedConfig, {
    fetchImpl: healthHarness.fetchImpl,
    dependencyTimeoutMs: 50
  });

  assert.equal(report.status, 'degraded');
  assert.equal(report.storage.cloudIndexStore.state, 'ready');
  assert.equal(report.storage.directChatStore.state, 'ready');
  assert.deepEqual(report.dependencies.localLlm, {
    state: 'unavailable',
    reason: 'dependency_unavailable'
  });
  assert.equal(report.dependencies.aginti.state, 'ready');
  assert.equal(JSON.stringify(report).includes(state.credentialsDirectory), false);
});

test('restarts over the same private databases with idempotent account provisioning', async (t) => {
  const state = serviceFixture(t);
  const firstHarness = serviceHarness(state.config);
  const first = await createStandaloneService({
    loadedConfig: state.loadedConfig,
    fetchImpl: firstHarness.fetchImpl,
    serverFactory: firstHarness.serverFactory
  });
  const firstAccount = first.account;
  await first.shutdown();

  const reloaded = loadServiceConfig({
    configPath: state.configPath,
    credentialsDirectory: state.credentialsDirectory
  });
  const secondHarness = serviceHarness(state.config);
  const second = await createStandaloneService({
    loadedConfig: reloaded,
    fetchImpl: secondHarness.fetchImpl,
    serverFactory: secondHarness.serverFactory
  });
  try {
    assert.deepEqual(second.account, firstAccount);
    assert.equal(second.controlStore.getAccount(state.config.account.principalId).issuer, 'local-login');
    assert.equal(second.controlStore.getAccount(state.config.account.principalId).subject, 'lachlanchen');
  } finally {
    await second.shutdown();
  }
});

test('constructs the real cloud server inertly without opening a listener', async (t) => {
  const state = serviceFixture(t);
  const service = await createStandaloneService({
    loadedConfig: state.loadedConfig,
    fetchImpl: async () => { throw new Error('inert construction must not probe LocalLLM'); }
  });
  try {
    assert.equal(service.server.listening, false);
    assert.equal(service.server.address(), null);
    assert.equal(service.server.releaseId, undefined);
    assert.equal(service.releaseId, service.assetMap.releaseVersion);
  } finally {
    await service.shutdown();
  }
});
