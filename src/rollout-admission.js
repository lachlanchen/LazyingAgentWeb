import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer as createNetServer, createConnection } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const ROLLOUT_ADMISSION_CONTROL_SCHEMA = 'lazying-agent-web/admission-control/v1';
export const ROLLOUT_ADMISSION_MARKER_SCHEMA = 'lazying-agent-web/admission-marker/v1';
export const DEFAULT_ROLLOUT_ADMISSION_SOCKET = '/run/lazying-agent-web/admission.sock';
export const ROLLOUT_IN_PROGRESS_CODE = 'rollout_in_progress';

const GENERATION_PATTERN = /^[a-f0-9]{32}$/u;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,95}$/u;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u;
const ADMISSION_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAXIMUM_CONTROL_REQUEST_BYTES = 1_024;
const CONTROL_REQUEST_TIMEOUT_MS = 2_000;
const CLOSED_MARKER_MODE = 0o600;
const CONTROL_DIRECTORY_MODE = 0o700;
const CONTROL_SOCKET_MODE = 0o600;

function effectiveUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
}

function exactPrivatePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
      || value === '/' || value.includes('\u0000')) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  return value;
}

export function validateRolloutAdmissionSocketPath(value) {
  const pathname = exactPrivatePath(value, 'rollout admission socket path');
  if (basename(pathname) !== 'admission.sock') {
    throw new TypeError('rollout admission socket basename must be admission.sock');
  }
  return pathname;
}

export function rolloutAdmissionSocketPathForRuntimeDirectory(value) {
  const directory = exactPrivatePath(value, 'RUNTIME_DIRECTORY');
  if (value.includes(':')) {
    throw new TypeError('RUNTIME_DIRECTORY must contain exactly one directory');
  }
  return validateRolloutAdmissionSocketPath(join(directory, 'admission.sock'));
}

function validateOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_PATTERN.test(value)) {
    throw new RolloutAdmissionError(
      'invalid_request',
      'operationId must be a portable 16-128 character rollout identifier.'
    );
  }
  return value;
}

function validateGeneration(value) {
  if (typeof value !== 'string' || !GENERATION_PATTERN.test(value)) {
    throw new RolloutAdmissionError(
      'invalid_request',
      'expectedGeneration must be an admission generation returned by close.'
    );
  }
  return value;
}

function validateAdmissionKind(value) {
  if (typeof value !== 'string' || !ADMISSION_KIND_PATTERN.test(value)) {
    throw new TypeError('admission kind is invalid');
  }
  return value;
}

function assertOwnerPrivateDirectory(pathname) {
  const stat = lstatSync(pathname);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== effectiveUid()
      || stat.nlink < 2 || (stat.mode & 0o777) !== CONTROL_DIRECTORY_MODE
      || realpathSync(pathname) !== pathname) {
    throw new Error('admission state directory is not owner-private');
  }
  return stat;
}

function assertOwnerPrivateFile(pathname) {
  const stat = lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== effectiveUid()
      || stat.nlink !== 1 || (stat.mode & 0o777) !== CLOSED_MARKER_MODE) {
    throw new Error('admission closed marker is not owner-private');
  }
  return stat;
}

function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function markerBytes(operationId, generation) {
  return Buffer.from(`${JSON.stringify({
    schema: ROLLOUT_ADMISSION_MARKER_SCHEMA,
    state: 'closed',
    operationId,
    generation
  })}\n`, 'utf8');
}

