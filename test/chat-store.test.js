import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  DIRECT_CHAT_DISPATCH_LEASE_LIMITS,
  DIRECT_CHAT_IDEMPOTENCY_TTL_MS,
  DIRECT_CHAT_LIMITS,
  DirectChatStore
} from '../src/chat-store.js';
import {
  CHAT_SQLITE_APPLICATION_ID,
  DEFAULT_CHAT_SCHEMA_VERSION,
  LATEST_CHAT_SCHEMA_VERSION
} from '../src/chat-migrations.js';
import { validateVisionAttachmentRequest, VISION_MODEL_ALIAS } from '../src/vision-attachment.js';
import { createPwaIcon } from '../src/web/pwa-assets.js';
import { sha256 } from '../src/validation.js';
import {
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  StorageCorruptionError,
  StorageSecurityError,
  UnsupportedSchemaError,
  ValidationError
} from '../src/errors.js';

function testState(test, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-direct-chat-test-'));
  const databasePath = join(root, 'private', 'chat.sqlite');
  let store = new DirectChatStore({ databasePath, ...options });
  test.after(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    databasePath,
    get store() {
      return store;
    },
    replaceStore(nextStore) {
      store = nextStore;
    }
  };
}

function createThread(store, suffix = 'one', overrides = {}) {
  return store.createThread({
    accountId: `account-${suffix}`,
    threadId: `thread-${suffix}`,
    title: `Chat ${suffix}`,
    idempotencyKey: `create-thread-${suffix}-0001`,
    ...overrides
  });
}

function sendUser(store, thread, suffix = 'one', overrides = {}) {
  return store.sendUserMessage({
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: `user-${suffix}`,
    content: `User message ${suffix}`,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: `send-user-${suffix}-0001`,
    ...overrides
  });
}

function startGeneration(store, userMessage, suffix = 'one', overrides = {}) {
  return store.startGeneration({
    accountId: userMessage.accountId,
    threadId: userMessage.threadId,
    generationId: `generation-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    expectedRevision: userMessage.revision,
    expectedHash: userMessage.messageHash,
    idempotencyKey: `start-generation-${suffix}-0001`,
    ...overrides
  });
}

function startTurn(store, thread, suffix = 'one', overrides = {}) {
  return store.startTurn({
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: `user-${suffix}`,
    content: `User message ${suffix}`,
    generationId: `generation-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: `start-turn-${suffix}-0001`,
    ...overrides
  });
}

function visionAttachment(suffix = 'one') {
  return validateVisionAttachmentRequest({
    attachmentId: `image-${suffix}-0000000000000001`,
    mediaType: 'image/png',
    data: Buffer.from(createPwaIcon(192)).toString('base64')
  });
}

function appendDelta(store, generation, sequence, content) {
  const current = store.getGeneration({
    accountId: generation.accountId,
    threadId: generation.threadId,
    generationId: generation.generationId
  });
  return store.appendGenerationDelta({
    accountId: generation.accountId,
    threadId: generation.threadId,
    generationId: generation.generationId,
    expectedSequence: sequence,
    expectedHash: current.lastDeltaHash,
    content
  });
}

const DISPATCH_OWNER_A = 'dispatch-owner-a-000000000000000000000000';
const DISPATCH_OWNER_B = 'dispatch-owner-b-000000000000000000000000';

function dispatchProof(ownerToken, lease) {
  return { ownerToken, fence: lease.fence };
}

function appendLeasedDelta(store, generation, sequence, content, ownerToken, lease) {
  const current = store.getGeneration({
    accountId: generation.accountId,
    threadId: generation.threadId,
    generationId: generation.generationId
  });
  return store.appendGenerationDelta({
    accountId: generation.accountId,
    threadId: generation.threadId,
    generationId: generation.generationId,
    expectedSequence: sequence,
    expectedHash: current.lastDeltaHash,
    content,
    dispatchLease: dispatchProof(ownerToken, lease)
  });
}

function scalar(databasePath, sql, ...parameters) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(sql).get(...parameters)?.value;
  } finally {
    database.close();
  }
}

test('uses a separate private SQLite identity and a server-selected model alias', (t) => {
  const { databasePath, store } = testState(t, { modelAlias: 'qwen-edge' });
  const thread = createThread(store, 'private');

  assert.equal(thread.modelAlias, 'qwen-edge');
  assert.equal(lstatSync(join(databasePath, '..')).mode & 0o777, 0o700);
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
  assert.equal(lstatSync(databasePath).nlink, 1);
  assert.equal(
    Number(scalar(databasePath, 'SELECT application_id AS value FROM pragma_application_id')),
    CHAT_SQLITE_APPLICATION_ID
  );

  assert.throws(
    () => store.createThread({
      accountId: 'account-private',
      threadId: 'thread-extra',
      providerUrl: 'https://provider.invalid',
      idempotencyKey: 'create-thread-extra-0001'
    }),
    ValidationError
  );
  assert.throws(
    () => new DirectChatStore({ databasePath: join(databasePath, '..', 'other.sqlite'), modelAlias: '/model/path' }),
    ValidationError
  );

  const database = new DatabaseSync(databasePath);
  try {
    const columnNames = database.prepare(`
      SELECT name FROM pragma_table_info('direct_chat_threads')
      UNION ALL SELECT name FROM pragma_table_info('direct_chat_generations')
      ORDER BY name
    `).all().map((row) => row.name);
    for (const forbidden of ['credential', 'api_key', 'provider_url', 'tool', 'path', 'docker', 'agent_plan']) {
      assert.equal(columnNames.includes(forbidden), false);
    }
  } finally {
    database.close();
  }
});

test('binds every thread, message, generation, delta, and snapshot lookup to an account', (t) => {
  const { store } = testState(t);
  const thread = createThread(store, 'owner');
  const user = sendUser(store, thread, 'owner');
  const generation = startGeneration(store, user, 'owner');
  appendDelta(store, generation, 0, 'private output');

  assert.equal(store.getThread('account-other', thread.threadId), null);
  assert.equal(store.getGeneration({
    accountId: 'account-other',
    threadId: thread.threadId,
    generationId: generation.generationId
  }), null);
  assert.throws(
    () => store.listMessages({ accountId: 'account-other', threadId: thread.threadId }),
    NotFoundError
  );
  assert.throws(
    () => store.replayGeneration({
      accountId: 'account-other',
      threadId: thread.threadId,
      generationId: generation.generationId
    }),
    NotFoundError
  );
  assert.equal(store.getLatestCompactionSnapshot('account-other', thread.threadId), null);
});

