import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import {
  ConflictError,
  CloudIndexStore,
  IDEMPOTENCY_RECEIPT_TTL_MS,
  IdempotencyConflictError,
  LATEST_SCHEMA_VERSION,
  MAX_AGENT_AUTHORITY_SCOPES_PER_ACCOUNT,
  MAX_BROWSER_SESSIONS_PER_ACCOUNT,
  MAX_IDEMPOTENCY_RECEIPTS_PER_ACCOUNT,
  MIGRATIONS,
  NotFoundError,
  SQLITE_APPLICATION_ID,
  ValidationError
} from '../src/index.js';
import { canonicalJson, digestSecret } from '../src/validation.js';
import { createTestStore, provisionAccount } from './helpers.js';

const SESSION_TOKEN = 'session-token-with-more-than-thirty-two-random-characters-0001';
const CSRF_TOKEN = 'csrf-token-with-more-than-thirty-two-random-characters-000001';

function queryScalar(databasePath, sql, ...parameters) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(sql).get(...parameters)?.value;
  } finally {
    database.close();
  }
}

function sessionInput(accountSuffix, label, overrides = {}) {
  return {
    accountId: `account-${accountSuffix}`,
    sessionToken: `session-${accountSuffix}-${label}-${'s'.repeat(40)}`,
    csrfToken: `csrf-${accountSuffix}-${label}-${'c'.repeat(40)}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey: `browser-session-create-${accountSuffix}-${label}`,
    ...overrides
  };
}

function runConcurrentSessionCreate({ databasePath, input, clock, barrier }) {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      let store;
      try {
        const { CloudIndexStore } = await import(workerData.moduleUrl);
        store = new CloudIndexStore({
          databasePath: workerData.databasePath,
          clock: () => new Date(workerData.clock)
        });
        Atomics.add(workerData.barrier, 0, 1);
        Atomics.notify(workerData.barrier, 0);
        Atomics.wait(workerData.barrier, 1, 0);
        const result = store.createBrowserSession(workerData.input);
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({
          ok: false,
          error: { name: error?.name, message: error?.message, code: error?.code }
        });
      } finally {
        store?.close();
      }
    })();
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      moduleUrl,
      databasePath,
      input,
      clock,
      barrier: new Int32Array(barrier)
    }
  });
  return new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      if (message.ok) {
        resolve(message.result);
        return;
      }
      reject(Object.assign(new Error(message.error.message), message.error));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Session admission worker exited with status ${code}.`));
    });
  });
}

test('provisions accounts idempotently and binds external identity uniquely', (t) => {
  const { store } = createTestStore(t);
  const first = provisionAccount(store, 'alpha');
  const replay = provisionAccount(store, 'alpha');

  assert.deepEqual(replay, first);
  assert.throws(
    () => store.provisionAccount({
      accountId: 'account-alpha',
      issuer: 'https://identity.example.test',
      subject: 'changed-subject',
      displayName: 'Changed',
      idempotencyKey: 'account-provision-alpha-0001'
    }),
    IdempotencyConflictError
  );
  assert.deepEqual(
    store.resolveAccountIdentity({
      issuer: 'https://identity.example.test',
      subject: 'subject-alpha'
    }),
    first
  );
});

test('failed transactions do not reserve idempotency keys', (t) => {
  const { store } = createTestStore(t);
  const request = {
    accountId: 'account-later',
    threadId: 'thread-later',
    idempotencyKey: 'thread-register-after-account-0001'
  };
  assert.throws(() => store.registerThread(request), NotFoundError);

  provisionAccount(store, 'later');
  assert.equal(store.registerThread(request).threadId, 'thread-later');
});

test('stores only session and CSRF digests and enforces CSRF on mutations', (t) => {
  const { databasePath, store } = createTestStore(t);
  provisionAccount(store, 'session');
  const created = store.createBrowserSession({
    accountId: 'account-session',
    sessionToken: SESSION_TOKEN,
    csrfToken: CSRF_TOKEN,
    expiresAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey: 'browser-session-create-0001'
  });

  assert.equal(created.accountId, 'account-session');
  assert.equal(store.authenticateBrowserSession({ sessionToken: SESSION_TOKEN }).accountId, 'account-session');
  assert.equal(
    store.authenticateBrowserMutation({ sessionToken: SESSION_TOKEN, csrfToken: CSRF_TOKEN }).accountId,
    'account-session'
  );
  assert.equal(
    store.authenticateBrowserMutation({
      sessionToken: SESSION_TOKEN,
      csrfToken: `${CSRF_TOKEN}-wrong`
    }),
    null
  );

  store.close();
  const bytes = readFileSync(databasePath).toString('latin1');
  assert.doesNotMatch(bytes, new RegExp(SESSION_TOKEN, 'u'));
  assert.doesNotMatch(bytes, new RegExp(CSRF_TOKEN, 'u'));
});

