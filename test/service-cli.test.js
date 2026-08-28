import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runCli } from '../src/cli.js';

function outputCollector() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    text() { return value; },
    json() { return JSON.parse(value); }
  };
}

function environment() {
  return {
    CREDENTIALS_DIRECTORY: '/run/credentials/lazying-agent-web.service',
    LAZYING_AGENT_CONFIG: '/etc/lazying-agent-web/service.json',
    RUNTIME_DIRECTORY: '/run/lazying-agent-web'
  };
}

test('config-check accepts only config location and emits a secret-free report', async () => {
  const stdout = outputCollector();
  const loaded = Object.freeze({ kind: 'loaded' });
  let loaderInput;
  const code = await runCli({
    argv: ['config-check'],
    env: environment(),
    stdout,
    configLoader(input) {
      loaderInput = input;
      return loaded;
    },
    async configChecker(value) {
      assert.equal(value, loaded);
      return {
        valid: true,
        releaseId: `test-${'a'.repeat(64)}`,
        serviceWorkerRoute: '/sw.js',
        agentEnabled: false
      };
    },
    serviceFactory() { throw new Error('serve factory must not run'); },
    terminationWaiter() { throw new Error('termination waiter must not run'); }
  });

  assert.equal(code, 0);
  assert.deepEqual(loaderInput, {
    configPath: environment().LAZYING_AGENT_CONFIG,
    credentialsDirectory: environment().CREDENTIALS_DIRECTORY
  });
  assert.deepEqual(stdout.json(), {
    ok: true,
    command: 'config-check',
    valid: true,
    releaseId: `test-${'a'.repeat(64)}`,
    serviceWorkerRoute: '/sw.js',
    agentEnabled: false
  });
  assert.equal(stdout.text().includes('password'), false);
  assert.equal(stdout.text().includes('token'), false);
});

test('edge-routes emits the candidate build exact static route contract', async () => {
  const stdout = outputCollector();
  const loaded = Object.freeze({ kind: 'loaded' });
  const releaseId = `release-${'c'.repeat(64)}`;
  const code = await runCli({
    argv: ['edge-routes', '--config', '/private/service.json'],
    env: environment(),
    stdout,
    configLoader: () => loaded,
    configChecker() { throw new Error('config checker must not run'); },
    async edgeRouteManifestBuilder(value) {
      assert.equal(value, loaded);
      return {
        schema: 'lazying-agent-web/edge-route-manifest/v1',
        publicOrigin: 'https://llm.test',
        releaseId,
        methods: ['GET', 'HEAD'],
        paths: ['/', `/assets/r/${releaseId}/app.js`, '/manifest.webmanifest', '/sw.js'],
        requestTargets: ['/', `/assets/r/${releaseId}/app.js`, `/manifest.webmanifest?v=${releaseId}`, '/sw.js']
      };
    },
    serviceFactory() { throw new Error('serve factory must not run'); },
    terminationWaiter() { throw new Error('termination waiter must not run'); }
  });

  assert.equal(code, 0);
  assert.deepEqual(stdout.json(), {
    ok: true,
    command: 'edge-routes',
    schema: 'lazying-agent-web/edge-route-manifest/v1',
    publicOrigin: 'https://llm.test',
    releaseId,
    methods: ['GET', 'HEAD'],
    paths: ['/', `/assets/r/${releaseId}/app.js`, '/manifest.webmanifest', '/sw.js'],
    requestTargets: ['/', `/assets/r/${releaseId}/app.js`, `/manifest.webmanifest?v=${releaseId}`, '/sw.js']
  });
  assert.equal(stdout.text().includes('password'), false);
  assert.equal(stdout.text().includes('token'), false);
});