test('appends an immutable monotonic user/assistant hash ledger and rejects stale cursors', (t) => {
  const { databasePath, store } = testState(t);
  const thread = createThread(store, 'ledger');
  const first = sendUser(store, thread, 'ledger', { content: 'Plot $y=x^2$.' });
  assert.equal(first.revision, 1);
  assert.equal(first.previousHash, null);
  assert.match(first.messageHash, /^[a-f0-9]{64}$/u);

  assert.throws(
    () => store.sendUserMessage({
      accountId: thread.accountId,
      threadId: thread.threadId,
      messageId: 'stale-user',
      content: 'stale',
      expectedRevision: 0,
      expectedHash: null,
      idempotencyKey: 'send-stale-user-0001'
    }),
    ConflictError
  );

  const generation = startGeneration(store, first, 'ledger');
  appendDelta(store, generation, 0, 'The curve ');
  appendDelta(store, generation, 1, 'is a parabola.');
  const completed = store.finalizeGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    idempotencyKey: 'finalize-ledger-0001'
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.terminal, true);
  assert.equal(completed.finalRevision, 2);

  const messages = store.listMessages({ accountId: thread.accountId, threadId: thread.threadId });
  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Plot $y=x^2$.' },
    { role: 'assistant', content: 'The curve is a parabola.' }
  ]);
  assert.equal(messages[1].previousHash, messages[0].messageHash);
  assert.equal(messages[1].messageHash, completed.finalHash);

  const database = new DatabaseSync(databasePath);
  try {
    assert.throws(
      () => database.prepare(`
        UPDATE direct_chat_messages SET content = 'changed'
        WHERE account_id = ? AND thread_id = ? AND revision = 1
      `).run(thread.accountId, thread.threadId),
      /append-only/u
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM direct_chat_messages WHERE account_id = ? AND thread_id = ?
      `).run(thread.accountId, thread.threadId),
      /append-only/u
    );
  } finally {
    database.close();
  }
});

test('persists and resumes in-progress deltas across restart without duplicate assistant turns', (t) => {
  const state = testState(t, { modelAlias: 'local-code' });
  const thread = createThread(state.store, 'restart');
  const user = sendUser(state.store, thread, 'restart');
  const generation = startGeneration(state.store, user, 'restart');
  const firstDelta = appendDelta(state.store, generation, 0, 'first ');
  assert.equal(
    Number(scalar(
      state.databasePath,
      'SELECT count(*) AS value FROM direct_chat_idempotency WHERE account_id = ?',
      thread.accountId
    )),
    3
  );
  state.store.close();

  const reopened = new DirectChatStore({
    databasePath: state.databasePath,
    // A changed server default must not rewrite an existing thread/generation alias.
    modelAlias: 'new-server-default'
  });
  state.replaceStore(reopened);
  const replay = reopened.replayGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    afterSequence: 0
  });
  assert.equal(replay.generation.status, 'in_progress');
  assert.equal(replay.generation.modelAlias, 'local-code');
  assert.deepEqual(replay.deltas.map((delta) => delta.content), ['first ']);

  assert.deepEqual(
    reopened.appendGenerationDelta({
      accountId: generation.accountId,
      threadId: generation.threadId,
      generationId: generation.generationId,
      expectedSequence: 0,
      expectedHash: null,
      content: 'first '
    }),
    firstDelta
  );
  assert.throws(
    () => reopened.appendGenerationDelta({
      accountId: generation.accountId,
      threadId: generation.threadId,
      generationId: generation.generationId,
      expectedSequence: 0,
      expectedHash: null,
      content: 'changed first delta'
    }),
    ConflictError
  );
  appendDelta(reopened, generation, 1, 'second', 'restart-second');
  const finalizeRequest = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    idempotencyKey: 'finalize-restart-0001'
  };
  const finalized = reopened.finalizeGeneration(finalizeRequest);
  assert.deepEqual(reopened.finalizeGeneration(finalizeRequest), finalized);
  assert.equal(
    Number(scalar(
      state.databasePath,
      `SELECT count(*) AS value FROM direct_chat_messages
       WHERE account_id = ? AND thread_id = ? AND role = 'assistant'`,
      thread.accountId,
      thread.threadId
    )),
    1
  );

  // Starting and creating remain safely replayable even after their resources advance.
  assert.equal(startGeneration(reopened, user, 'restart').status, 'completed');
  assert.equal(createThread(reopened, 'restart').revision, 2);
});

test('atomically persists one user message, one active generation, and one idempotency receipt', (t) => {
  const { databasePath, store } = testState(t, { modelAlias: 'local-atomic' });
  const thread = createThread(store, 'atomic');
  const result = startTurn(store, thread, 'atomic', {
    content: 'Plot $y=x^2$ without provider controls.'
  });

  assert.deepEqual(
    Object.keys(result).sort(),
    ['generation', 'message']
  );
  assert.equal(result.message.role, 'user');
  assert.equal(result.message.revision, 1);
  assert.equal(result.generation.status, 'in_progress');
  assert.equal(result.generation.sourceRevision, result.message.revision);
  assert.equal(result.generation.sourceHash, result.message.messageHash);
  assert.equal(result.generation.modelAlias, 'local-atomic');
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_idempotency
       WHERE account_id = ? AND operation = 'generation.start'`,
      thread.accountId
    )),
    1
  );
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_idempotency
       WHERE account_id = ? AND operation = 'message.user.append'`,
      thread.accountId
    )),
    0
  );
  assert.deepEqual(
    store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }),
    [result.message]
  );
  assert.equal(
    store.getThread(thread.accountId, thread.threadId).currentGenerationId,
    result.generation.generationId
  );

  assert.throws(
    () => store.startTurn({
      accountId: thread.accountId,
      threadId: thread.threadId,
      messageId: 'user-forbidden-control',
      content: 'no',
      generationId: 'generation-forbidden-control',
      assistantMessageId: 'assistant-forbidden-control',
      expectedRevision: thread.revision,
      expectedHash: thread.ledgerHash,
      idempotencyKey: 'start-turn-forbidden-control-0001',
      providerUrl: 'https://provider.invalid'
    }),
    ValidationError
  );
});

test('atomically stores private canonical image bytes while exposing only a hash-bound descriptor', (t) => {
  const { databasePath, store } = testState(t, {
    modelAlias: 'localllm-fast',
    enableVisionAttachments: true
  });
  const thread = createThread(store, 'vision');
  const attachment = visionAttachment('vision');
  const request = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-vision',
    content: 'Describe the important details in this image.',
    generationId: 'generation-vision',
    assistantMessageId: 'assistant-vision',
    expectedRevision: thread.revision,
    expectedHash: thread.ledgerHash,
    idempotencyKey: 'start-turn-vision-0001',
    attachment
  };
  const committed = store.startTurn(request);

  assert.equal(committed.generation.modelAlias, VISION_MODEL_ALIAS);
  assert.deepEqual(committed.message.attachment, {
    attachmentId: attachment.attachmentId,
    mediaType: attachment.mediaType,
    byteLength: attachment.byteLength,
    width: attachment.width,
    height: attachment.height,
    sha256: attachment.contentSha256
  });
  assert.equal(Object.hasOwn(committed.message.attachment, 'content'), false);
  assert.equal(Object.hasOwn(committed.message.attachment, 'data'), false);
  assert.deepEqual(store.startTurn(request), committed);

  const publicLedger = store.listMessages({
    accountId: thread.accountId,
    threadId: thread.threadId
  });
  assert.deepEqual(publicLedger, [committed.message]);
  assert.doesNotMatch(JSON.stringify(publicLedger), new RegExp(attachment.content.toString('base64'), 'u'));

  const privateAttachment = store.getVisionAttachment({
    accountId: thread.accountId,
    threadId: thread.threadId,
    attachmentId: attachment.attachmentId
  });
  assert.deepEqual(privateAttachment.content, attachment.content);
  assert.equal(privateAttachment.contentSha256, attachment.contentSha256);
  assert.equal(store.getVisionAttachment({
    accountId: 'account-other',
    threadId: thread.threadId,
    attachmentId: attachment.attachmentId
  }), null);

  const database = new DatabaseSync(databasePath);
  try {
    const persisted = database.prepare(`
      SELECT typeof(content) AS storage_type, content
      FROM direct_chat_attachments
      WHERE account_id = ? AND thread_id = ? AND attachment_id = ?
    `).get(thread.accountId, thread.threadId, attachment.attachmentId);
    assert.equal(persisted.storage_type, 'blob');
    assert.deepEqual(Buffer.from(persisted.content), attachment.content);
    assert.equal(database.prepare(`
      SELECT content FROM direct_chat_messages
      WHERE account_id = ? AND thread_id = ? AND message_id = ?
    `).get(thread.accountId, thread.threadId, committed.message.messageId).content, request.content);
    assert.throws(() => database.prepare(`
      UPDATE direct_chat_attachments SET content = zeroblob(byte_length)
      WHERE account_id = ? AND thread_id = ? AND attachment_id = ?
    `).run(thread.accountId, thread.threadId, attachment.attachmentId), /immutable/u);
    assert.throws(() => database.prepare(`
      DELETE FROM direct_chat_attachments
      WHERE account_id = ? AND thread_id = ? AND attachment_id = ?
    `).run(thread.accountId, thread.threadId, attachment.attachmentId), /durable/u);
  } finally {
    database.close();
  }

  appendDelta(store, committed.generation, 0, 'The image contains the LazyingArt mark.');
  store.finalizeGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: committed.generation.generationId,
    idempotencyKey: 'finalize-vision-0001'
  });
  const updated = store.getThread(thread.accountId, thread.threadId);
  const followup = startTurn(store, updated, 'vision-followup', {
    content: 'Now focus on its proportions.'
  });
  assert.equal(followup.generation.modelAlias, VISION_MODEL_ALIAS);
  assert.deepEqual(store.getLatestVisionAttachment({
    accountId: thread.accountId,
    threadId: thread.threadId,
    sourceRevision: followup.generation.sourceRevision
  }).content, attachment.content);
});

test('gates v3 expansion but exactly replays committed image turns while vision is disabled for rollback', (t) => {
  const state = testState(t, { modelAlias: 'localllm-fast' });
  const thread = createThread(state.store, 'vision-migration');
  assert.equal(
    Number(scalar(state.databasePath, 'SELECT user_version AS value FROM pragma_user_version')),
    DEFAULT_CHAT_SCHEMA_VERSION
  );
  assert.equal(
    Number(scalar(state.databasePath, `
      SELECT count(*) AS value FROM sqlite_schema
      WHERE type = 'table' AND name = 'direct_chat_attachments'
    `)),
    0
  );
  assert.throws(
    () => startTurn(state.store, thread, 'vision-disabled', { attachment: visionAttachment('disabled') }),
    /not enabled/u
  );

  state.store.close();
  let reopened = new DirectChatStore({
    databasePath: state.databasePath,
    modelAlias: 'localllm-fast',
    enableVisionAttachments: true
  });
  state.replaceStore(reopened);
  assert.equal(
    Number(scalar(state.databasePath, 'SELECT user_version AS value FROM pragma_user_version')),
    LATEST_CHAT_SCHEMA_VERSION
  );
  const committed = startTurn(reopened, thread, 'vision-migrated', {
    attachment: visionAttachment('migrated')
  });
  assert.equal(committed.generation.modelAlias, VISION_MODEL_ALIAS);

  reopened.close();
  reopened = new DirectChatStore({
    databasePath: state.databasePath,
    modelAlias: 'localllm-fast',
    enableVisionAttachments: false
  });
  state.replaceStore(reopened);
  assert.equal(reopened.listMessages({
    accountId: thread.accountId,
    threadId: thread.threadId
  })[0].attachment.attachmentId, 'image-migrated-0000000000000001');
  assert.deepEqual(startTurn(reopened, thread, 'vision-migrated', {
    attachment: visionAttachment('migrated')
  }), committed, 'validated bytes and the exact receipt replay before the disabled new-write gate');
  assert.throws(
    () => reopened.startTurn({
      accountId: thread.accountId,
      threadId: thread.threadId,
      messageId: 'user-rollback-new-image',
      content: 'A new image must remain gated.',
      generationId: 'generation-rollback-new-image',
      assistantMessageId: 'assistant-rollback-new-image',
      expectedRevision: committed.message.revision,
      expectedHash: committed.message.messageHash,
      idempotencyKey: 'start-turn-rollback-image-0001',
      attachment: visionAttachment('rollback')
    }),
    /not enabled/u
  );
  assert.throws(
    () => startTurn(reopened, thread, 'rollback-image-followup', {
      content: 'A new text follow-up must not select vision while rollback has it disabled.',
      expectedRevision: committed.message.revision,
      expectedHash: committed.message.messageHash
    }),
    /not enabled/u
  );
  assert.deepEqual(reopened.listMessages({
    accountId: thread.accountId,
    threadId: thread.threadId
  }), [committed.message], 'replay and rejected new writes leave the image ledger unchanged');
});

test('replays an atomic turn exactly after response loss and restart without duplicating either resource', (t) => {
  const state = testState(t);
  const thread = createThread(state.store, 'atomic-restart');
  const request = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-atomic-restart',
    content: 'Persist before the response is lost.',
    generationId: 'generation-atomic-restart',
    assistantMessageId: 'assistant-atomic-restart',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'start-turn-atomic-restart-0001'
  };
  const committed = state.store.startTurn(request);

  // Simulate a process disappearing after COMMIT but before the caller receives a usable response.
  state.store.close();
  const reopened = new DirectChatStore({ databasePath: state.databasePath });
  state.replaceStore(reopened);
  assert.deepEqual(reopened.startTurn(request), committed);
  assert.equal(
    Number(scalar(
      state.databasePath,
      `SELECT count(*) AS value FROM direct_chat_messages
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    1
  );
  assert.equal(
    Number(scalar(
      state.databasePath,
      `SELECT count(*) AS value FROM direct_chat_generations
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    1
  );
  assert.equal(
    Number(scalar(
      state.databasePath,
      `SELECT count(*) AS value FROM direct_chat_idempotency
       WHERE account_id = ? AND operation = 'generation.start'`,
      thread.accountId
    )),
    1
  );
});

test('rolls back an interrupted atomic turn and permits an exact retry', (t) => {
  const { databasePath, store } = testState(t);
  const thread = createThread(store, 'atomic-rollback');
  const request = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-atomic-rollback',
    content: 'This first attempt must roll back.',
    generationId: 'generation-atomic-rollback',
    assistantMessageId: 'assistant-atomic-rollback',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'start-turn-atomic-rollback-0001'
  };

  let database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TRIGGER test_interrupt_atomic_turn
    BEFORE INSERT ON direct_chat_generations
    BEGIN
      SELECT RAISE(ABORT, 'simulated process interruption');
    END;
  `);
  database.close();
  assert.throws(() => store.startTurn(request), /simulated process interruption/u);
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_messages
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    0
  );
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_generations
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    0
  );
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_idempotency
       WHERE account_id = ? AND operation = 'generation.start'`,
      thread.accountId
    )),
    0
  );
  assert.equal(store.getThread(thread.accountId, thread.threadId).revision, 0);

  database = new DatabaseSync(databasePath);
  database.exec('DROP TRIGGER test_interrupt_atomic_turn');
  database.close();
  const retried = store.startTurn(request);
  assert.equal(retried.message.revision, 1);
  assert.equal(retried.generation.status, 'in_progress');
});

test('atomic turn conflicts leave no partial ledger, generation, or receipt state', (t) => {
  const { databasePath, store } = testState(t);
  let thread = createThread(store, 'atomic-conflict');
  const staleRequest = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-atomic-stale',
    content: 'stale',
    generationId: 'generation-atomic-stale',
    assistantMessageId: 'assistant-atomic-stale',
    expectedRevision: 1,
    expectedHash: 'a'.repeat(64),
    idempotencyKey: 'start-turn-atomic-stale-0001'
  };
  assert.throws(() => store.startTurn(staleRequest), ConflictError);
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 0);

  const request = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-atomic-conflict',
    content: 'original',
    generationId: 'generation-atomic-conflict',
    assistantMessageId: 'assistant-atomic-conflict',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'start-turn-atomic-conflict-0001'
  };
  const committed = store.startTurn(request);
  assert.throws(
    () => store.startTurn({ ...request, content: 'changed' }),
    IdempotencyConflictError
  );
  assert.deepEqual(store.startTurn(request), committed);
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_messages
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    1
  );
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_generations
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    1
  );
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_idempotency
       WHERE account_id = ? AND operation = 'generation.start'`,
      thread.accountId
    )),
    1
  );

  store.cancelGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: committed.generation.generationId,
    idempotencyKey: 'cancel-generation-atomic-conflict-0001'
  });
  thread = store.getThread(thread.accountId, thread.threadId);
  assert.throws(
    () => startTurn(store, thread, 'same-id', {
      messageId: 'same-message-id',
      assistantMessageId: 'same-message-id'
    }),
    ConflictError
  );
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
});