test('separates durable Agent authority from login sessions and isolates resource bindings by account', (t) => {
  const { store } = createTestStore(t);
  provisionAccount(store, 'authority-one');
  provisionAccount(store, 'authority-two');

  const first = store.getDefaultAgentAuthorityScope('account-authority-one');
  const second = store.getDefaultAgentAuthorityScope('account-authority-two');
  assert.equal(first.kind, 'default');
  assert.equal(second.kind, 'default');
  assert.match(first.scopeDigest, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.scopeDigest, second.scopeDigest);
  assert.equal(
    store.listAgentAuthorityScopes({ accountId: 'account-authority-one' }).length,
    1
  );

  const binding = store.bindAgentResource({
    accountId: 'account-authority-one',
    resourceKind: 'thread',
    resourceId: 'thr_authority_owner',
    scopeDigest: first.scopeDigest
  });
  assert.deepEqual(store.bindAgentResource({
    accountId: 'account-authority-one',
    resourceKind: 'thread',
    resourceId: 'thr_authority_owner',
    scopeDigest: first.scopeDigest
  }), binding, 'binding replay is naturally idempotent');
  assert.equal(store.getAgentResourceBinding({
    accountId: 'account-authority-two',
    resourceKind: 'thread',
    resourceId: 'thr_authority_owner'
  }), null);
  assert.throws(() => store.bindAgentResource({
    accountId: 'account-authority-two',
    resourceKind: 'thread',
    resourceId: 'thr_authority_owner',
    scopeDigest: second.scopeDigest
  }), ConflictError);
  assert.throws(() => store.bindAgentResource({
    accountId: 'account-authority-two',
    resourceKind: 'run',
    resourceId: 'run_foreign_scope',
    scopeDigest: first.scopeDigest
  }), NotFoundError);
});