test('health is operator-only, reports the bounded contract, and exits nonzero when degraded', async () => {
  const stdout = outputCollector();
  const loaded = Object.freeze({ kind: 'loaded' });
  const releaseId = `release-${'d'.repeat(64)}`;
  let checked = 0;
  const code = await runCli({
    argv: ['health', '--config', '/private/service.json'],
    env: environment(),
    stdout,
    configLoader: () => loaded,
    configChecker() { throw new Error('config checker must not run'); },
    async healthChecker(value) {
      assert.equal(value, loaded);
      checked += 1;
      return {
        schema: 'lazying-agent-web/operator-health/v1',
        checkedAt: '2026-08-23T09:00:00.000Z',
        status: 'degraded',
        component: { id: 'lazying-agent-web', releaseId },
        scope: { audience: 'operator', publicHttpEndpoint: false, staticShell: 'independent' },
        storage: {
          cloudIndexStore: { state: 'ready', schemaVersion: 1, sqliteVersion: '3.47.2' },
          directChatStore: { state: 'ready', schemaVersion: 2, sqliteVersion: '3.47.2' }
        },
        dependencies: {
          localLlm: { state: 'unavailable', reason: 'timeout' },
          aginti: { state: 'not_configured' },
          lazyEdge: { state: 'not_probed', healthClaim: false, authority: 'lazyedge' }
        }
      };
    },
    serviceFactory() { throw new Error('serve factory must not run'); },
    terminationWaiter() { throw new Error('termination waiter must not run'); }
  });

  assert.equal(code, 1);
  assert.equal(checked, 1);
  assert.equal(stdout.json().ok, false);
  assert.equal(stdout.json().command, 'health');
  assert.equal(stdout.json().component.releaseId, releaseId);
  assert.equal(stdout.json().scope.publicHttpEndpoint, false);
  assert.equal(stdout.json().dependencies.lazyEdge.healthClaim, false);
  assert.equal(stdout.text().includes('/private/service.json'), false);
  assert.equal(stdout.text().includes('CREDENTIALS_DIRECTORY'), false);
});

test('serve binds through the service only and always performs graceful shutdown', async () => {
  const stdout = outputCollector();
  const server = new EventEmitter();
  let starts = 0;
  let shutdowns = 0;
  let waited = 0;
  const service = {
    server,
    publicOrigin: 'https://llm.test',
    releaseId: `test-${'b'.repeat(64)}`,
    async start() {
      starts += 1;
      return { address: '127.0.0.1', port: 18_543 };
    },
    async shutdown() { shutdowns += 1; }
  };

  const code = await runCli({
    argv: ['serve', '--config', '/private/service.json'],
    env: environment(),
    stdout,
    configLoader: () => Object.freeze({ kind: 'loaded' }),
    configChecker() { throw new Error('config checker must not run'); },
    async serviceFactory(input) {
      assert.equal(input.rolloutAdmissionSocketPath, '/run/lazying-agent-web/admission.sock');
      return service;
    },
    async terminationWaiter(value) {
      assert.equal(value, service);
      waited += 1;
    }
  });

  assert.equal(code, 0);
  assert.equal(starts, 1);
  assert.equal(waited, 1);
  assert.equal(shutdowns, 1);
  assert.deepEqual(stdout.json(), {
    ok: true,
    command: 'serve',
    status: 'listening',
    address: '127.0.0.1',
    port: 18_543,
    publicOrigin: 'https://llm.test',
    releaseId: `test-${'b'.repeat(64)}`,
    agentEnabled: false
  });
});

test('rejects secret-bearing or unsupported argv and shuts down after start failure', async () => {
  const common = {
    env: environment(),
    stdout: outputCollector(),
    configLoader: () => Object.freeze({}),
    configChecker: async () => ({}),
    serviceFactory: async () => ({})
  };
  await assert.rejects(runCli({ ...common, argv: ['serve', '--password', 'secret'] }), TypeError);
  await assert.rejects(runCli({ ...common, argv: ['hash-password'] }), TypeError);
  await assert.rejects(runCli({ ...common, argv: ['serve', '--token', 'secret'] }), TypeError);
  for (const runtimeDirectory of [undefined, 'relative/run', '/run/one:/run/two', '/']) {
    const env = { ...environment(), RUNTIME_DIRECTORY: runtimeDirectory };
    if (runtimeDirectory === undefined) delete env.RUNTIME_DIRECTORY;
    await assert.rejects(runCli({ ...common, argv: ['serve'], env }), TypeError);
  }

  let shutdowns = 0;
  await assert.rejects(runCli({
    ...common,
    argv: ['serve'],
    serviceFactory: async () => ({
      server: new EventEmitter(),
      async start() { throw new Error('listen failed'); },
      async shutdown() { shutdowns += 1; }
    }),
    terminationWaiter: async () => {}
  }), /listen failed/u);
  assert.equal(shutdowns, 1);
});
