import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ROLLOUT_ADMISSION_CONTROL_SCHEMA,
  RolloutAdmissionLatch,
  createRolloutAdmissionControlServer
} from '../src/rollout-admission.js';

const OPERATION_ONE = 'rollout-operation-00000001';
const OPERATION_TWO = 'rollout-operation-00000002';
const RELEASE_ID = `release-${'a'.repeat(64)}`;

function privateFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-admission-test-'));
  const stateDirectory = join(root, 'state');
  const runDirectory = join(root, 'run');
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(runDirectory, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    markerPath: join(stateDirectory, 'rollout-admission.closed.json'),
    socketPath: join(runDirectory, 'admission.sock')
  };
}

function sendControl(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let source = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => { source += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      try { resolve(JSON.parse(source)); }
      catch (error) { reject(error); }
    });
  });
}

async function waitFor(callback, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

test('linearizes close, concurrent drain, inherited work, CAS reopen, and restart persistence', async (t) => {
  const fixture = privateFixture(t);
  const latch = new RolloutAdmissionLatch({ closedMarkerPath: fixture.markerPath });
  const requestAdmission = latch.acquire('direct-chat-start');
  const generationAdmission = requestAdmission.fork('direct-chat-generation');

  const closed = latch.close(OPERATION_ONE);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.active, 2);
  assert.equal(closed.drained, false);
  assert.match(closed.generation, /^[a-f0-9]{32}$/u);
  assert.equal(latch.acquire('agent-start-resume'), null, 'post-close admission is rejected');
  assert.equal(lstatSync(fixture.markerPath).mode & 0o777, 0o600);

  let drainSettled = false;
  const drain = latch.drain({
    operationId: OPERATION_ONE,
    expectedGeneration: closed.generation
  }).then((value) => {
    drainSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(drainSettled, false);
  await assert.rejects(latch.drain({
    operationId: OPERATION_ONE,
    expectedGeneration: '0'.repeat(32)
  }), (error) => error.code === 'admission_generation_mismatch');
  assert.throws(() => latch.reopen({
    operationId: OPERATION_ONE,
    expectedGeneration: closed.generation
  }), (error) => error.code === 'admission_busy');

  requestAdmission.release();
  await Promise.resolve();
  assert.equal(drainSettled, false, 'a child admission keeps the close drain pending');
  generationAdmission.release();
  const drained = await drain;
  assert.equal(drained.active, 0);
  assert.equal(drained.drained, true);

  // A process restart reconstructs the closed generation from the private marker.
  const restarted = new RolloutAdmissionLatch({ closedMarkerPath: fixture.markerPath });
  assert.deepEqual(restarted.snapshot(), {
    state: 'closed',
    active: 0,
    drained: false,
    operationId: OPERATION_ONE,
    generation: closed.generation
  });
  assert.equal(restarted.acquire('direct-chat-start'), null);
  await restarted.drain({ operationId: OPERATION_ONE, expectedGeneration: closed.generation });
  assert.throws(() => restarted.reopen({
    operationId: OPERATION_TWO,
    expectedGeneration: closed.generation
  }), (error) => error.code === 'admission_operation_mismatch');
  const opened = restarted.reopen({
    operationId: OPERATION_ONE,
    expectedGeneration: closed.generation
  });
  assert.deepEqual(opened, {
    state: 'open', active: 0, drained: false, operationId: null, generation: null
  });
  assert.equal(existsSync(fixture.markerPath), false);
  const admittedAgain = restarted.acquire('agent-start-resume');
  assert.ok(admittedAgain);
  admittedAgain.release();

  const newer = restarted.close(OPERATION_TWO);
  await restarted.drain({ operationId: OPERATION_TWO, expectedGeneration: newer.generation });
  assert.throws(() => restarted.reopen({
    operationId: OPERATION_ONE,
    expectedGeneration: closed.generation
  }), (error) => error.code === 'admission_operation_mismatch');
});

test('serves an owner-only release-pinned Unix protocol and never reopens after drain disconnect', async (t) => {
  const fixture = privateFixture(t);
  const latch = new RolloutAdmissionLatch({ closedMarkerPath: fixture.markerPath });
  const control = createRolloutAdmissionControlServer({
    latch,
    releaseId: RELEASE_ID,
    socketPath: fixture.socketPath
  });
  t.after(async () => control.shutdown());
  const started = await control.start();
  const socketStat = lstatSync(fixture.socketPath);
  assert.deepEqual(started, {
    path: fixture.socketPath,
    releaseId: RELEASE_ID,
    uid: socketStat.uid,
    gid: socketStat.gid,
    mode: '0600'
  });
  assert.equal(socketStat.mode & 0o777, 0o600);
  assert.equal(lstatSync(dirname(fixture.socketPath)).mode & 0o777, 0o700);

  const status = await sendControl(fixture.socketPath, {
    schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
    command: 'status'
  });
  assert.equal(status.ok, true);
  assert.equal(status.releaseId, RELEASE_ID);
  assert.deepEqual(status.socket, { uid: socketStat.uid, gid: socketStat.gid, mode: '0600' });

  const admission = latch.acquire('direct-chat-generation');
  const closed = await sendControl(fixture.socketPath, {
    schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
    command: 'close',
    operationId: OPERATION_ONE
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.active, 1);
  assert.equal(closed.drained, false);

  // Disconnect an owner after submitting drain. The durable close and server-side
  // waiter survive; neither disconnect nor the request timeout implies reopen.
  const abandoned = createConnection(fixture.socketPath);
  await new Promise((resolve, reject) => {
    abandoned.once('error', reject);
    abandoned.once('connect', () => abandoned.write(`${JSON.stringify({
      schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
      command: 'drain',
      operationId: OPERATION_ONE,
      expectedGeneration: closed.generation
    })}\n`, resolve));
  });
  abandoned.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  admission.release();
  await waitFor(() => latch.snapshot().drained === true);
  assert.equal(latch.snapshot().state, 'closed');

  const staleOpen = await sendControl(fixture.socketPath, {
    schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
    command: 'open',
    operationId: OPERATION_ONE,
    expectedGeneration: '0'.repeat(32)
  });
  assert.equal(staleOpen.ok, false);
  assert.equal(staleOpen.error.code, 'admission_generation_mismatch');
  assert.equal(staleOpen.state, 'closed');

  const opened = await sendControl(fixture.socketPath, {
    schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
    command: 'open',
    operationId: OPERATION_ONE,
    expectedGeneration: closed.generation
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.state, 'open');
  assert.equal(opened.releaseId, RELEASE_ID);
  await control.shutdown();
  assert.equal(existsSync(fixture.socketPath), false);
});

test('shutdown destroys a pending drain connection without orphaning its completion', async (t) => {
  const fixture = privateFixture(t);
  const latch = new RolloutAdmissionLatch({ closedMarkerPath: fixture.markerPath });
  const admission = latch.acquire('direct-chat-generation');
  const closed = latch.close(OPERATION_ONE);
  const originalDrain = latch.drain.bind(latch);
  let enterDrain;
  const drainEntered = new Promise((resolve) => { enterDrain = resolve; });
  latch.drain = (request) => {
    enterDrain();
    return originalDrain(request);
  };
  const control = createRolloutAdmissionControlServer({
    latch,
    releaseId: RELEASE_ID,
    socketPath: fixture.socketPath
  });
  t.after(async () => control.shutdown());
  await control.start();
  const unhandled = [];
  const onUnhandledRejection = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => process.off('unhandledRejection', onUnhandledRejection));

  const socket = createConnection(fixture.socketPath);
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({
      schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
      command: 'drain',
      operationId: OPERATION_ONE,
      expectedGeneration: closed.generation
    })}\n`, resolve));
  });
  await drainEntered;
  await control.shutdown();
  await socketClosed;
  assert.equal(socket.destroyed, true);
  assert.equal(control.identity, null);
  assert.equal(existsSync(fixture.socketPath), false);

  admission.release();
  await waitFor(() => latch.snapshot().drained === true);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.deepEqual(latch.snapshot(), {
    state: 'closed',
    active: 0,
    drained: true,
    operationId: OPERATION_ONE,
    generation: closed.generation
  });
  assert.deepEqual(unhandled, []);
});

test('serializes shutdown requested while startup is checking the socket', async (t) => {
  const fixture = privateFixture(t);
  const control = createRolloutAdmissionControlServer({
    latch: new RolloutAdmissionLatch({ closedMarkerPath: fixture.markerPath }),
    releaseId: RELEASE_ID,
    socketPath: fixture.socketPath
  });

  const starting = control.start();
  const stopping = control.shutdown();
  const [startResult, stopResult] = await Promise.allSettled([starting, stopping]);

  assert.equal(startResult.status, 'rejected');
  assert.match(startResult.reason.message, /stopped during startup/iu);
  assert.equal(stopResult.status, 'fulfilled');
  assert.equal(control.lifecycleState, 'stopped');
  assert.equal(control.server.listening, false);
  assert.equal(control.identity, null);
  assert.equal(existsSync(fixture.socketPath), false);
  await assert.rejects(control.start(), /already stopped/iu);
});

test('shutdown during the Unix listen event waits for startup and removes the exact socket', async (t) => {
  const fixture = privateFixture(t);
  const control = createRolloutAdmissionControlServer({
    latch: new RolloutAdmissionLatch({ closedMarkerPath: fixture.markerPath }),
    releaseId: RELEASE_ID,
    socketPath: fixture.socketPath
  });
  let stopping;
  control.server.once('listening', () => { stopping = control.shutdown(); });

  const startResult = await Promise.allSettled([control.start()]);
  assert.equal(startResult[0].status, 'rejected');
  assert.match(startResult[0].reason.message, /stopped during startup/iu);
  assert.ok(stopping);
  await stopping;

  assert.equal(control.lifecycleState, 'stopped');
  assert.equal(control.server.listening, false);
  assert.equal(control.identity, null);
  assert.equal(existsSync(fixture.socketPath), false);
});
