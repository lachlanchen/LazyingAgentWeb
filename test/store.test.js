import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  ConflictError,
  IDEMPOTENCY_RECEIPT_TTL_MS,
  IdempotencyConflictError,
  MAX_BROWSER_SESSIONS_PER_ACCOUNT,
  MAX_IDEMPOTENCY_RECEIPTS_PER_ACCOUNT,
  NotFoundError,
  ValidationError
} from '../src/index.js';
import { canonicalJson } from '../src/validation.js';
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

test('retention bounds receipts and active browser sessions per account', (t) => {
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

  for (let index = 0; index < MAX_BROWSER_SESSIONS_PER_ACCOUNT; index += 1) {
    store.createBrowserSession({
      accountId: 'account-bounded',
      sessionToken: `bounded-session-${String(index).padStart(4, '0')}-${'s'.repeat(32)}`,
      csrfToken: `bounded-csrf-${String(index).padStart(4, '0')}-${'c'.repeat(32)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      idempotencyKey: `bounded-session-create-${String(index).padStart(4, '0')}`
    });
  }
  assert.throws(
    () => store.createBrowserSession({
      accountId: 'account-bounded',
      sessionToken: `bounded-session-over-limit-${'s'.repeat(32)}`,
      csrfToken: `bounded-csrf-over-limit-${'c'.repeat(32)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      idempotencyKey: 'bounded-session-create-over-limit'
    }),
    ConflictError
  );
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