function readClosedMarker(pathname) {
  const stat = assertOwnerPrivateFile(pathname);
  if (stat.size < 1 || stat.size > 512) throw new Error('admission closed marker is invalid');
  let value;
  try { value = JSON.parse(readFileSync(pathname, 'utf8')); }
  catch (error) { throw new Error('admission closed marker is invalid', { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join('\u0000') !== ['generation', 'operationId', 'schema', 'state'].join('\u0000')
      || value.schema !== ROLLOUT_ADMISSION_MARKER_SCHEMA || value.state !== 'closed'
      || !GENERATION_PATTERN.test(value.generation) || !OPERATION_PATTERN.test(value.operationId)) {
    throw new Error('admission closed marker is invalid');
  }
  return Object.freeze({ operationId: value.operationId, generation: value.generation });
}

function readOptionalClosedMarker(pathname) {
  try { return readClosedMarker(pathname); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function createClosedMarker(pathname, operationId, generation) {
  const directory = dirname(pathname);
  assertOwnerPrivateDirectory(directory);
  const temporaryPath = `${pathname}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  let descriptor;
  let renamed = false;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      CLOSED_MARKER_MODE
    );
    fchmodSync(descriptor, CLOSED_MARKER_MODE);
    writeFileSync(descriptor, markerBytes(operationId, generation));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertOwnerPrivateFile(temporaryPath);
    renameSync(temporaryPath, pathname);
    renamed = true;
    assertOwnerPrivateFile(pathname);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); }
      catch { /* Preserve the authoritative marker creation failure. */ }
    }
    if (!renamed) {
      try { unlinkSync(temporaryPath); }
      catch { /* The temporary marker may not have reached the filesystem. */ }
    }
    throw error;
  }
}

function removeClosedMarker(pathname, expected) {
  const before = assertOwnerPrivateFile(pathname);
  const marker = readClosedMarker(pathname);
  if (marker.generation !== expected.generation || marker.operationId !== expected.operationId) {
    throw new RolloutAdmissionError(
      'admission_generation_mismatch',
      'The admission close generation no longer matches this rollout.'
    );
  }
  const after = lstatSync(pathname);
  if (after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error('admission closed marker changed during validation');
  }
  unlinkSync(pathname);
  fsyncDirectory(dirname(pathname));
}

export class RolloutAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RolloutAdmissionError';
    this.code = code;
  }
}

export class RolloutAdmissionLatch {
  #active = 0;
  #closedMarkerPath;
  #drained = false;
  #generation = null;
  #operationId = null;
  #state = 'open';
  #waiters = new Set();

  constructor({ closedMarkerPath } = {}) {
    if (closedMarkerPath !== undefined) {
      this.#closedMarkerPath = exactPrivatePath(closedMarkerPath, 'closedMarkerPath');
      assertOwnerPrivateDirectory(dirname(this.#closedMarkerPath));
      const marker = readOptionalClosedMarker(this.#closedMarkerPath);
      if (marker) {
        this.#state = 'closed';
        this.#generation = marker.generation;
        this.#operationId = marker.operationId;
      }
    }
  }

  acquire(kind) {
    const checkedKind = validateAdmissionKind(kind);
    if (this.#state !== 'open') return null;
    return this.#createLease(checkedKind);
  }

  #createLease(kind) {
    this.#active += 1;
    let released = false;
    const latch = this;
    return Object.freeze({
      kind,
      fork(childKind) {
        validateAdmissionKind(childKind);
        if (released) throw new Error('released admission cannot create a child admission');
        return latch.#createLease(childKind);
      },
      release() {
        if (released) return;
        released = true;
        latch.#active -= 1;
        if (latch.#active < 0) throw new Error('admission latch active count underflow');
        if (latch.#active === 0) latch.#resolveDrainWaiters();
      }
    });
  }

  close(operationId) {
    const checkedOperationId = validateOperationId(operationId);
    if (this.#state === 'closed') {
      if (this.#operationId !== checkedOperationId) {
        throw new RolloutAdmissionError(
          'admission_operation_mismatch',
          'Admission is already owned by a different rollout operation.'
        );
      }
      this.#assertMarkerMatchesMemory();
      return this.snapshot();
    }
    const generation = randomBytes(16).toString('hex');
    // Synchronous marker I/O cannot interleave with acquire(). Close memory first
    // so an I/O failure remains fail-closed in this process; acknowledge the
    // command only after the durable marker has reached its parent directory.
    this.#operationId = checkedOperationId;
    this.#generation = generation;
    this.#drained = false;
    this.#state = 'closed';
    if (this.#closedMarkerPath !== undefined) {
      createClosedMarker(this.#closedMarkerPath, checkedOperationId, generation);
    }
    return this.snapshot();
  }

  async drain({ operationId, expectedGeneration }) {
    this.#requireClosedAuthority(operationId, expectedGeneration);
    if (this.#active !== 0) {
      await new Promise((resolve) => this.#waiters.add(resolve));
      this.#requireClosedAuthority(operationId, expectedGeneration);
    }
    this.#drained = true;
    return this.snapshot();
  }

  reopen({ operationId, expectedGeneration }) {
    this.#requireClosedAuthority(operationId, expectedGeneration);
    if (this.#active !== 0) {
      throw new RolloutAdmissionError(
        'admission_busy',
        'Active admissions must drain before reopening.'
      );
    }
    if (!this.#drained) {
      throw new RolloutAdmissionError(
        'admission_not_drained',
        'Admission must complete an exact generation drain before reopening.'
      );
    }
    if (this.#closedMarkerPath !== undefined) {
      removeClosedMarker(this.#closedMarkerPath, {
        operationId: this.#operationId,
        generation: this.#generation
      });
    }
    // Durable marker removal precedes reopening. A crash before this assignment
    // restarts open only after the operator's exact CAS-authorized removal.
    this.#state = 'open';
    this.#operationId = null;
    this.#generation = null;
    this.#drained = false;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      active: this.#active,
      drained: this.#drained,
      operationId: this.#operationId,
      generation: this.#generation
    });
  }

  #requireClosedAuthority(operationId, expectedGeneration) {
    const checkedOperationId = validateOperationId(operationId);
    const checkedGeneration = validateGeneration(expectedGeneration);
    if (this.#state !== 'closed') {
      throw new RolloutAdmissionError('admission_not_closed', 'Admission is not closed.');
    }
    if (this.#operationId !== checkedOperationId) {
      throw new RolloutAdmissionError(
        'admission_operation_mismatch',
        'Admission is owned by a different rollout operation.'
      );
    }
    if (this.#generation !== checkedGeneration) {
      throw new RolloutAdmissionError(
        'admission_generation_mismatch',
        'The admission close generation no longer matches this rollout.'
      );
    }
    this.#assertMarkerMatchesMemory();
  }

  #assertMarkerMatchesMemory() {
    if (this.#closedMarkerPath === undefined) return;
    const marker = readClosedMarker(this.#closedMarkerPath);
    if (marker.generation !== this.#generation || marker.operationId !== this.#operationId) {
      throw new Error('admission closed marker does not match memory');
    }
  }

  #resolveDrainWaiters() {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter();
  }
}

function exactControlRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RolloutAdmissionError('invalid_request', 'The control request must be a JSON object.');
  }
  const command = value.command;
  if (!['close', 'drain', 'status', 'open'].includes(command)
      || value.schema !== ROLLOUT_ADMISSION_CONTROL_SCHEMA) {
    throw new RolloutAdmissionError('invalid_request', 'The admission control command is invalid.');
  }
  const expectedKeys = command === 'status'
    ? ['command', 'schema']
    : (command === 'close'
      ? ['command', 'operationId', 'schema']
      : ['command', 'expectedGeneration', 'operationId', 'schema']);
  if (Object.keys(value).sort().join('\u0000') !== expectedKeys.sort().join('\u0000')) {
    throw new RolloutAdmissionError('invalid_request', 'The admission control request shape is invalid.');
  }
  if (command !== 'status') validateOperationId(value.operationId);
  if (command === 'drain' || command === 'open') validateGeneration(value.expectedGeneration);
  return Object.freeze({
    command,
    ...(command === 'status' ? {} : { operationId: value.operationId }),
    ...(['drain', 'open'].includes(command) ? { expectedGeneration: value.expectedGeneration } : {})
  });
}

function socketIdentity(pathname) {
  const stat = lstatSync(pathname);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== effectiveUid()
      || stat.nlink !== 1 || (stat.mode & 0o777) !== CONTROL_SOCKET_MODE) {
    throw new Error('admission control socket is not owner-private');
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: '0600'
  });
}

function socketIsLive(pathname) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(pathname);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(rejectPromise, new Error('existing admission socket probe timed out')), 250);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(resolvePromise, true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') finish(resolvePromise, false);
      else finish(rejectPromise, error);
    });
  });
}

async function removeOwnedStaleSocket(pathname) {
  let first;
  try { first = socketIdentity(pathname); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (await socketIsLive(pathname)) throw new Error('admission control socket is already active');
  const second = socketIdentity(pathname);
  if (second.dev !== first.dev || second.ino !== first.ino) {
    throw new Error('admission control socket changed during stale-socket validation');
  }
  unlinkSync(pathname);
  fsyncDirectory(dirname(pathname));
}

function responseEnvelope(command, snapshot, identity, { error } = {}) {
  return Object.freeze({
    schema: ROLLOUT_ADMISSION_CONTROL_SCHEMA,
    ok: error === undefined,
    command,
    releaseId: identity.releaseId,
    state: snapshot.state,
    active: snapshot.active,
    drained: snapshot.drained,
    operationId: snapshot.operationId,
    generation: snapshot.generation,
    socket: Object.freeze({ uid: identity.uid, gid: identity.gid, mode: identity.mode }),
    ...(error === undefined ? {} : {
      error: Object.freeze({ code: error.code, message: error.message })
    })
  });
}

export function createRolloutAdmissionControlServer({
  latch,
  releaseId,
  socketPath = DEFAULT_ROLLOUT_ADMISSION_SOCKET
} = {}) {
  if (!(latch instanceof RolloutAdmissionLatch)) {
    throw new TypeError('latch must be a RolloutAdmissionLatch');
  }
  if (typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new TypeError('releaseId must be an exact portable release identifier');
  }
  const pathname = validateRolloutAdmissionSocketPath(socketPath);
  const directory = dirname(pathname);
  const connections = new Set();
  let identity = null;
  let lifecycleState = 'idle';
  let startPromise = null;
  let stopRequested = false;
  let shutdownPromise = null;

  const server = createNetServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket) => {
    const connectionIdentity = identity;
    if (connectionIdentity === null) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    let source = '';
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), CONTROL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const finish = (value) => {
      if (handled || socket.destroyed) return;
      handled = true;
      clearTimeout(timer);
      socket.end(`${JSON.stringify(value)}\n`);
    };
    const fail = (command, error) => {
      const safe = error instanceof RolloutAdmissionError
        ? error
        : new RolloutAdmissionError('control_internal_error', 'The admission control command failed safely.');
      finish(responseEnvelope(command, latch.snapshot(), connectionIdentity, { error: safe }));
    };
    socket.on('data', (chunk) => {
      if (handled) return;
      source += chunk;
      if (Buffer.byteLength(source, 'utf8') > MAXIMUM_CONTROL_REQUEST_BYTES) {
        fail('invalid', new RolloutAdmissionError('invalid_request', 'The control request is too large.'));
        return;
      }
      const newline = source.indexOf('\n');
      if (newline < 0) return;
      if (source.slice(newline + 1).length !== 0) {
        fail('invalid', new RolloutAdmissionError('invalid_request', 'Only one control command is accepted.'));
        return;
      }
      let request;
      try { request = exactControlRequest(JSON.parse(source.slice(0, newline))); }
      catch (error) {
        fail('invalid', error instanceof SyntaxError
          ? new RolloutAdmissionError('invalid_request', 'The control request must be valid JSON.')
          : error);
        return;
      }
      void (async () => {
        try {
          let snapshot;
          if (request.command === 'status') snapshot = latch.snapshot();
          else if (request.command === 'close') snapshot = latch.close(request.operationId);
          else if (request.command === 'drain') snapshot = await latch.drain(request);
          else snapshot = latch.reopen(request);
          finish(responseEnvelope(request.command, snapshot, connectionIdentity));
        } catch (error) {
          fail(request.command, error);
        }
      })();
    });
    socket.once('close', () => {
      clearTimeout(timer);
      connections.delete(socket);
    });
    socket.once('error', () => {
      // The owner may disconnect while a drain remains pending. Closing admission
      // is durable and must never be rolled back because a client disappeared.
    });
  });
  server.maxConnections = 8;

  const start = () => {
    if (stopRequested) {
      return Promise.reject(new Error('admission control server is already stopped'));
    }
    if (startPromise) return startPromise;
    lifecycleState = 'starting';
    startPromise = (async () => {
      try {
        mkdirSync(directory, { recursive: true, mode: CONTROL_DIRECTORY_MODE });
        const beforeChmod = lstatSync(directory);
        if (!beforeChmod.isDirectory() || beforeChmod.isSymbolicLink()
            || beforeChmod.uid !== effectiveUid()) {
          throw new Error('admission control directory ownership is invalid');
        }
        chmodSync(directory, CONTROL_DIRECTORY_MODE);
        assertOwnerPrivateDirectory(directory);
        await removeOwnedStaleSocket(pathname);
        if (stopRequested) {
          throw new Error('admission control server was stopped during startup');
        }
        await new Promise((resolvePromise, rejectPromise) => {
          const onError = (error) => {
            server.removeListener('error', onError);
            rejectPromise(error);
          };
          server.once('error', onError);
          const previousUmask = process.umask(0o177);
          try {
            server.listen(pathname, () => {
              server.removeListener('error', onError);
              resolvePromise();
            });
          } finally {
            process.umask(previousUmask);
          }
        });
        chmodSync(pathname, CONTROL_SOCKET_MODE);
        identity = socketIdentity(pathname);
        identity = Object.freeze({ ...identity, releaseId });
        fsyncDirectory(directory);
        if (stopRequested) {
          throw new Error('admission control server was stopped during startup');
        }
        lifecycleState = 'listening';
        return Object.freeze({
          path: pathname,
          releaseId,
          uid: identity.uid,
          gid: identity.gid,
          mode: identity.mode
        });
      } catch (error) {
        if (!stopRequested) lifecycleState = 'failed';
        throw error;
      }
    })();
    return startPromise;
  };

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopRequested = true;
    lifecycleState = 'stopping';
    const pendingStart = startPromise;
    shutdownPromise = (async () => {
      if (pendingStart !== null) {
        try { await pendingStart; }
        catch {
          // Startup failure or cancellation does not waive exact socket cleanup.
        }
      }
      for (const socket of connections) socket.destroy();
      if (server.listening) {
        await new Promise((resolvePromise, rejectPromise) => server.close((error) => (
          error ? rejectPromise(error) : resolvePromise()
        )));
      }
      if (identity !== null) {
        try {
          const current = socketIdentity(pathname);
          if (current.dev !== identity.dev || current.ino !== identity.ino) {
            throw new Error('admission control socket identity changed before cleanup');
          }
          unlinkSync(pathname);
          fsyncDirectory(directory);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      identity = null;
      lifecycleState = 'stopped';
    })();
    return shutdownPromise;
  };

  return Object.freeze({
    path: pathname,
    latch,
    server,
    start,
    shutdown,
    get identity() { return identity; },
    get lifecycleState() { return lifecycleState; }
  });
}