test('migrates v1 sessions into bounded legacy scopes and primes exactly one stable default transactionally', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lazying-agent-authority-migration-'));
  const databaseDirectory = join(root, 'private');
  const databasePath = join(databaseDirectory, 'index.sqlite');
  const backupPath = join(root, 'index-v1.sqlite');
  mkdirSync(databaseDirectory, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const database = new DatabaseSync(databasePath);
  const v1 = MIGRATIONS[0];
  database.exec(v1.sql);
  database.prepare(`
    INSERT INTO schema_migrations(version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `).run(v1.version, v1.name, v1.checksum, '2026-08-20T00:00:00.000Z');
  database.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}`);
  database.exec('PRAGMA user_version = 1');
  database.prepare(`
    INSERT INTO accounts(id, issuer, subject, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'account-migrated',
    'local-login',
    'migrated-user',
    'Migrated',
    '2026-08-20T00:00:00.000Z',
    '2026-08-20T00:00:00.000Z'
  );
  const legacyTokens = [
    `legacy-session-one-${'a'.repeat(40)}`,
    `legacy-session-two-${'b'.repeat(40)}`
  ];
  const legacyDigests = legacyTokens.map((token) => digestSecret(token, 'sessionToken'));
  for (let index = 0; index < legacyDigests.length; index += 1) {
    database.prepare(`
      INSERT INTO browser_sessions(
        session_digest, account_id, csrf_digest, created_at, expires_at, last_seen_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      legacyDigests[index],
      'account-migrated',
      String(index + 1).repeat(64),
      `2026-08-2${index}T00:00:00.000Z`,
      '2099-01-01T00:00:00.000Z',
      `2026-08-2${index}T00:00:00.000Z`
    );
  }
  database.close();
  chmodSync(databasePath, 0o600);
  copyFileSync(databasePath, backupPath);
  chmodSync(backupPath, 0o600);

  const store = new CloudIndexStore({ databasePath });
  t.after(() => store.close());
  const pending = store.listAgentAuthorityScopes({ accountId: 'account-migrated' });
  assert.equal(pending.length, legacyDigests.length + 1);
  assert.ok(pending.length <= MAX_AGENT_AUTHORITY_SCOPES_PER_ACCOUNT);
  assert.equal(pending[0].kind, 'default_pending');
  assert.deepEqual(
    new Set(pending.slice(1).map(({ scopeDigest }) => scopeDigest)),
    new Set(legacyDigests)
  );

  const primed = store.primeDefaultAgentAuthorityScope({
    accountId: 'account-migrated',
    legacyScopeDigest: legacyDigests[1]
  });
  assert.equal(primed.kind, 'default');
  assert.equal(primed.scopeDigest, legacyDigests[1]);
  assert.equal(store.primeDefaultAgentAuthorityScope({
    accountId: 'account-migrated',
    legacyScopeDigest: legacyDigests[0]
  }).scopeDigest, legacyDigests[1], 'the first authenticated prime wins permanently');
  assert.equal(store.getDefaultAgentAuthorityScope('account-migrated').scopeDigest, legacyDigests[1]);
  assert.deepEqual(store.retireEmptyLegacyAgentAuthorityScope({
    accountId: 'account-migrated',
    scopeDigest: legacyDigests[0]
  }), { retired: true });
  assert.deepEqual(store.retireEmptyLegacyAgentAuthorityScope({
    accountId: 'account-migrated',
    scopeDigest: legacyDigests[0]
  }), { retired: false });

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA_VERSION);
  assert.equal(migrated.prepare('SELECT count(*) AS count FROM accounts').get().count, 1);
  assert.equal(migrated.prepare('SELECT count(*) AS count FROM browser_sessions').get().count, 2);
  assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  migrated.close();

  // Rollback uses the pre-migration snapshot. Version 2 is additive, and the
  // exact v1 backup remains a valid untouched rollback target.
  const rollback = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(rollback.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(rollback.prepare('SELECT count(*) AS count FROM accounts').get().count, 1);
  assert.equal(rollback.prepare('SELECT count(*) AS count FROM browser_sessions').get().count, 2);
  assert.equal(rollback.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  rollback.close();
});

test('thread queries and mutations are owner-bound', (t) => {
  const { store } = createTestStore(t);
  provisionAccount(store, 'owner');
  provisionAccount(store, 'other');

  const thread = store.registerThread({
    accountId: 'account-owner',
    threadId: 'aginti-thread-1',
    title: 'First thread',
    authorityRevision: 0,
    routingNodeId: 'workstation-one',
    idempotencyKey: 'thread-register-owner-0001'
  });
  assert.equal(thread.authority, 'aginti');
  assert.equal(thread.authorityRevision, 0);
  assert.equal(store.getThread('account-other', 'aginti-thread-1'), null);
  assert.deepEqual(store.listThreads({ accountId: 'account-other' }), []);
  assert.throws(
    () => store.updateThreadPresentation({
      accountId: 'account-other',
      threadId: 'aginti-thread-1',
      patch: { pinned: true },
      idempotencyKey: 'thread-update-other-0001'
    }),
    NotFoundError
  );
  assert.throws(
    () => store.registerThread({
      accountId: 'account-other',
      threadId: 'aginti-thread-1',
      idempotencyKey: 'thread-register-collision-0001'
    }),
    ConflictError
  );
});

test('thread mirror fields are the exact narrow AgInTi presentation contract', (t) => {
  const { store } = createTestStore(t);
  provisionAccount(store, 'narrow');

  assert.throws(
    () => store.registerThread({
      accountId: 'account-narrow',
      threadId: 'thread-too-wide-title',
      title: 'x'.repeat(121),
      idempotencyKey: 'thread-title-too-long-0001'
    }),
    ValidationError
  );
  assert.throws(
    () => store.registerThread({
      accountId: 'account-narrow',
      threadId: 'thread-string-revision',
      authorityRevision: '1',
      idempotencyKey: 'thread-string-revision-0001'
    }),
    ValidationError
  );
  assert.throws(
    () => store.registerThread({
      accountId: 'account-narrow',
      threadId: 'thread-semantic-payload',
      messages: [{ role: 'user', content: 'must never persist' }],
      idempotencyKey: 'thread-semantic-payload-0001'
    }),
    ValidationError
  );

  store.registerThread({
    accountId: 'account-narrow',
    threadId: 'thread-authority-sync',
    idempotencyKey: 'thread-authority-sync-register-0001'
  });
  assert.throws(
    () => store.updateThreadPresentation({
      accountId: 'account-narrow',
      threadId: 'thread-authority-sync',
      patch: { routingNodeId: 'browser-must-not-route' },
      idempotencyKey: 'thread-browser-route-update-0001'
    }),
    ValidationError
  );
  const synced = store.syncThreadAuthorityMetadataFromAginti({
    accountId: 'account-narrow',
    threadId: 'thread-authority-sync',
    routingNodeId: 'trusted-node-one',
    authorityRevision: 7,
    idempotencyKey: 'thread-authority-metadata-sync-0001'
  });
  assert.equal(synced.routingNodeId, 'trusted-node-one');
  assert.equal(synced.authorityRevision, 7);
  assert.throws(
    () => store.syncThreadAuthorityMetadataFromAginti({
      accountId: 'account-narrow',
      threadId: 'thread-authority-sync',
      routingNodeId: 'trusted-node-one',
      authorityRevision: 8,
      title: 'not authority metadata',
      idempotencyKey: 'thread-authority-metadata-extra-0001'
    }),
    ValidationError
  );
});

test('idempotent replay fails closed when the original result has drifted', (t) => {
  const { store } = createTestStore(t);
  provisionAccount(store, 'replay');
  store.registerThread({
    accountId: 'account-replay',
    threadId: 'thread-replay',
    idempotencyKey: 'thread-replay-register-0001'
  });
  const firstUpdate = {
    accountId: 'account-replay',
    threadId: 'thread-replay',
    patch: { title: 'First title' },
    idempotencyKey: 'thread-replay-first-update-0001'
  };
  store.updateThreadPresentation(firstUpdate);
  store.updateThreadPresentation({
    accountId: 'account-replay',
    threadId: 'thread-replay',
    patch: { title: 'Second title' },
    idempotencyKey: 'thread-replay-second-update-0001'
  });
  assert.throws(() => store.updateThreadPresentation(firstUpdate), ConflictError);

  const createSession = {
    accountId: 'account-replay',
    sessionToken: `${SESSION_TOKEN}-replay`,
    csrfToken: `${CSRF_TOKEN}-replay`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey: 'browser-session-replay-create-0001'
  };
  store.createBrowserSession(createSession);
  store.revokeBrowserSession({
    accountId: 'account-replay',
    sessionToken: createSession.sessionToken,
    idempotencyKey: 'browser-session-replay-revoke-0001'
  });
  assert.throws(() => store.createBrowserSession(createSession), ConflictError);
});

test('run delivery cursors are monotonic, hash-bound, and owner-bound', (t) => {
  const { store } = createTestStore(t);
  provisionAccount(store, 'cursor-owner');
  provisionAccount(store, 'cursor-other');
  store.registerThread({
    accountId: 'account-cursor-owner',
    threadId: 'aginti-thread-cursor',
    idempotencyKey: 'thread-register-cursor-0001'
  });

  const initial = store.recordRunCursor({
    accountId: 'account-cursor-owner',
    threadId: 'aginti-thread-cursor',
    runId: 'aginti-run-1',
    lastSeq: 0,
    lastEventHash: null
  });
  assert.equal(initial.lastSeq, 0);

  const advanced = store.recordRunCursor({
    accountId: 'account-cursor-owner',
    threadId: 'aginti-thread-cursor',
    runId: 'aginti-run-1',
    lastSeq: 1,
    lastEventHash: 'a'.repeat(64)
  });
  assert.equal(advanced.lastSeq, 1);
  assert.equal(store.getRunCursor('account-cursor-other', 'aginti-run-1'), null);

  assert.throws(
    () => store.recordRunCursor({
      accountId: 'account-cursor-owner',
      threadId: 'aginti-thread-cursor',
      runId: 'aginti-run-1',
      lastSeq: 0,
      lastEventHash: null
    }),
    ConflictError
  );
  assert.throws(
    () => store.recordRunCursor({
      accountId: 'account-cursor-owner',
      threadId: 'aginti-thread-cursor',
      runId: 'aginti-run-1',
      lastSeq: 1,
      lastEventHash: 'b'.repeat(64)
    }),
    ConflictError
  );
  assert.throws(
    () => store.recordRunCursor({
      accountId: 'account-cursor-owner',
      threadId: 'aginti-thread-cursor',
      runId: 'aginti-run-1',
      lastSeq: 2,
      lastEventHash: 'A'.repeat(64)
    }),
    ValidationError
  );
});

test('cursor advancement is naturally idempotent and creates no receipts', (t) => {
  const { databasePath, store } = createTestStore(t);
  provisionAccount(store, 'cursor-receipt');
  store.registerThread({
    accountId: 'account-cursor-receipt',
    threadId: 'thread-cursor-receipt',
    idempotencyKey: 'thread-cursor-receipt-register-0001'
  });
  const before = Number(queryScalar(
    databasePath,
    'SELECT count(*) AS value FROM idempotency_records WHERE account_id = ?',
    'account-cursor-receipt'
  ));
  const request = {
    accountId: 'account-cursor-receipt',
    threadId: 'thread-cursor-receipt',
    runId: 'run-cursor-receipt',
    lastSeq: 4,
    lastEventHash: 'd'.repeat(64)
  };
  const first = store.recordRunCursor(request);
  const replay = store.recordRunCursor(request);
  assert.deepEqual(replay, first);
  const after = Number(queryScalar(
    databasePath,
    'SELECT count(*) AS value FROM idempotency_records WHERE account_id = ?',
    'account-cursor-receipt'
  ));
  assert.equal(after, before);
});

test('removing a cloud thread index cascades only cloud delivery cursors', (t) => {
  const { store } = createTestStore(t);
  provisionAccount(store, 'remove');
  store.registerThread({
    accountId: 'account-remove',
    threadId: 'aginti-thread-remove',
    idempotencyKey: 'thread-register-remove-0001'
  });
  store.recordRunCursor({
    accountId: 'account-remove',
    threadId: 'aginti-thread-remove',
    runId: 'aginti-run-remove',
    lastSeq: 1,
    lastEventHash: 'c'.repeat(64)
  });

  const request = {
    accountId: 'account-remove',
    threadId: 'aginti-thread-remove',
    idempotencyKey: 'thread-remove-cloud-index-0001'
  };
  assert.deepEqual(store.removeThreadIndex(request), {
    threadId: 'aginti-thread-remove',
    removedFromCloudIndex: true
  });
  assert.deepEqual(store.removeThreadIndex(request), {
    threadId: 'aginti-thread-remove',
    removedFromCloudIndex: true
  });
  assert.equal(store.getThread('account-remove', 'aginti-thread-remove'), null);
  assert.equal(store.getRunCursor('account-remove', 'aginti-run-remove'), null);
});

test('idempotency receipts cannot store messages, context, tools, artifacts, or response JSON', (t) => {
  const { databasePath, store } = createTestStore(t);
  provisionAccount(store, 'schema');
  store.close();

  const database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  const columns = database.prepare('PRAGMA table_info(idempotency_records)').all().map((row) => row.name);
  assert.deepEqual(columns, [
    'account_id',
    'operation',
    'key_hash',
    'request_hash',
    'outcome_code',
    'resource_kind',
    'resource_id',
    'result_digest',
    'created_at',
    'expires_at'
  ]);
  assert.equal(columns.includes('response_json'), false);
  assert.throws(
    () => database.prepare(`
      INSERT INTO idempotency_records(response_json) VALUES (?)
    `).run(JSON.stringify({ messages: [], context: {}, tools: [], artifacts: [] })),
    /no column named response_json/u
  );

  const semanticNames = /message|context|summary|plan|tool|artifact|prompt|command|model|docker|response_json/u;
  const allColumns = database.prepare(`
    SELECT m.name AS table_name, p.name AS column_name
    FROM sqlite_schema AS m, pragma_table_info(m.name) AS p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
  `).all();
  for (const column of allColumns) {
    assert.doesNotMatch(`${column.table_name}.${column.column_name}`, semanticNames);
  }
});

test('all persisted digests reject uppercase and non-hex values at the SQLite boundary', (t) => {
  const { databasePath, store } = createTestStore(t);
  provisionAccount(store, 'digest-check');
  store.createBrowserSession({
    accountId: 'account-digest-check',
    sessionToken: `${SESSION_TOKEN}-digest-check`,
    csrfToken: `${CSRF_TOKEN}-digest-check`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey: 'browser-session-digest-check-0001'
  });
  store.registerThread({
    accountId: 'account-digest-check',
    threadId: 'thread-digest-check',
    idempotencyKey: 'thread-digest-check-register-0001'
  });
  store.recordRunCursor({
    accountId: 'account-digest-check',
    threadId: 'thread-digest-check',
    runId: 'run-digest-check',
    lastSeq: 1,
    lastEventHash: 'e'.repeat(64)
  });
  store.close();

  const database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  const uppercase = 'A'.repeat(64);
  const checkConstraint = /constraint failed/iu;
  assert.throws(
    () => database.prepare('UPDATE browser_sessions SET session_digest = ?').run(uppercase),
    checkConstraint
  );
  assert.throws(
    () => database.prepare('UPDATE browser_sessions SET csrf_digest = ?').run(uppercase),
    checkConstraint
  );
  assert.throws(
    () => database.prepare('UPDATE idempotency_records SET key_hash = ?').run(uppercase),
    checkConstraint
  );
  assert.throws(
    () => database.prepare('UPDATE idempotency_records SET request_hash = ?').run(uppercase),
    checkConstraint
  );
  assert.throws(
    () => database.prepare('UPDATE idempotency_records SET result_digest = ?').run(uppercase),
    checkConstraint
  );
  assert.throws(
    () => database.prepare('UPDATE run_cursors SET last_event_hash = ?').run(uppercase),
    checkConstraint
  );
  assert.throws(
    () => database.prepare('UPDATE schema_migrations SET checksum = ?').run(uppercase),
    checkConstraint
  );
});

test('retention bounds idempotency receipts per account', (t) => {
  const { databasePath, store } = createTestStore(t);
  provisionAccount(store, 'bounded');
  store.registerThread({
    accountId: 'account-bounded',
    threadId: 'thread-bounded',
    idempotencyKey: 'thread-bounded-register-0001'
  });
  for (let index = 0; index < MAX_IDEMPOTENCY_RECEIPTS_PER_ACCOUNT + 12; index += 1) {
    store.updateThreadPresentation({
      accountId: 'account-bounded',
      threadId: 'thread-bounded',
      patch: { title: `Bounded ${index}` },
      idempotencyKey: `thread-bounded-update-${String(index).padStart(4, '0')}`
    });
  }
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM idempotency_records WHERE account_id = ?',
      'account-bounded'
    )),
    MAX_IDEMPOTENCY_RECEIPTS_PER_ACCOUNT
  );
});

test('browser-session admission below the cap does not evict an existing session', (t) => {
  const { databasePath, store } = createTestStore(t);
  provisionAccount(store, 'below-cap');
  const first = sessionInput('below-cap', 'first');
  const second = sessionInput('below-cap', 'second');
  const admitted = sessionInput('below-cap', 'admitted');
  store.createBrowserSession(first);
  store.createBrowserSession(second);

  store.createBrowserSession(admitted);

  assert.ok(store.authenticateBrowserSession({ sessionToken: first.sessionToken }));
  assert.ok(store.authenticateBrowserSession({ sessionToken: second.sessionToken }));
  assert.ok(store.authenticateBrowserSession({ sessionToken: admitted.sessionToken }));
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-below-cap'
    )),
    3
  );
});

test('browser-session admission purges expired sessions before deciding whether to evict', (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'expiry-admission');
  const expired = sessionInput('expiry-admission', 'expires-first', {
    expiresAt: '2026-08-20T00:01:00.000Z'
  });
  store.createBrowserSession(expired);
  const retained = [];
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT - 1; index += 1) {
    const input = sessionInput('expiry-admission', `retained-${String(index).padStart(4, '0')}`);
    retained.push(input);
    store.createBrowserSession(input);
  }
  currentTime = Date.parse('2026-08-20T00:02:00.000Z');

  store.createBrowserSession(sessionInput('expiry-admission', 'replacement'));

  assert.equal(store.authenticateBrowserSession({ sessionToken: expired.sessionToken }), null);
  for (const input of retained) {
    assert.ok(store.authenticateBrowserSession({ sessionToken: input.sessionToken }));
  }
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-expiry-admission'
    )),
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );
});

test('browser-session admission at the cap evicts exactly the oldest issued session', (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'at-cap');
  const sessions = [];

  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT; index += 1) {
    const input = sessionInput('at-cap', String(index).padStart(4, '0'));
    sessions.push(input);
    store.createBrowserSession(input);
    currentTime += 1_000;
  }
  const admitted = sessionInput('at-cap', 'replacement');

  const created = store.createBrowserSession(admitted);
  assert.equal(created.accountId, 'account-at-cap');
  assert.deepEqual(store.createBrowserSession(admitted), created);

  assert.equal(store.authenticateBrowserSession({ sessionToken: sessions[0].sessionToken }), null);
  assert.ok(store.authenticateBrowserSession({ sessionToken: sessions[1].sessionToken }));
  assert.ok(store.authenticateBrowserSession({ sessionToken: admitted.sessionToken }));
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-at-cap'
    )),
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );
});

test('browser-session admission at the cap cannot evict and rebind an existing token', (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'rebind');
  const sessions = [];
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT; index += 1) {
    const input = sessionInput('rebind', String(index).padStart(4, '0'));
    sessions.push(input);
    store.createBrowserSession(input);
    currentTime += 1_000;
  }
  const oldest = sessions[0];
  const replacementCsrf = `csrf-rebind-replacement-${'r'.repeat(40)}`;

  assert.throws(
    () => store.createBrowserSession(sessionInput('rebind', 'replacement', {
      sessionToken: oldest.sessionToken,
      csrfToken: replacementCsrf,
      idempotencyKey: 'browser-session-create-rebind-existing-token'
    })),
    ConflictError
  );

  assert.ok(store.authenticateBrowserMutation({
    sessionToken: oldest.sessionToken,
    csrfToken: oldest.csrfToken
  }));
  assert.equal(store.authenticateBrowserMutation({
    sessionToken: oldest.sessionToken,
    csrfToken: replacementCsrf
  }), null);
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-rebind'
    )),
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );
});

test('browser-session eviction is isolated to the account being admitted', (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'isolated-full');
  provisionAccount(store, 'isolated-other');
  const other = sessionInput('isolated-other', 'must-remain');
  store.createBrowserSession(other);
  currentTime += 1_000;
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT; index += 1) {
    store.createBrowserSession(sessionInput('isolated-full', String(index).padStart(4, '0')));
    currentTime += 1_000;
  }

  store.createBrowserSession(sessionInput('isolated-full', 'replacement'));

  assert.ok(store.authenticateBrowserSession({ sessionToken: other.sessionToken }));
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-isolated-other'
    )),
    1
  );
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-isolated-full'
    )),
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );
});

test('browser-session eviction breaks equal issuance-time ties by session digest', (t) => {
  const { store } = createTestStore(t, {
    clock: () => new Date('2026-08-20T00:00:00.000Z')
  });
  provisionAccount(store, 'tie');
  const sessions = [];
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT; index += 1) {
    const input = sessionInput('tie', String(index).padStart(4, '0'));
    sessions.push(input);
    store.createBrowserSession(input);
  }
  const expectedEviction = sessions.toSorted((first, second) => (
    digestSecret(first.sessionToken, 'sessionToken')
      .localeCompare(digestSecret(second.sessionToken, 'sessionToken'))
  ))[0];

  store.createBrowserSession(sessionInput('tie', 'replacement'));

  for (const input of sessions) {
    const authenticated = store.authenticateBrowserSession({ sessionToken: input.sessionToken });
    assert.equal(authenticated === null, input === expectedEviction);
  }
});

test('conflicting browser-session admission preserves capacity state and does not reserve its receipt', (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'rollback-full');
  provisionAccount(store, 'rollback-other');
  const sessions = [];
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT; index += 1) {
    const input = sessionInput('rollback-full', String(index).padStart(4, '0'));
    sessions.push(input);
    store.createBrowserSession(input);
    currentTime += 1_000;
  }
  const collision = sessionInput('rollback-other', 'collision');
  store.createBrowserSession(collision);
  const failedIdempotencyKey = 'browser-session-create-rollback-after-eviction';

  assert.throws(
    () => store.createBrowserSession(sessionInput('rollback-full', 'collision-attempt', {
      sessionToken: collision.sessionToken,
      idempotencyKey: failedIdempotencyKey
    })),
    ConflictError
  );

  assert.ok(store.authenticateBrowserSession({ sessionToken: sessions[0].sessionToken }));
  assert.ok(store.authenticateBrowserSession({ sessionToken: collision.sessionToken }));
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-rollback-full'
    )),
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );
  assert.ok(store.createBrowserSession(sessionInput('rollback-full', 'retry', {
    idempotencyKey: failedIdempotencyKey
  })));
});

test('concurrent and sequential browser-session admissions remain bounded', async (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'serialized');
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT - 1; index += 1) {
    store.createBrowserSession(sessionInput('serialized', `initial-${String(index).padStart(4, '0')}`));
    currentTime += 1_000;
  }
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrierView = new Int32Array(barrier);
  const concurrentInputs = [
    sessionInput('serialized', 'concurrent-a'),
    sessionInput('serialized', 'concurrent-b')
  ];
  const admissions = concurrentInputs.map((input) => runConcurrentSessionCreate({
    databasePath,
    input,
    clock: '2026-08-21T00:00:00.000Z',
    barrier
  }));
  while (Atomics.load(barrierView, 0) !== concurrentInputs.length) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  Atomics.store(barrierView, 1, 1);
  Atomics.notify(barrierView, 1, concurrentInputs.length);
  await Promise.all(admissions);

  assert.ok(store.authenticateBrowserSession({ sessionToken: concurrentInputs[0].sessionToken }));
  assert.ok(store.authenticateBrowserSession({ sessionToken: concurrentInputs[1].sessionToken }));
  assert.equal(
    Number(queryScalar(
      databasePath,
      'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
      'account-serialized'
    )),
    MAX_BROWSER_SESSIONS_PER_ACCOUNT
  );

  currentTime = Date.parse('2026-08-22T00:00:00.000Z');
  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT + 5; index += 1) {
    store.createBrowserSession(sessionInput('serialized', `sequential-${String(index).padStart(4, '0')}`));
    currentTime += 1_000;
    assert.equal(
      Number(queryScalar(
        databasePath,
        'SELECT count(*) AS value FROM browser_sessions WHERE account_id = ?',
        'account-serialized'
      )),
      MAX_BROWSER_SESSIONS_PER_ACCOUNT
    );
  }
});

test('maintenance purges expired sessions and receipts', (t) => {
  let currentTime = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const { databasePath, store } = createTestStore(t, { clock });
  provisionAccount(store, 'expiry');
  store.createBrowserSession({
    accountId: 'account-expiry',
    sessionToken: `${SESSION_TOKEN}-expiry`,
    csrfToken: `${CSRF_TOKEN}-expiry`,
    expiresAt: '2026-08-20T01:00:00.000Z',
    idempotencyKey: 'browser-session-expiry-create-0001'
  });

  currentTime += IDEMPOTENCY_RECEIPT_TTL_MS + 1;
  const removed = store.pruneExpiredState();
  assert.equal(removed.browserSessionsRemoved, 1);
  assert.ok(removed.idempotencyReceiptsRemoved >= 2);
  assert.equal(
    Number(queryScalar(databasePath, 'SELECT count(*) AS value FROM browser_sessions')),
    0
  );
  assert.equal(
    Number(queryScalar(databasePath, 'SELECT count(*) AS value FROM idempotency_records')),
    0
  );
});

test('canonical hashing rejects sparse, extended, symbol, and accessor data', () => {
  const sparse = new Array(2);
  sparse[1] = 'value';
  assert.throws(() => canonicalJson(sparse), ValidationError);

  const extended = ['value'];
  extended.extra = 'forbidden';
  assert.throws(() => canonicalJson(extended), ValidationError);

  const symbolObject = { safe: true };
  symbolObject[Symbol('hidden')] = 'forbidden';
  assert.throws(() => canonicalJson(symbolObject), ValidationError);

  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      return 'forbidden';
    }
  });
  assert.throws(() => canonicalJson(accessor), ValidationError);

  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
});
