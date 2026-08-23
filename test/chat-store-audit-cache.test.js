import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { DirectChatStore } from '../src/chat-store.js';
import { StorageCorruptionError } from '../src/errors.js';
import { validateVisionAttachmentRequest } from '../src/vision-attachment.js';
import { createPwaIcon } from '../src/web/pwa-assets.js';

const MESSAGE_AUDIT_QUERY = [
  'SELECT * FROM direct_chat_messages',
  'WHERE account_id = ? AND thread_id = ?',
  'ORDER BY revision'
].join(' ');
const DELTA_AUDIT_QUERY = [
  'SELECT * FROM direct_chat_deltas',
  'WHERE account_id = ? AND thread_id = ? AND generation_id = ?',
  'ORDER BY sequence'
].join(' ');

function normalizeSql(sql) {
  return sql.replace(/\s+/gu, ' ').trim();
}

function observeDeepAuditWork(t) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const counts = {
    threadAudits: 0,
    messageHashes: 0,
    deltaHashes: 0
  };
  DatabaseSync.prototype.prepare = function prepareWithAuditCounters(sql) {
    const statement = originalPrepare.call(this, sql);
    const normalized = normalizeSql(sql);
    if (normalized !== MESSAGE_AUDIT_QUERY && normalized !== DELTA_AUDIT_QUERY) return statement;
    const originalAll = statement.all.bind(statement);
    statement.all = (...parameters) => {
      const rows = originalAll(...parameters);
      if (normalized === MESSAGE_AUDIT_QUERY) {
        counts.threadAudits += 1;
        counts.messageHashes += rows.length;
      } else {
        counts.deltaHashes += rows.length;
      }
      return rows;
    };
    return statement;
  };
  t.after(() => {
    DatabaseSync.prototype.prepare = originalPrepare;
  });
  return {
    counts,
    reset() {
      counts.threadAudits = 0;
      counts.messageHashes = 0;
      counts.deltaHashes = 0;
    }
  };
}

function testState(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-chat-audit-cache-'));
  const databasePath = join(root, 'private', 'chat.sqlite');
  const stores = [];
  const openStore = (overrides = {}) => {
    const store = new DirectChatStore({ databasePath, ...options, ...overrides });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores.reverse()) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { databasePath, openStore };
}

function createThread(store, suffix) {
  return store.createThread({
    accountId: `account-${suffix}`,
    threadId: `thread-${suffix}`,
    title: `Chat ${suffix}`,
    idempotencyKey: `create-${suffix}-00000001`
  });
}

function appendUser(store, thread, suffix) {
  return store.sendUserMessage({
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: `user-${suffix}`,
    content: `Message ${suffix}`,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: `message-${suffix}-00000001`
  });
}