test('atomically fences overlapping generation dispatchers across store processes', (t) => {
  let milliseconds = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const state = testState(t, { clock });
  const otherStore = new DirectChatStore({ databasePath: state.databasePath, clock });
  t.after(() => {
    try {
      otherStore.close();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  });
  const thread = createThread(state.store, 'lease-overlap');
  const { generation } = startTurn(state.store, thread, 'lease-overlap');

  const firstLease = state.store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    ttlMs: 1_000
  });
  assert.equal(firstLease.fence, 1);
  assert.equal(firstLease.active, true);
  assert.equal(Object.hasOwn(firstLease, 'ownerToken'), false);
  assert.equal(Object.hasOwn(firstLease, 'ownerHash'), false);
  assert.throws(
    () => otherStore.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      ttlMs: 1_000
    }),
    ConflictError
  );
  assert.throws(
    () => appendDelta(otherStore, generation, 0, 'legacy dispatcher must be fenced'),
    ConflictError
  );
  assert.throws(
    () => appendLeasedDelta(
      otherStore,
      generation,
      0,
      'wrong owner',
      DISPATCH_OWNER_B,
      firstLease
    ),
    ConflictError
  );

  assert.throws(
    () => appendLeasedDelta(
      state.store,
      generation,
      0,
      'dispatch was not marked started',
      DISPATCH_OWNER_A,
      firstLease
    ),
    ConflictError
  );
  milliseconds += 1_000;
  const secondLease = otherStore.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    ttlMs: 2_000
  });
  assert.equal(secondLease.fence, firstLease.fence + 1);
  const dispatchMarker = otherStore.markGenerationDispatchStarted({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    fence: secondLease.fence
  });
  assert.equal(dispatchMarker.dispatchAuthorized, true);
  assert.equal(
    otherStore.markGenerationDispatchStarted({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      fence: secondLease.fence
    }).dispatchAuthorized,
    false
  );
  assert.throws(
    () => state.store.appendGenerationDelta({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      expectedSequence: 0,
      expectedHash: null,
      content: 'fenced owner A output',
      dispatchLease: dispatchProof(DISPATCH_OWNER_A, firstLease)
    }),
    ConflictError
  );
  assert.throws(
    () => state.store.finalizeGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      idempotencyKey: 'finalize-fenced-owner-a-0001',
      dispatchLease: dispatchProof(DISPATCH_OWNER_A, firstLease)
    }),
    ConflictError
  );
  assert.throws(
    () => otherStore.finalizeGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      idempotencyKey: 'finalize-missing-lease-overlap-0001'
    }),
    ConflictError
  );
  assert.throws(
    () => state.store.failGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      failureCode: 'provider_unavailable',
      idempotencyKey: 'fail-fenced-owner-a-0001',
      dispatchLease: dispatchProof(DISPATCH_OWNER_A, firstLease)
    }),
    ConflictError
  );
  appendLeasedDelta(
    otherStore,
    generation,
    0,
    'owner B output',
    DISPATCH_OWNER_B,
    secondLease
  );
  const completed = otherStore.finalizeGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    idempotencyKey: 'finalize-owner-b-lease-overlap-0001',
    dispatchLease: dispatchProof(DISPATCH_OWNER_B, secondLease)
  });
  assert.equal(completed.status, 'completed');
  assert.equal(
    otherStore.getThread(thread.accountId, thread.threadId).currentGenerationId,
    null
  );
  assert.equal(
    otherStore.releaseGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      fence: secondLease.fence
    }).active,
    false
  );
  otherStore.close();
});

