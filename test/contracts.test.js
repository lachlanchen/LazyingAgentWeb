import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPONENT_ID,
  MAX_BROWSER_SESSIONS_PER_ACCOUNT,
  createCapabilityContract,
  createHealthContract
} from '../src/index.js';
import { createTestStore } from './helpers.js';

const FIXED_TIME = '2026-08-20T08:00:00.000Z';
const clock = () => new Date(FIXED_TIME);

test('capability contract declares the decoupled authority boundary', () => {
  const contract = createCapabilityContract({ clock });

  assert.equal(contract.component.id, COMPONENT_ID);
  assert.equal(contract.component.role, 'cloud-presentation-control-plane');
  assert.deepEqual(contract.authorities, {
    agent: 'aginti',
    inference: 'localllm',
    transport: 'lazyedge',
    presentation: 'lazying-agent-web'
  });
  assert.equal(contract.capabilities.threadPresentationIndex.authoritative, false);
  assert.equal(contract.capabilities.resumableDeliveryCursor.authoritative, false);
  assert.equal(contract.capabilities.resumableDeliveryCursor.idempotencyReceipts, false);
  assert.equal(
    contract.capabilities.browserSessions.maximumPerAccount,
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );
  assert.equal(contract.capabilities.agentRuns.owner, 'aginti');
  assert.equal(contract.capabilities.agentRuns.availableThroughThisComponent, false);
  assert.equal(contract.capabilities.inference.owner, 'localllm');
  assert.equal(contract.capabilities.edgeTransport.owner, 'lazyedge');
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.capabilities));
});

test('health contract reports only local storage and never claims upstream health', (t) => {
  const { store } = createTestStore(t, { clock });
  const health = createHealthContract({ store, clock });

  assert.equal(health.status, 'ready');
  assert.equal(health.storage.ready, true);
  assert.equal(health.storage.schemaVersion, 1);
  assert.deepEqual(health.dependencies, {
    aginti: 'not_probed',
    localllm: 'not_probed',
    lazyedge: 'not_probed'
  });
  assert.doesNotMatch(JSON.stringify(health), /databasePath|\/tmp\//u);
});

test('health fails closed after storage is unavailable', (t) => {
  const { store } = createTestStore(t, { clock });
  store.close();

  const health = createHealthContract({ store, clock });
  assert.equal(health.status, 'unavailable');
  assert.equal(health.storage.ready, false);
  assert.equal(health.storage.code, 'storage_corruption');
});
