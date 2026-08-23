import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_HEALTH_SCHEMA,
  createOperatorHealthReport
} from '../src/index.js';
import { classifyRequestTarget } from '../src/http-contract.js';
import { StorageCorruptionError, StorageSecurityError } from '../src/errors.js';

const FIXED_TIME = '2026-08-23T09:00:00.000Z';
const RELEASE_ID = `release-${'a'.repeat(64)}`;
const SQLITE_HEALTH = Object.freeze({
  ready: true,
  schemaVersion: 3,
  sqliteVersion: '3.47.2'
});
const clock = () => new Date(FIXED_TIME);

function readyInput(overrides = {}) {
  return {
    releaseId: RELEASE_ID,
    cloudIndexProbe: () => SQLITE_HEALTH,
    directChatProbe: () => SQLITE_HEALTH,
    localLlmProbe: async () => ({
      ready: true,
      availableModelAliases: ['localllm-text', 'localllm-vision']
    }),
    agintiProbe: async () => ({ enabled: false }),
    dependencyTimeoutMs: 50,
    clock,
    ...overrides
  };
}

test('operator health reports independent bounded component states and release identity', async () => {
  const health = await createOperatorHealthReport(readyInput());

  assert.equal(health.schema, OPERATOR_HEALTH_SCHEMA);
  assert.equal(health.checkedAt, FIXED_TIME);
  assert.equal(health.status, 'ready');
  assert.deepEqual(health.component, {
    id: 'lazying-agent-web',
    role: 'cloud-presentation-control-plane',
    releaseId: RELEASE_ID
  });
  assert.deepEqual(health.storage, {
    cloudIndexStore: { state: 'ready', schemaVersion: 3, sqliteVersion: '3.47.2' },
    directChatStore: { state: 'ready', schemaVersion: 3, sqliteVersion: '3.47.2' }
  });
  assert.deepEqual(health.dependencies, {
    localLlm: { state: 'ready', availableModelAliasCount: 2 },
    aginti: { state: 'ready', capabilityEnabled: false },
    lazyEdge: { state: 'not_probed', healthClaim: false, authority: 'lazyedge' }
  });
  assert.deepEqual(health.scope, {
    audience: 'operator',
    publicHttpEndpoint: false,
    staticShell: 'independent'
  });
  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.isFrozen(health.storage), true);
  assert.equal(Object.isFrozen(health.dependencies.lazyEdge), true);
});

test('storage failures remain independent and redact errors in both directions', async () => {
  const cloudSecret = '/private/cloud/index.sqlite?token=cloud-secret';
  const cloudFailed = await createOperatorHealthReport(readyInput({
    cloudIndexProbe() {
      throw new StorageCorruptionError(cloudSecret);
    }
  }));
  assert.deepEqual(cloudFailed.storage.cloudIndexStore, {
    state: 'unavailable',
    reason: 'storage_corruption'
  });
  assert.equal(cloudFailed.storage.directChatStore.state, 'ready');
  assert.equal(cloudFailed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(cloudFailed), /cloud-secret|\/private\/cloud/u);

  const chatSecret = '/private/chat/chat.sqlite?token=chat-secret';
  const chatFailed = await createOperatorHealthReport(readyInput({
    directChatProbe() {
      throw new StorageSecurityError(chatSecret);
    }
  }));
  assert.equal(chatFailed.storage.cloudIndexStore.state, 'ready');
  assert.deepEqual(chatFailed.storage.directChatStore, {
    state: 'unavailable',
    reason: 'storage_security_error'
  });
  assert.equal(chatFailed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(chatFailed), /chat-secret|\/private\/chat/u);
});

test('dependency failures are bounded and cannot expand or disable the static shell', async () => {
  const localSecret = 'http://127.0.0.1:18008/v1?token=local-secret';
  const agintiSecret = 'Bearer aginti-secret-private-path';
  const health = await createOperatorHealthReport(readyInput({
    localLlmProbe: async () => new Promise(() => {}),
    agintiProbe: async () => {
      throw new Error(`${agintiSecret} /home/operator/private`);
    },
    dependencyTimeoutMs: 10
  }));

  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.dependencies.localLlm, { state: 'unavailable', reason: 'timeout' });
  assert.deepEqual(health.dependencies.aginti, {
    state: 'unavailable',
    reason: 'dependency_unavailable'
  });
  assert.deepEqual(health.dependencies.lazyEdge, {
    state: 'not_probed',
    healthClaim: false,
    authority: 'lazyedge'
  });
  const serialized = JSON.stringify(health);
  assert.equal(serialized.includes(localSecret), false);
  assert.equal(serialized.includes(agintiSecret), false);
  assert.equal(serialized.includes('/home/operator/private'), false);

  const staticAssets = { has: (target) => target === '/' };
  assert.deepEqual(classifyRequestTarget('/', staticAssets), { kind: 'asset', target: '/' });
  assert.deepEqual(classifyRequestTarget('/health', staticAssets), { kind: 'not_found' });
  assert.deepEqual(classifyRequestTarget('/api/health', staticAssets), { kind: 'not_found' });
});
