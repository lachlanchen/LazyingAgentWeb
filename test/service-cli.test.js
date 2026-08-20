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
    LAZYING_AGENT_CONFIG: '/etc/lazying-agent-web/service.json'
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
    async serviceFactory() { return service; },
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