test('admits only one marked inference globally and safely reconciles an expired dispatcher', (t) => {
  let milliseconds = Date.parse('2026-08-20T00:30:00.000Z');
  const clock = () => new Date(milliseconds);
  const { store } = testState(t, { clock });
  const firstThread = createThread(store, 'global-lease-first');
  const secondThread = createThread(store, 'global-lease-second');
  const firstGeneration = startTurn(store, firstThread, 'global-lease-first').generation;
  const secondGeneration = startTurn(store, secondThread, 'global-lease-second').generation;

  const firstLease = store.claimGenerationLease({
    accountId: firstThread.accountId,
    threadId: firstThread.threadId,
    generationId: firstGeneration.generationId,
    ownerToken: DISPATCH_OWNER_A,
    ttlMs: 1_000
  });
  assert.equal(
    store.markGenerationDispatchStarted({
      accountId: firstThread.accountId,
      threadId: firstThread.threadId,
      generationId: firstGeneration.generationId,
      ownerToken: DISPATCH_OWNER_A,
      fence: firstLease.fence
    }).dispatchAuthorized,
    true
  );

  const blockedLease = store.claimGenerationLease({
    accountId: secondThread.accountId,
    threadId: secondThread.threadId,
    generationId: secondGeneration.generationId,
    ownerToken: DISPATCH_OWNER_B,
    ttlMs: 2_000
  });
  assert.deepEqual(
    store.markGenerationDispatchStarted({
      accountId: secondThread.accountId,
      threadId: secondThread.threadId,
      generationId: secondGeneration.generationId,
      ownerToken: DISPATCH_OWNER_B,
      fence: blockedLease.fence
    }).dispatchState,
    'global_busy'
  );

  milliseconds += 1_001;
  assert.equal(
    store.markGenerationDispatchStarted({
      accountId: secondThread.accountId,
      threadId: secondThread.threadId,
      generationId: secondGeneration.generationId,
      ownerToken: DISPATCH_OWNER_B,
      fence: blockedLease.fence
    }).dispatchAuthorized,
    true
  );
  assert.equal(
    store.getGenerationLease({
      accountId: firstThread.accountId,
      threadId: firstThread.threadId,
      generationId: firstGeneration.generationId
    }).phase,
    'interrupted'
  );
});