function completeTurn(store, thread, suffix) {
  const started = store.startTurn({
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: `user-${suffix}`,
    content: `Message ${suffix}`,
    generationId: `generation-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: `turn-${suffix}-00000001`
  });
  let expectedHash = null;
  for (const [expectedSequence, content] of ['first ', 'second'].entries()) {
    const delta = store.appendGenerationDelta({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: started.generation.generationId,
      expectedSequence,
      expectedHash,
      content
    });
    expectedHash = delta.deltaHash;
  }
  store.finalizeGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: started.generation.generationId,
    idempotencyKey: `finalize-${suffix}-00000001`
  });
}

test('unchanged reads reuse one account-and-thread audit and avoid repeated ledger hash work', (t) => {
  const observer = observeDeepAuditWork(t);
  const { openStore } = testState(t);
  const store = openStore();
  const thread = createThread(store, 'unchanged');
  completeTurn(store, thread, 'unchanged');
  observer.reset();

  for (let index = 0; index < 5; index += 1) {
    assert.equal(store.listThreads({ accountId: thread.accountId }).length, 1);
    assert.equal(store.getThread(thread.accountId, thread.threadId).messageCount, 2);
    assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 2);
  }

  assert.deepEqual(observer.counts, {
    threadAudits: 1,
    messageHashes: 2,
    deltaHashes: 2
  });
});

test('a local mutation invalidates both its pre-mutation audit and the next read audit', (t) => {
  const observer = observeDeepAuditWork(t);
  const { openStore } = testState(t);
  const store = openStore();
  const thread = createThread(store, 'local-mutation');
  observer.reset();

  assert.deepEqual(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }), []);
  const message = appendUser(store, thread, 'local-mutation');
  assert.equal(message.revision, 1);
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);

  assert.equal(observer.counts.threadAudits, 3);
  assert.equal(observer.counts.messageHashes, 1);
});

test('an external SQLite commit invalidates cached state and corruption errors never become cache hits', (t) => {
  const observer = observeDeepAuditWork(t);
  const { databasePath, openStore } = testState(t);
  const store = openStore();
  const thread = createThread(store, 'external');
  appendUser(store, thread, 'external');
  observer.reset();

  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  const external = new DatabaseSync(databasePath);
  try {
    external.prepare(`
      UPDATE direct_chat_threads SET ledger_hash = ?
      WHERE account_id = ? AND thread_id = ?
    `).run('f'.repeat(64), thread.accountId, thread.threadId);
  } finally {
    external.close();
  }

  assert.throws(
    () => store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }),
    StorageCorruptionError
  );
  assert.throws(
    () => store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }),
    StorageCorruptionError
  );
  assert.equal(observer.counts.threadAudits, 3);
});

test('a valid commit from another store forces re-audit before returning its new rows', (t) => {
  const observer = observeDeepAuditWork(t);
  const { openStore } = testState(t);
  const first = openStore();
  const thread = createThread(first, 'external-store');
  const second = openStore();
  observer.reset();

  assert.deepEqual(first.listMessages({ accountId: thread.accountId, threadId: thread.threadId }), []);
  appendUser(second, thread, 'external-store');
  assert.equal(first.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.equal(first.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);

  // One first-store read, one uncached write precondition in the second store,
  // then one data_version-invalidated read back in the first store.
  assert.equal(observer.counts.threadAudits, 3);
});

test('attachment-byte corruption remains detectable after an audited thread was cached', (t) => {
  const observer = observeDeepAuditWork(t);
  const { databasePath, openStore } = testState(t, { enableVisionAttachments: true });
  const store = openStore();
  const thread = createThread(store, 'attachment-corruption');
  const attachment = validateVisionAttachmentRequest({
    attachmentId: 'image-attachment-corruption-0001',
    mediaType: 'image/png',
    data: Buffer.from(createPwaIcon(192)).toString('base64')
  });
  store.startTurn({
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-attachment-corruption',
    content: 'Describe this image.',
    generationId: 'generation-attachment-corruption',
    assistantMessageId: 'assistant-attachment-corruption',
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: 'turn-attachment-corruption-0001',
    attachment
  });
  observer.reset();
  assert.deepEqual(store.getVisionAttachment({
    accountId: thread.accountId,
    threadId: thread.threadId,
    attachmentId: attachment.attachmentId
  }).content, attachment.content);

  const external = new DatabaseSync(databasePath);
  try {
    const triggerSql = external.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'direct_chat_attachments_no_update'
    `).get().sql;
    external.exec('DROP TRIGGER direct_chat_attachments_no_update');
    external.prepare(`
      UPDATE direct_chat_attachments SET content = zeroblob(byte_length)
      WHERE account_id = ? AND thread_id = ? AND attachment_id = ?
    `).run(thread.accountId, thread.threadId, attachment.attachmentId);
    external.exec(triggerSql);
  } finally {
    external.close();
  }

  assert.throws(
    () => store.getVisionAttachment({
      accountId: thread.accountId,
      threadId: thread.threadId,
      attachmentId: attachment.attachmentId
    }),
    StorageCorruptionError
  );
  assert.equal(observer.counts.threadAudits, 2);
});

test('audited thread state is private to each store instance', (t) => {
  const observer = observeDeepAuditWork(t);
  const { openStore } = testState(t);
  const first = openStore();
  const thread = createThread(first, 'store-isolation');
  appendUser(first, thread, 'store-isolation');
  const second = openStore();
  observer.reset();

  assert.equal(first.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.equal(first.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.equal(second.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.equal(second.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);

  assert.equal(observer.counts.threadAudits, 2);
});

test('audited thread state is bounded and evicts the least recently used identity', (t) => {
  const observer = observeDeepAuditWork(t);
  const { openStore } = testState(t);
  const store = openStore();
  const threads = [];
  for (let index = 0; index < 257; index += 1) {
    threads.push(createThread(store, `lru-${String(index).padStart(3, '0')}`));
  }
  observer.reset();

  for (const thread of threads) {
    assert.equal(store.listThreads({ accountId: thread.accountId }).length, 1);
  }
  assert.equal(observer.counts.threadAudits, 257);
  const mostRecent = threads.at(-1);
  assert.equal(store.getThread(mostRecent.accountId, mostRecent.threadId).threadId, mostRecent.threadId);
  assert.equal(observer.counts.threadAudits, 257);
  const evicted = threads[0];
  assert.equal(store.getThread(evicted.accountId, evicted.threadId).threadId, evicted.threadId);
  assert.equal(observer.counts.threadAudits, 258);
});