test('renews and releases a lease durably while preserving its monotonic fence', (t) => {
  let milliseconds = Date.parse('2026-08-20T01:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const { databasePath, store } = testState(t, { clock });
  const thread = createThread(store, 'lease-renew');
  const { generation } = startTurn(store, thread, 'lease-renew');
  const firstLease = store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    ttlMs: 1_000
  });

  milliseconds += 750;
  const renewed = store.renewGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    fence: firstLease.fence,
    ttlMs: 1_000
  });
  assert.equal(renewed.fence, firstLease.fence);
  assert.ok(renewed.expiresAt > firstLease.expiresAt);
  assert.deepEqual(
    store.renewGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      fence: firstLease.fence,
      ttlMs: 1_000
    }),
    renewed
  );
  milliseconds += 400;

  const released = store.releaseGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    fence: renewed.fence
  });
  assert.equal(released.active, false);
  assert.equal(released.releasedAt, released.expiresAt);
  assert.deepEqual(
    store.releaseGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      fence: renewed.fence
    }),
    released
  );
  assert.throws(
    () => appendDelta(store, generation, 0, 'legacy after release'),
    ConflictError
  );
  const replacement = store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    ttlMs: 1_000
  });
  assert.equal(replacement.fence, released.fence + 1);
  assert.equal(
    store.markGenerationDispatchStarted({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      fence: replacement.fence
    }).dispatchAuthorized,
    true
  );
  appendLeasedDelta(store, generation, 0, 'replacement output', DISPATCH_OWNER_B, replacement);
  assert.throws(
    () => store.releaseGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      fence: released.fence
    }),
    ConflictError
  );

  const database = new DatabaseSync(databasePath);
  try {
    assert.throws(
      () => database.prepare(`
        UPDATE direct_chat_generation_leases SET fence = fence - 1
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
      `).run(thread.accountId, thread.threadId, generation.generationId),
      /monotonically/u
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM direct_chat_generation_leases
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
      `).run(thread.accountId, thread.threadId, generation.generationId),
      /durable/u
    );
  } finally {
    database.close();
  }
  const failRequest = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    failureCode: 'provider_unavailable',
    idempotencyKey: 'fail-replacement-lease-renew-0001',
    dispatchLease: dispatchProof(DISPATCH_OWNER_B, replacement)
  };
  const failed = store.failGeneration(failRequest);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(store.failGeneration(failRequest), failed);
  assert.equal(store.getThread(thread.accountId, thread.threadId).currentGenerationId, null);
});

test('browser cancellation invalidates a dispatcher lease without requiring its secret', (t) => {
  const { databasePath, store } = testState(t);
  const thread = createThread(store, 'lease-cancel');
  const { generation } = startTurn(store, thread, 'lease-cancel');
  const lease = store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    ttlMs: 30_000
  });
  assert.equal(
    store.markGenerationDispatchStarted({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      fence: lease.fence
    }).dispatchAuthorized,
    true
  );
  appendLeasedDelta(store, generation, 0, 'partial', DISPATCH_OWNER_A, lease);
  const cancelled = store.cancelGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    idempotencyKey: 'cancel-leased-generation-0001'
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.notEqual(
    scalar(
      databasePath,
      `SELECT released_at AS value FROM direct_chat_generation_leases
       WHERE account_id = ? AND thread_id = ? AND generation_id = ?`,
      thread.accountId,
      thread.threadId,
      generation.generationId
    ),
    null
  );
  assert.throws(
    () => appendLeasedDelta(store, generation, 1, 'late output', DISPATCH_OWNER_A, lease),
    ConflictError
  );
  assert.throws(
    () => store.failGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      failureCode: 'internal_error',
      idempotencyKey: 'fail-after-browser-cancel-0001',
      dispatchLease: dispatchProof(DISPATCH_OWNER_A, lease)
    }),
    ConflictError
  );
  assert.throws(
    () => store.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      ttlMs: 1_000
    }),
    ConflictError
  );
});

test('recovers the same live lease after restart and fences it after durable expiry', (t) => {
  let milliseconds = Date.parse('2026-08-20T02:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const state = testState(t, { clock });
  const thread = createThread(state.store, 'lease-restart');
  const { generation } = startTurn(state.store, thread, 'lease-restart');
  const claimed = state.store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    ttlMs: 1_000
  });
  assert.notEqual(
    scalar(
      state.databasePath,
      `SELECT owner_hash AS value FROM direct_chat_generation_leases
       WHERE account_id = ? AND thread_id = ? AND generation_id = ?`,
      thread.accountId,
      thread.threadId,
      generation.generationId
    ),
    DISPATCH_OWNER_A
  );
  state.store.close();
  const reopened = new DirectChatStore({ databasePath: state.databasePath, clock });
  state.replaceStore(reopened);
  assert.deepEqual(
    reopened.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      ttlMs: 1_000
    }),
    claimed
  );
  assert.throws(
    () => reopened.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      ttlMs: 1_000
    }),
    ConflictError
  );
  milliseconds += 1_000;
  const fenced = reopened.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    ttlMs: 1_000
  });
  assert.equal(fenced.fence, claimed.fence + 1);
});

test('never reclaims inference after dispatch may have started, even with zero persisted deltas', (t) => {
  let milliseconds = Date.parse('2026-08-20T03:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const { store } = testState(t, { clock });
  let thread = createThread(store, 'lease-ambiguous');
  const { generation } = startTurn(store, thread, 'lease-ambiguous');
  const lease = store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    ttlMs: 1_000
  });
  const marker = store.markGenerationDispatchStarted({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    ownerToken: DISPATCH_OWNER_A,
    fence: lease.fence
  });
  assert.equal(marker.dispatchAuthorized, true);
  assert.equal(marker.phase, 'dispatch_started');
  assert.equal(
    store.markGenerationDispatchStarted({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      fence: lease.fence
    }).dispatchAuthorized,
    false
  );
  assert.throws(
    () => store.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      ttlMs: 1_000
    }),
    /already marked started/u
  );
  assert.equal(
    store.getGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId
    }).deltaCount,
    0
  );

  milliseconds += 1_000;
  assert.throws(
    () => store.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      ttlMs: 1_000
    }),
    /ambiguous interrupted dispatch|may already have run/u
  );
  const interrupted = store.getGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId
  });
  assert.equal(interrupted.phase, 'interrupted');
  assert.equal(interrupted.dispatchAmbiguous, true);
  assert.equal(interrupted.active, false);
  assert.equal(interrupted.fence, lease.fence + 1);
  assert.throws(
    () => store.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId,
      ownerToken: DISPATCH_OWNER_B,
      ttlMs: 1_000
    }),
    /ambiguous interrupted dispatch/u
  );
  assert.throws(
    () => appendLeasedDelta(store, generation, 0, 'must not resume', DISPATCH_OWNER_A, lease),
    ConflictError
  );

  const cancelled = store.cancelGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    idempotencyKey: 'cancel-ambiguous-generation-0001'
  });
  assert.equal(cancelled.status, 'cancelled');
  thread = store.getThread(thread.accountId, thread.threadId);
  const retry = startTurn(store, thread, 'lease-ambiguous-retry');
  assert.equal(retry.generation.status, 'in_progress');
  assert.notEqual(retry.generation.generationId, generation.generationId);
  const retryLease = store.claimGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: retry.generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    ttlMs: 1_000
  });
  store.markGenerationDispatchStarted({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: retry.generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    fence: retryLease.fence
  });
  const explicitlyInterrupted = store.releaseGenerationLease({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: retry.generation.generationId,
    ownerToken: DISPATCH_OWNER_B,
    fence: retryLease.fence
  });
  assert.equal(explicitlyInterrupted.phase, 'interrupted');
  assert.equal(explicitlyInterrupted.dispatchAmbiguous, true);
  assert.throws(
    () => store.claimGenerationLease({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: retry.generation.generationId,
      ownerToken: DISPATCH_OWNER_A,
      ttlMs: 1_000
    }),
    /ambiguous interrupted dispatch/u
  );
});

test('migrates an exact version-one chat database to fenced dispatch leases', (t) => {
  const state = testState(t);
  state.store.close();
  let database = new DatabaseSync(state.databasePath);
  database.exec(`
    DROP TABLE direct_chat_generation_leases;
    DELETE FROM chat_schema_migrations WHERE version = 2;
    PRAGMA user_version = 1;
  `);
  database.close();

  const migrated = new DirectChatStore({ databasePath: state.databasePath });
  state.replaceStore(migrated);
  assert.equal(
    Number(scalar(state.databasePath, 'SELECT user_version AS value FROM pragma_user_version')),
    DEFAULT_CHAT_SCHEMA_VERSION
  );
  assert.equal(
    Number(scalar(
      state.databasePath,
      `SELECT count(*) AS value FROM sqlite_schema
       WHERE type = 'table' AND name = 'direct_chat_generation_leases'`
    )),
    1
  );
  assert.equal(
    Number(scalar(state.databasePath, 'SELECT count(*) AS value FROM chat_schema_migrations')),
    2
  );
});

test('validates dispatch owner and TTL bounds before creating a lease', (t) => {
  const { databasePath, store } = testState(t);
  const thread = createThread(store, 'lease-bounds');
  const { generation } = startTurn(store, thread, 'lease-bounds');
  const base = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId
  };
  assert.throws(
    () => store.claimGenerationLease({ ...base, ownerToken: 'short', ttlMs: 1_000 }),
    ValidationError
  );
  assert.throws(
    () => store.claimGenerationLease({
      ...base,
      ownerToken: DISPATCH_OWNER_A,
      ttlMs: DIRECT_CHAT_DISPATCH_LEASE_LIMITS.minimumTtlMs - 1
    }),
    ValidationError
  );
  assert.throws(
    () => store.claimGenerationLease({
      ...base,
      ownerToken: DISPATCH_OWNER_A,
      ttlMs: DIRECT_CHAT_DISPATCH_LEASE_LIMITS.maximumTtlMs + 1
    }),
    ValidationError
  );
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT count(*) AS value FROM direct_chat_generation_leases
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    0
  );
});

test('idempotency rejects key reuse with changed data and natural IDs prevent post-expiry duplicates', (t) => {
  const { store } = testState(t);
  const thread = createThread(store, 'idem');
  const request = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: 'user-idem',
    content: 'same',
    expectedRevision: 0,
    expectedHash: null,
    idempotencyKey: 'send-user-idem-0001'
  };
  const first = store.sendUserMessage(request);
  assert.deepEqual(store.sendUserMessage(request), first);
  assert.throws(
    () => store.sendUserMessage({ ...request, content: 'changed' }),
    IdempotencyConflictError
  );
  assert.throws(
    () => store.sendUserMessage({
      ...request,
      messageId: 'different-message',
      idempotencyKey: 'send-user-idem-other-0001'
    }),
    ConflictError
  );
});

test('records explicit cancelled and failed terminal generations without fake assistant messages', (t) => {
  const { store } = testState(t);
  const thread = createThread(store, 'terminal');
  const user = sendUser(store, thread, 'terminal');
  const cancelledGeneration = startGeneration(store, user, 'cancelled');
  appendDelta(store, cancelledGeneration, 0, 'partial');
  const cancelRequest = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: cancelledGeneration.generationId,
    idempotencyKey: 'cancel-generation-terminal-0001'
  };
  const cancelled = store.cancelGeneration(cancelRequest);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.terminal, true);
  assert.equal(cancelled.finalRevision, null);
  assert.deepEqual(store.cancelGeneration(cancelRequest), cancelled);
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.deepEqual(
    store.replayGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: cancelledGeneration.generationId
    }).deltas.map((delta) => delta.content),
    ['partial']
  );

  const failedGeneration = startGeneration(store, user, 'failed', {
    assistantMessageId: 'assistant-failed'
  });
  const failed = store.failGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: failedGeneration.generationId,
    failureCode: 'provider_unavailable',
    idempotencyKey: 'fail-generation-terminal-0001'
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'provider_unavailable');
  assert.equal(failed.terminal, true);
  assert.throws(
    () => store.failGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: failedGeneration.generationId,
      failureCode: '/private/provider/error',
      idempotencyKey: 'fail-generation-invalid-0001'
    }),
    ValidationError
  );
});

test('compaction snapshots bind an exact immutable hash range and preserve the raw ledger', (t) => {
  const { databasePath, store } = testState(t);
  const thread = createThread(store, 'compact');
  const user = sendUser(store, thread, 'compact');
  const generation = startGeneration(store, user, 'compact');
  appendDelta(store, generation, 0, 'An answer.');
  store.finalizeGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: generation.generationId,
    idempotencyKey: 'finalize-compact-0001'
  });
  const messagesBefore = store.listMessages({ accountId: thread.accountId, threadId: thread.threadId });
  const request = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    snapshotId: 'snapshot-compact-1',
    sourceStartRevision: 1,
    sourceStartHash: messagesBefore[0].messageHash,
    sourceEndRevision: 2,
    sourceEndHash: messagesBefore[1].messageHash,
    summaryText: 'Untrusted compact summary of the two raw turns.',
    idempotencyKey: 'create-compaction-compact-0001'
  };
  const snapshot = store.createCompactionSnapshot(request);
  assert.equal(snapshot.untrustedDirectChatData, true);
  assert.equal(snapshot.summaryHash, sha256(snapshot.summaryText));
  assert.deepEqual(store.createCompactionSnapshot(request), snapshot);
  assert.deepEqual(
    store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }),
    messagesBefore
  );
  assert.deepEqual(store.getLatestCompactionSnapshot(thread.accountId, thread.threadId), snapshot);

  assert.throws(
    () => store.createCompactionSnapshot({
      ...request,
      snapshotId: 'snapshot-compact-bad',
      sourceEndHash: 'f'.repeat(64),
      idempotencyKey: 'create-compaction-compact-bad-0001'
    }),
    ConflictError
  );
  const database = new DatabaseSync(databasePath);
  try {
    assert.throws(
      () => database.prepare(`
        UPDATE direct_chat_compactions SET summary_text = 'changed'
        WHERE account_id = ? AND thread_id = ? AND snapshot_id = ?
      `).run(thread.accountId, thread.threadId, snapshot.snapshotId),
      /immutable/u
    );
  } finally {
    database.close();
  }
});

test('enforces byte and thread bounds before persistence', (t) => {
  const { store } = testState(t);
  const thread = createThread(store, 'bounds');
  assert.throws(
    () => sendUser(store, thread, 'too-large', { content: 'x'.repeat(DIRECT_CHAT_LIMITS.messageBytes + 1) }),
    ValidationError
  );
  const user = sendUser(store, thread, 'bounds');
  const generation = startGeneration(store, user, 'bounds');
  assert.throws(
    () => appendDelta(store, generation, 0, 'x'.repeat(DIRECT_CHAT_LIMITS.deltaBytes + 1)),
    ValidationError
  );

  for (let index = 0; index < DIRECT_CHAT_LIMITS.threadsPerAccount; index += 1) {
    store.createThread({
      accountId: 'account-thread-cap',
      threadId: `thread-cap-${index}`,
      idempotencyKey: `create-thread-cap-${String(index).padStart(4, '0')}`
    });
  }
  assert.throws(
    () => store.createThread({
      accountId: 'account-thread-cap',
      threadId: 'thread-cap-overflow',
      idempotencyKey: 'create-thread-cap-overflow-0001'
    }),
    ConflictError
  );
});

test('bounded cleanup removes only expired receipts and preserves an active generation and raw data', (t) => {
  let milliseconds = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const { store } = testState(t, { clock });
  const thread = createThread(store, 'cleanup');
  const user = sendUser(store, thread, 'cleanup');
  const generation = startGeneration(store, user, 'cleanup');
  appendDelta(store, generation, 0, 'still active');
  milliseconds += DIRECT_CHAT_IDEMPOTENCY_TTL_MS + 1;

  const cleanup = store.cleanupExpiredIdempotency({ limit: 2 });
  assert.equal(cleanup.idempotencyReceiptsRemoved, 2);
  assert.equal(cleanup.chatRowsRemoved, 0);
  assert.equal(store.getThread(thread.accountId, thread.threadId).currentGenerationId, generation.generationId);
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 1);
  assert.deepEqual(
    store.replayGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: generation.generationId
    }).deltas.map((delta) => delta.content),
    ['still active']
  );
});

test('bounded maintenance prunes only superseded completed deltas and snapshots, then permits continued chat', (t) => {
  let milliseconds = Date.parse('2026-08-20T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const { databasePath, store } = testState(t, { clock });
  let thread = createThread(store, 'maintenance');
  let user = sendUser(store, thread, 'maintenance-one');
  const firstGeneration = startGeneration(store, user, 'maintenance-one');
  appendDelta(store, firstGeneration, 0, 'first retained output');
  const firstFinalizeRequest = {
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: firstGeneration.generationId,
    idempotencyKey: 'finalize-maintenance-one-0001'
  };
  store.finalizeGeneration(firstFinalizeRequest);
  let messages = store.listMessages({ accountId: thread.accountId, threadId: thread.threadId });
  store.createCompactionSnapshot({
    accountId: thread.accountId,
    threadId: thread.threadId,
    snapshotId: 'snapshot-00',
    sourceStartRevision: 1,
    sourceStartHash: messages[0].messageHash,
    sourceEndRevision: 2,
    sourceEndHash: messages[1].messageHash,
    summaryText: 'First immutable summary.',
    idempotencyKey: 'snapshot-maintenance-00-0001'
  });

  milliseconds += 25 * 60 * 60 * 1000;
  thread = store.getThread(thread.accountId, thread.threadId);
  user = sendUser(store, thread, 'maintenance-two');
  const secondGeneration = startGeneration(store, user, 'maintenance-two');
  appendDelta(store, secondGeneration, 0, 'newest retained output');
  store.finalizeGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: secondGeneration.generationId,
    idempotencyKey: 'finalize-maintenance-two-0001'
  });
  messages = store.listMessages({ accountId: thread.accountId, threadId: thread.threadId });
  for (let index = 1; index < DIRECT_CHAT_LIMITS.compactionsPerThread; index += 1) {
    const suffix = String(index).padStart(2, '0');
    store.createCompactionSnapshot({
      accountId: thread.accountId,
      threadId: thread.threadId,
      snapshotId: `snapshot-${suffix}`,
      sourceStartRevision: 1,
      sourceStartHash: messages[0].messageHash,
      sourceEndRevision: 4,
      sourceEndHash: messages[3].messageHash,
      summaryText: `Superseding summary ${suffix}.`,
      idempotencyKey: `snapshot-maintenance-${suffix}-0001`
    });
  }
  assert.throws(
    () => store.createCompactionSnapshot({
      accountId: thread.accountId,
      threadId: thread.threadId,
      snapshotId: 'snapshot-before-maintenance-overflow',
      sourceStartRevision: 1,
      sourceStartHash: messages[0].messageHash,
      sourceEndRevision: 4,
      sourceEndHash: messages[3].messageHash,
      summaryText: 'Must wait for bounded maintenance.',
      idempotencyKey: 'snapshot-maintenance-overflow-0001'
    }),
    ConflictError
  );

  const beforeJournalBytes = Number(scalar(
    databasePath,
    `SELECT journal_bytes AS value FROM direct_chat_threads
     WHERE account_id = ? AND thread_id = ?`,
    thread.accountId,
    thread.threadId
  ));
  const maintenance = store.runMaintenance({ accountId: thread.accountId, limit: 256 });
  assert.equal(maintenance.terminalGenerationsPruned, 1);
  assert.equal(maintenance.deltaRowsRemoved, 1);
  assert.equal(maintenance.deltaBytesReleased, Buffer.byteLength('first retained output'));
  assert.equal(maintenance.compactionSnapshotsRemoved, DIRECT_CHAT_LIMITS.compactionsPerThread - 1);
  assert.equal(maintenance.chatMessagesRemoved, 0);
  assert.equal(maintenance.activeGenerationsRemoved, 0);
  assert.equal(
    Number(scalar(
      databasePath,
      `SELECT journal_bytes AS value FROM direct_chat_threads
       WHERE account_id = ? AND thread_id = ?`,
      thread.accountId,
      thread.threadId
    )),
    beforeJournalBytes - Buffer.byteLength('first retained output')
  );

  const firstReplay = store.replayGeneration({
    accountId: thread.accountId,
    threadId: thread.threadId,
    generationId: firstGeneration.generationId
  });
  assert.equal(firstReplay.generation.deltasPruned, true);
  assert.deepEqual(firstReplay.deltas, []);
  assert.equal(store.finalizeGeneration(firstFinalizeRequest).deltasPruned, true);
  assert.equal(
    store.replayGeneration({
      accountId: thread.accountId,
      threadId: thread.threadId,
      generationId: secondGeneration.generationId
    }).deltas.length,
    1
  );
  assert.equal(store.listMessages({ accountId: thread.accountId, threadId: thread.threadId }).length, 4);
  assert.equal(store.getLatestCompactionSnapshot(thread.accountId, thread.threadId).snapshotId, 'snapshot-31');

  // The latest completed delivery journal and current compaction remain protected.
  const database = new DatabaseSync(databasePath);
  try {
    assert.throws(
      () => database.prepare(`
        DELETE FROM direct_chat_deltas
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
      `).run(thread.accountId, thread.threadId, secondGeneration.generationId),
      /safely retained/u
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM direct_chat_compactions
        WHERE account_id = ? AND thread_id = ? AND snapshot_id = 'snapshot-31'
      `).run(thread.accountId, thread.threadId),
      /current/u
    );
  } finally {
    database.close();
  }

  store.createCompactionSnapshot({
    accountId: thread.accountId,
    threadId: thread.threadId,
    snapshotId: 'snapshot-zz',
    sourceStartRevision: 1,
    sourceStartHash: messages[0].messageHash,
    sourceEndRevision: 4,
    sourceEndHash: messages[3].messageHash,
    summaryText: 'A new snapshot after safe pruning.',
    idempotencyKey: 'snapshot-maintenance-zz-0001'
  });
  thread = store.getThread(thread.accountId, thread.threadId);
  user = sendUser(store, thread, 'maintenance-three');
  const continuingGeneration = startGeneration(store, user, 'maintenance-three');
  assert.equal(appendDelta(store, continuingGeneration, 0, 'continued').sequence, 1);
});

test('rejects link attacks, future schemas, migration tampering, schema-object tampering, and ledger corruption', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lazying-direct-chat-security-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const linkState = join(root, 'links');
  mkdirSync(linkState, { mode: 0o700 });
  const target = join(root, 'target.sqlite');
  const descriptor = openSync(target, 'wx', 0o600);
  closeSync(descriptor);
  symlinkSync(target, join(linkState, 'symbolic.sqlite'));
  assert.throws(
    () => new DirectChatStore({ databasePath: join(linkState, 'symbolic.sqlite') }),
    StorageSecurityError
  );
  linkSync(target, join(linkState, 'hard.sqlite'));
  assert.throws(
    () => new DirectChatStore({ databasePath: join(linkState, 'hard.sqlite') }),
    StorageSecurityError
  );
  chmodSync(linkState, 0o750);
  assert.throws(
    () => new DirectChatStore({ databasePath: join(linkState, 'new.sqlite') }),
    StorageSecurityError
  );

  function makeDatabase(name) {
    const path = join(root, name, 'chat.sqlite');
    const store = new DirectChatStore({ databasePath: path });
    store.close();
    return path;
  }

  const futurePath = makeDatabase('future');
  let database = new DatabaseSync(futurePath);
  database.exec('PRAGMA user_version = 999');
  database.close();
  assert.throws(() => new DirectChatStore({ databasePath: futurePath }), UnsupportedSchemaError);

  const migrationPath = makeDatabase('migration');
  database = new DatabaseSync(migrationPath);
  database.prepare(`UPDATE chat_schema_migrations SET checksum = ? WHERE version = 1`).run('0'.repeat(64));
  database.close();
  assert.throws(() => new DirectChatStore({ databasePath: migrationPath }), StorageCorruptionError);

  const schemaPath = makeDatabase('schema');
  database = new DatabaseSync(schemaPath);
  database.exec('DROP INDEX direct_chat_threads_owner_updated');
  database.close();
  assert.throws(() => new DirectChatStore({ databasePath: schemaPath }), StorageCorruptionError);

  const corruptPath = join(root, 'corrupt', 'chat.sqlite');
  let corruptStore = new DirectChatStore({ databasePath: corruptPath });
  const corruptThread = createThread(corruptStore, 'corrupt');
  sendUser(corruptStore, corruptThread, 'corrupt');
  corruptStore.close();
  database = new DatabaseSync(corruptPath);
  database.prepare(`
    UPDATE direct_chat_threads SET ledger_hash = ?
    WHERE account_id = ? AND thread_id = ?
  `).run('f'.repeat(64), corruptThread.accountId, corruptThread.threadId);
  database.close();
  assert.throws(() => new DirectChatStore({ databasePath: corruptPath }), StorageCorruptionError);

  const summaryPath = join(root, 'summary-corrupt', 'chat.sqlite');
  let summaryStore = new DirectChatStore({ databasePath: summaryPath });
  const summaryThread = createThread(summaryStore, 'summary-corrupt');
  const summaryUser = sendUser(summaryStore, summaryThread, 'summary-corrupt');
  const summaryGeneration = startGeneration(summaryStore, summaryUser, 'summary-corrupt');
  appendDelta(summaryStore, summaryGeneration, 0, 'summary source');
  summaryStore.finalizeGeneration({
    accountId: summaryThread.accountId,
    threadId: summaryThread.threadId,
    generationId: summaryGeneration.generationId,
    idempotencyKey: 'finalize-summary-corrupt-0001'
  });
  const summaryMessages = summaryStore.listMessages({
    accountId: summaryThread.accountId,
    threadId: summaryThread.threadId
  });
  summaryStore.createCompactionSnapshot({
    accountId: summaryThread.accountId,
    threadId: summaryThread.threadId,
    snapshotId: 'snapshot-summary-corrupt',
    sourceStartRevision: 1,
    sourceStartHash: summaryMessages[0].messageHash,
    sourceEndRevision: 2,
    sourceEndHash: summaryMessages[1].messageHash,
    summaryText: 'hash-bound summary',
    idempotencyKey: 'snapshot-summary-corrupt-0001'
  });
  summaryStore.close();
  database = new DatabaseSync(summaryPath);
  const triggerSql = database.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'direct_chat_compactions_no_update'
  `).get().sql;
  database.exec('DROP TRIGGER direct_chat_compactions_no_update');
  database.prepare(`
    UPDATE direct_chat_compactions SET summary_hash = ?
    WHERE snapshot_id = 'snapshot-summary-corrupt'
  `).run('f'.repeat(64));
  database.exec(triggerSql);
  database.close();
  assert.throws(() => new DirectChatStore({ databasePath: summaryPath }), StorageCorruptionError);
});
