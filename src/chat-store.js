import { DatabaseSync } from 'node:sqlite';

import {
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  StorageCorruptionError,
  ValidationError
} from './errors.js';
import {
  CHAT_SQLITE_APPLICATION_ID,
  DEFAULT_CHAT_SCHEMA_VERSION,
  LATEST_CHAT_SCHEMA_VERSION,
  applyChatMigrations
} from './chat-migrations.js';
import { checkOpenSqliteHealth } from './sqlite-health.js';
import {
  assertSecureDatabaseFile,
  prepareSecureDatabasePath,
  requireSecureExistingDatabasePath
} from './storage-path.js';
import {
  assertCanonicalIsoTimestamp,
  assertEventHash,
  assertExactKeys,
  assertIdentifier,
  assertIdempotencyKey,
  assertInteger,
  canonicalJson,
  nowIso,
  sha256
} from './validation.js';
import {
  VISION_ATTACHMENT_LIMITS,
  VISION_MODEL_ALIAS,
  validateStoredVisionAttachment,
  visionAttachmentDescriptor
} from './vision-attachment.js';

const DEFAULT_CLOCK = () => new Date();
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DISPATCH_LEASE_OWNER_PATTERN = /^[A-Za-z0-9._~:-]{32,256}$/u;
const MAX_DISPATCH_LEASE_FENCE = Number.MAX_SAFE_INTEGER;
const FAILURE_CODES = new Set([
  'provider_unavailable',
  'timeout',
  'internal_error',
  'response_limit',
  'content_rejected'
]);
const PRE_DISPATCH_FAILURE_CODES = new Set(['provider_unavailable', 'timeout']);
const DATABASE_METADATA = new WeakMap();
const MAX_AUDITED_THREAD_CACHE_ENTRIES = 256;

export const DIRECT_CHAT_LIMITS = Object.freeze({
  threadsPerAccount: 100,
  messagesPerThread: 2_000,
  ledgerBytesPerThread: 8 * 1024 * 1024,
  messageBytes: 64 * 1024,
  generationsPerThread: 1_024,
  deltasPerGeneration: 8_192,
  deltasPerThread: 32_768,
  deltaBytes: 16 * 1024,
  generationBytes: 64 * 1024,
  journalBytesPerThread: 16 * 1024 * 1024,
  compactionsPerThread: 32,
  summaryBytes: 256 * 1024,
  listPage: 200,
  idempotencyReceiptsPerAccount: 1_024,
  threadDeletionReceiptsPerAccount: 100_000,
  cleanupRows: 256
});

export const DIRECT_CHAT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DIRECT_CHAT_TERMINAL_DELTA_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DIRECT_CHAT_DISPATCH_LEASE_LIMITS = Object.freeze({
  minimumTtlMs: 1_000,
  maximumTtlMs: 5 * 60 * 1_000,
  maximumFence: MAX_DISPATCH_LEASE_FENCE
});

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function assertUnicodeScalarString(value, name, { minBytes = 1, maxBytes }) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ValidationError(`${name} must not contain unpaired UTF-16 surrogates.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ValidationError(`${name} must not contain unpaired UTF-16 surrogates.`);
    }
  }
  if (/\u0000/u.test(value)) throw new ValidationError(`${name} must not contain NUL bytes.`);
  const bytes = utf8Bytes(value);
  if (bytes < minBytes || bytes > maxBytes) {
    throw new ValidationError(`${name} must contain between ${minBytes} and ${maxBytes} UTF-8 bytes.`);
  }
  return { value, bytes };
}

function assertModelAlias(value) {
  if (typeof value !== 'string' || !MODEL_ALIAS_PATTERN.test(value)) {
    throw new ValidationError('modelAlias must be a server-selected portable alias, not a provider URL or path.');
  }
  return value;
}

function assertFailureCode(value) {
  if (typeof value !== 'string' || !FAILURE_CODES.has(value)) {
    throw new ValidationError('failureCode is not an approved server-side failure category.');
  }
  return value;
}

function assertDispatchLeaseOwnerToken(value) {
  if (typeof value !== 'string' || !DISPATCH_LEASE_OWNER_PATTERN.test(value)) {
    throw new ValidationError(
      'ownerToken must be a 32-256 character opaque restricted-ASCII dispatch identity.'
    );
  }
  return value;
}

function assertDispatchLeaseTtl(value) {
  return assertInteger(value, 'ttlMs', {
    min: DIRECT_CHAT_DISPATCH_LEASE_LIMITS.minimumTtlMs,
    max: DIRECT_CHAT_DISPATCH_LEASE_LIMITS.maximumTtlMs
  });
}

function assertDispatchLeaseProof(value) {
  if (value === undefined) return null;
  assertExactKeys(
    value,
    { required: ['ownerToken', 'fence'] },
    'direct chat generation dispatch lease proof'
  );
  const ownerToken = assertDispatchLeaseOwnerToken(value.ownerToken);
  return Object.freeze({
    ownerHash: sha256(ownerToken),
    fence: assertInteger(value.fence, 'dispatchLease.fence', {
      min: 1,
      max: MAX_DISPATCH_LEASE_FENCE
    })
  });
}

function addMilliseconds(timestamp, milliseconds) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('ERR_SQLITE_CONSTRAINT');
}

function threadView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    title: row.title,
    modelAlias: row.model_alias,
    revision: Number(row.ledger_revision),
    ledgerHash: row.ledger_hash,
    messageCount: Number(row.message_count),
    ledgerBytes: Number(row.ledger_bytes),
    currentGenerationId: row.current_generation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function attachmentViewFields(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return {};
  const descriptors = Object.freeze(attachments.map(visionAttachmentDescriptor));
  // Preserve the v3 one-image ledger/API representation so existing rows,
  // idempotency receipts, and the immediately previous PWA remain valid.
  return descriptors.length === 1
    ? { attachment: descriptors[0] }
    : { attachments: descriptors };
}

function messageView(row, attachments = []) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    revision: Number(row.revision),
    role: row.role,
    content: row.content,
    contentBytes: Number(row.content_bytes),
    previousHash: row.previous_hash,
    messageHash: row.message_hash,
    generationId: row.generation_id,
    createdAt: row.created_at,
    ...attachmentViewFields(attachments)
  };
}

function attachmentFromRow(row) {
  if (!row) return null;
  let checked;
  try {
    checked = validateStoredVisionAttachment({
      accountId: row.account_id,
      threadId: row.thread_id,
      attachmentId: row.attachment_id,
      messageId: row.message_id,
      position: Number(row.position),
      mediaType: row.media_type,
      byteLength: Number(row.byte_length),
      width: Number(row.width),
      height: Number(row.height),
      contentSha256: row.content_sha256,
      content: row.content,
      createdAt: row.created_at
    });
  } catch (error) {
    throw new StorageCorruptionError('A stored direct-chat vision attachment is invalid.', { cause: error });
  }
  assertStoredIdentifier(checked.accountId, 'attachment.accountId');
  assertStoredIdentifier(checked.threadId, 'attachment.threadId');
  assertStoredIdentifier(checked.messageId, 'attachment.messageId');
  assertStoredTimestamp(checked.createdAt, 'attachment.createdAt');
  if (!Number.isSafeInteger(checked.position) || checked.position < 0
      || checked.position >= VISION_ATTACHMENT_LIMITS.attachmentsPerMessage) {
    throw new StorageCorruptionError('A stored direct-chat vision attachment position is invalid.');
  }
  return checked;
}

function attachmentDescriptorFromRow(row) {
  if (!row) return null;
  try {
    assertStoredIdentifier(row.account_id, 'attachment.accountId');
    assertStoredIdentifier(row.thread_id, 'attachment.threadId');
    assertStoredIdentifier(row.attachment_id, 'attachment.attachmentId');
    assertStoredIdentifier(row.message_id, 'attachment.messageId');
    assertStoredTimestamp(row.created_at, 'attachment.createdAt');
  } catch (error) {
    if (error instanceof StorageCorruptionError) throw error;
    throw new StorageCorruptionError('A stored direct-chat attachment descriptor is invalid.', { cause: error });
  }
  const byteLength = Number(row.byte_length);
  const width = Number(row.width);
  const height = Number(row.height);
  const position = Number(row.position);
  if (!['image/jpeg', 'image/png'].includes(row.media_type)
      || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > VISION_ATTACHMENT_LIMITS.bytes
      || !Number.isSafeInteger(width) || width < 1 || width > VISION_ATTACHMENT_LIMITS.maximumEdge
      || !Number.isSafeInteger(height) || height < 1 || height > VISION_ATTACHMENT_LIMITS.maximumEdge
      || width * height > VISION_ATTACHMENT_LIMITS.pixels
      || !Number.isSafeInteger(position) || position < 0
      || position >= VISION_ATTACHMENT_LIMITS.attachmentsPerMessage
      || !HASH_PATTERN.test(row.content_sha256)
      || (row.content_length !== undefined && Number(row.content_length) !== byteLength)) {
    throw new StorageCorruptionError('A stored direct-chat attachment descriptor is inconsistent.');
  }
  return Object.freeze({
    accountId: row.account_id,
    threadId: row.thread_id,
    attachmentId: row.attachment_id,
    messageId: row.message_id,
    position,
    mediaType: row.media_type,
    byteLength,
    width,
    height,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    descriptor: visionAttachmentDescriptor({
      attachmentId: row.attachment_id,
      mediaType: row.media_type,
      byteLength,
      width,
      height,
      contentSha256: row.content_sha256
    })
  });
}

function attachmentsForMessage(database, accountId, threadId, messageId) {
  if ((DATABASE_METADATA.get(database)?.schemaVersion ?? 0) < 3) return Object.freeze([]);
  return Object.freeze(database.prepare(`
    SELECT * FROM direct_chat_attachments
    WHERE account_id = ? AND thread_id = ? AND message_id = ?
    ORDER BY position
  `).all(accountId, threadId, messageId).map(attachmentFromRow));
}

function generationView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    generationId: row.generation_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    terminal: row.status !== 'in_progress',
    modelAlias: row.model_alias,
    sourceRevision: Number(row.source_revision),
    sourceHash: row.source_hash,
    deltaCount: Number(row.delta_count),
    deltaBytes: Number(row.delta_bytes),
    lastDeltaHash: row.last_delta_hash,
    finalRevision: row.final_revision === null ? null : Number(row.final_revision),
    finalHash: row.final_hash,
    failureCode: row.failure_code,
    deltasPruned: row.deltas_pruned === 1,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    prunedAt: row.pruned_at
  };
}

function deltaView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    generationId: row.generation_id,
    sequence: Number(row.sequence),
    content: row.content,
    contentBytes: Number(row.content_bytes),
    previousHash: row.previous_hash,
    deltaHash: row.delta_hash,
    createdAt: row.created_at
  };
}

function compactionView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    snapshotId: row.snapshot_id,
    sourceStartRevision: Number(row.source_start_revision),
    sourceStartHash: row.source_start_hash,
    sourceEndRevision: Number(row.source_end_revision),
    sourceEndHash: row.source_end_hash,
    summaryText: row.summary_text,
    summaryBytes: Number(row.summary_bytes),
    summaryHash: row.summary_hash,
    untrustedDirectChatData: true,
    createdAt: row.created_at
  };
}

function threadDeletionView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    deleted: true,
    revision: Number(row.deleted_revision),
    ledgerHash: row.deleted_hash,
    deletedAt: row.deleted_at
  };
}

function threadDeletionRequest(accountId, threadId, cursor) {
  return {
    accountId,
    threadId,
    expectedRevision: cursor.revision,
    expectedHash: cursor.hash
  };
}

function threadDeletionDigest(result) {
  return {
    accountId: result.accountId,
    threadId: result.threadId,
    deleted: result.deleted,
    revision: result.revision,
    ledgerHash: result.ledgerHash,
    deletedAt: result.deletedAt
  };
}

function dispatchLeaseView(row, timestamp) {
  if (!row) return null;
  const active = row.released_at === null && row.expires_at > timestamp;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    generationId: row.generation_id,
    fence: Number(row.fence),
    phase: row.phase,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    dispatchStartedAt: row.dispatch_started_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
    active,
    dispatchMayHaveStarted: row.dispatch_started_at !== null,
    dispatchAmbiguous: row.phase === 'interrupted' || (row.phase === 'dispatch_started' && !active)
  };
}

function calculateMessageHash(row, attachments = []) {
  return sha256(canonicalJson({
    accountId: row.account_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    revision: Number(row.revision),
    role: row.role,
    content: row.content,
    contentBytes: Number(row.content_bytes),
    previousHash: row.previous_hash,
    generationId: row.generation_id,
    createdAt: row.created_at,
    ...attachmentViewFields(attachments)
  }));
}

function calculateDeltaHash(row) {
  return sha256(canonicalJson({
    accountId: row.account_id,
    threadId: row.thread_id,
    generationId: row.generation_id,
    sequence: Number(row.sequence),
    content: row.content,
    contentBytes: Number(row.content_bytes),
    previousHash: row.previous_hash,
    createdAt: row.created_at
  }));
}

function assertStoredTimestamp(value, label) {
  try {
    assertCanonicalIsoTimestamp(value, label);
  } catch (error) {
    throw new StorageCorruptionError(`Stored ${label} is invalid.`, { cause: error });
  }
}

function assertStoredIdentifier(value, label) {
  try {
    assertIdentifier(value, label);
  } catch (error) {
    throw new StorageCorruptionError(`Stored ${label} is invalid.`, { cause: error });
  }
}

function assertStoredText(value, label, limits) {
  try {
    return assertUnicodeScalarString(value, label, limits);
  } catch (error) {
    throw new StorageCorruptionError(`Stored ${label} is invalid.`, { cause: error });
  }
}

function auditDispatchLease(row) {
  assertStoredIdentifier(row.account_id, 'dispatch_lease.account_id');
  assertStoredIdentifier(row.thread_id, 'dispatch_lease.thread_id');
  assertStoredIdentifier(row.generation_id, 'dispatch_lease.generation_id');
  if (!HASH_PATTERN.test(row.owner_hash)) {
    throw new StorageCorruptionError('A stored generation dispatch lease owner digest is invalid.');
  }
  if (!Number.isSafeInteger(Number(row.fence)) || Number(row.fence) < 1) {
    throw new StorageCorruptionError('A stored generation dispatch lease fence is invalid.');
  }
  if (!['claimed', 'dispatch_started', 'released', 'interrupted'].includes(row.phase)) {
    throw new StorageCorruptionError('A stored generation dispatch lease phase is invalid.');
  }
  assertStoredTimestamp(row.expires_at, 'dispatch_lease.expires_at');
  assertStoredTimestamp(row.claimed_at, 'dispatch_lease.claimed_at');
  if (row.dispatch_started_at !== null) {
    assertStoredTimestamp(row.dispatch_started_at, 'dispatch_lease.dispatch_started_at');
  }
  assertStoredTimestamp(row.updated_at, 'dispatch_lease.updated_at');
  if (row.released_at !== null) {
    assertStoredTimestamp(row.released_at, 'dispatch_lease.released_at');
  }
  if (
    row.updated_at < row.claimed_at ||
    (row.dispatch_started_at !== null && (
      row.dispatch_started_at < row.claimed_at || row.dispatch_started_at > row.updated_at
    )) ||
    (['claimed', 'dispatch_started'].includes(row.phase) && (
      row.released_at !== null || row.expires_at <= row.updated_at
    )) ||
    (['released', 'interrupted'].includes(row.phase) && (
      row.released_at === null ||
      row.expires_at !== row.released_at ||
      row.updated_at !== row.released_at ||
      row.released_at < row.claimed_at
    )) ||
    (row.phase === 'claimed' && row.dispatch_started_at !== null) ||
    (['dispatch_started', 'interrupted'].includes(row.phase) && row.dispatch_started_at === null)
  ) {
    throw new StorageCorruptionError('A stored generation dispatch lease lifetime is inconsistent.');
  }
}

function requireThread(database, accountId, threadId) {
  const row = database.prepare(`
    SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
  `).get(accountId, threadId);
  if (!row) throw new NotFoundError();
  return row;
}

function requireGeneration(database, accountId, threadId, generationId) {
  const row = database.prepare(`
    SELECT * FROM direct_chat_generations
    WHERE account_id = ? AND thread_id = ? AND generation_id = ?
  `).get(accountId, threadId, generationId);
  if (!row) throw new NotFoundError();
  return row;
}

function auditGeneration(database, generation) {
  assertStoredIdentifier(generation.account_id, 'generation.account_id');
  assertStoredIdentifier(generation.thread_id, 'generation.thread_id');
  assertStoredIdentifier(generation.generation_id, 'generation.generation_id');
  assertStoredIdentifier(generation.assistant_message_id, 'generation.assistant_message_id');
  assertStoredTimestamp(generation.started_at, 'generation.started_at');
  assertStoredTimestamp(generation.updated_at, 'generation.updated_at');
  if (generation.terminal_at !== null) assertStoredTimestamp(generation.terminal_at, 'generation.terminal_at');
  if (generation.pruned_at !== null) assertStoredTimestamp(generation.pruned_at, 'generation.pruned_at');

  const deltas = database.prepare(`
    SELECT * FROM direct_chat_deltas
    WHERE account_id = ? AND thread_id = ? AND generation_id = ?
    ORDER BY sequence
  `).all(generation.account_id, generation.thread_id, generation.generation_id);
  let previousHash = null;
  let bytes = 0;
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index];
    assertStoredIdentifier(delta.account_id, 'delta.account_id');
    assertStoredIdentifier(delta.thread_id, 'delta.thread_id');
    assertStoredIdentifier(delta.generation_id, 'delta.generation_id');
    assertStoredText(delta.content, 'delta.content', { maxBytes: DIRECT_CHAT_LIMITS.deltaBytes });
    const expectedSequence = index + 1;
    if (
      Number(delta.sequence) !== expectedSequence ||
      delta.previous_hash !== previousHash ||
      Number(delta.content_bytes) !== utf8Bytes(delta.content) ||
      calculateDeltaHash(delta) !== delta.delta_hash
    ) {
      throw new StorageCorruptionError('A direct-chat generation delta hash chain is inconsistent.');
    }
    assertStoredTimestamp(delta.created_at, 'delta.created_at');
    bytes += Number(delta.content_bytes);
    previousHash = delta.delta_hash;
  }
  if (generation.deltas_pruned === 1) {
    if (
      generation.status !== 'completed' || generation.pruned_at === null || deltas.length !== 0 ||
      Number(generation.delta_count) < 1 || Number(generation.delta_count) > DIRECT_CHAT_LIMITS.deltasPerGeneration ||
      Number(generation.delta_bytes) < 1 || Number(generation.delta_bytes) > DIRECT_CHAT_LIMITS.generationBytes ||
      !HASH_PATTERN.test(generation.last_delta_hash)
    ) {
      throw new StorageCorruptionError('A pruned direct-chat generation has invalid retained metadata.');
    }
    return deltas;
  }
  if (
    deltas.length !== Number(generation.delta_count) ||
    bytes !== Number(generation.delta_bytes) ||
    previousHash !== generation.last_delta_hash ||
    deltas.length > DIRECT_CHAT_LIMITS.deltasPerGeneration ||
    bytes > DIRECT_CHAT_LIMITS.generationBytes
  ) {
    throw new StorageCorruptionError('A direct-chat generation journal is inconsistent.');
  }
  return deltas;
}

function auditThread(database, thread) {
  assertStoredIdentifier(thread.account_id, 'thread.account_id');
  assertStoredIdentifier(thread.thread_id, 'thread.thread_id');
  assertStoredText(thread.title, 'thread.title', { minBytes: 0, maxBytes: 512 });
  assertStoredTimestamp(thread.created_at, 'thread.created_at');
  assertStoredTimestamp(thread.updated_at, 'thread.updated_at');
  if (!MODEL_ALIAS_PATTERN.test(thread.model_alias)) {
    throw new StorageCorruptionError('A stored direct-chat model alias is invalid.');
  }
  const messages = database.prepare(`
    SELECT * FROM direct_chat_messages
    WHERE account_id = ? AND thread_id = ?
    ORDER BY revision
  `).all(thread.account_id, thread.thread_id);
  const metadata = DATABASE_METADATA.get(database);
  const attachmentRows = metadata?.schemaVersion >= 3
    ? database.prepare(`
        SELECT account_id, thread_id, attachment_id, message_id, position, media_type,
               byte_length, width, height, content_sha256, created_at,
               length(content) AS content_length
        FROM direct_chat_attachments
        WHERE account_id = ? AND thread_id = ?
        ORDER BY created_at, message_id, position
      `).all(thread.account_id, thread.thread_id)
    : [];
  if (attachmentRows.length > VISION_ATTACHMENT_LIMITS.attachmentsPerThread) {
    throw new StorageCorruptionError('A direct-chat thread exceeds its vision attachment count bound.');
  }
  const attachments = attachmentRows.map(attachmentDescriptorFromRow);
  const attachmentByMessage = new Map();
  for (const attachment of attachments) {
    const owned = attachmentByMessage.get(attachment.messageId) ?? [];
    if (attachment.position !== owned.length
        || owned.length >= VISION_ATTACHMENT_LIMITS.attachmentsPerMessage) {
      throw new StorageCorruptionError('A direct-chat message has inconsistent vision attachment positions.');
    }
    owned.push(attachment);
    attachmentByMessage.set(attachment.messageId, owned);
  }
  const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
  if (attachmentBytes > VISION_ATTACHMENT_LIMITS.bytesPerThread) {
    throw new StorageCorruptionError('A direct-chat thread exceeds its vision attachment storage bound.');
  }
  for (const owned of attachmentByMessage.values()) {
    if (owned.reduce((total, attachment) => total + attachment.byteLength, 0)
        > VISION_ATTACHMENT_LIMITS.bytesPerMessage) {
      throw new StorageCorruptionError('A direct-chat message exceeds its vision attachment storage bound.');
    }
  }
  const messageRevisionById = new Map(messages.map((message) => [message.message_id, Number(message.revision)]));
  const firstVisionRevision = attachments.reduce((minimum, attachment) => {
    const revision = messageRevisionById.get(attachment.messageId);
    if (revision === undefined) {
      throw new StorageCorruptionError('A direct-chat vision attachment has no ledger message.');
    }
    return Math.min(minimum, revision);
  }, Number.POSITIVE_INFINITY);
  let previousHash = null;
  let bytes = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    assertStoredIdentifier(message.account_id, 'message.account_id');
    assertStoredIdentifier(message.thread_id, 'message.thread_id');
    assertStoredIdentifier(message.message_id, 'message.message_id');
    if (message.generation_id !== null) {
      assertStoredIdentifier(message.generation_id, 'message.generation_id');
    }
    const messageAttachments = attachmentByMessage.get(message.message_id) ?? [];
    if (messageAttachments.length > 0 && message.role !== 'user') {
      throw new StorageCorruptionError('A direct-chat vision attachment is not bound to a user message.');
    }
    assertStoredText(message.content, 'message.content', { maxBytes: DIRECT_CHAT_LIMITS.messageBytes });
    const expectedRevision = index + 1;
    if (
      Number(message.revision) !== expectedRevision ||
      message.previous_hash !== previousHash ||
      Number(message.content_bytes) !== utf8Bytes(message.content) ||
      calculateMessageHash(message, messageAttachments) !== message.message_hash
    ) {
      throw new StorageCorruptionError('A direct-chat message ledger hash chain is inconsistent.');
    }
    assertStoredTimestamp(message.created_at, 'message.created_at');
    bytes += Number(message.content_bytes);
    previousHash = message.message_hash;
  }
  if (
    messages.length !== Number(thread.message_count) ||
    messages.length !== Number(thread.ledger_revision) ||
    bytes !== Number(thread.ledger_bytes) ||
    previousHash !== thread.ledger_hash ||
    messages.length > DIRECT_CHAT_LIMITS.messagesPerThread ||
    bytes > DIRECT_CHAT_LIMITS.ledgerBytesPerThread
  ) {
    throw new StorageCorruptionError('A direct-chat thread ledger is inconsistent.');
  }

  const generations = database.prepare(`
    SELECT * FROM direct_chat_generations
    WHERE account_id = ? AND thread_id = ?
    ORDER BY started_at, generation_id
  `).all(thread.account_id, thread.thread_id);
  let activeId = null;
  let totalDeltas = 0;
  let totalJournalBytes = 0;
  const completedGenerationIds = new Set();
  for (const generation of generations) {
    const source = messages[Number(generation.source_revision) - 1];
    const hasVision = firstVisionRevision <= Number(generation.source_revision);
    const expectedModelAlias = hasVision ? metadata.visionModelAlias : thread.model_alias;
    if (
      !source || source.message_hash !== generation.source_hash || source.role !== 'user' ||
      generation.model_alias !== expectedModelAlias
    ) {
      throw new StorageCorruptionError('A direct-chat generation does not reference an exact user-ledger state.');
    }
    const deltas = auditGeneration(database, generation);
    if (generation.deltas_pruned === 0) {
      totalDeltas += deltas.length;
      totalJournalBytes += Number(generation.delta_bytes);
    }
    if (generation.status === 'in_progress') {
      if (activeId !== null) throw new StorageCorruptionError('A thread has multiple active generations.');
      activeId = generation.generation_id;
    }
    if (generation.status === 'completed') {
      const finalMessage = messages[Number(generation.final_revision) - 1];
      if (
        Number(generation.final_revision) !== Number(generation.source_revision) + 1 ||
        !finalMessage ||
        finalMessage.role !== 'assistant' ||
        finalMessage.generation_id !== generation.generation_id ||
        finalMessage.message_id !== generation.assistant_message_id ||
        finalMessage.message_hash !== generation.final_hash ||
        (generation.deltas_pruned === 0 && finalMessage.content !== deltas.map((delta) => delta.content).join(''))
      ) {
        throw new StorageCorruptionError('A completed direct-chat generation has no exact assistant-ledger turn.');
      }
      completedGenerationIds.add(generation.generation_id);
    }
  }
  for (const message of messages) {
    if (message.role === 'assistant' && !completedGenerationIds.has(message.generation_id)) {
      throw new StorageCorruptionError('An assistant-ledger turn has no completed direct-chat generation.');
    }
  }
  if (
    generations.length !== Number(thread.generation_count) ||
    generations.length > DIRECT_CHAT_LIMITS.generationsPerThread ||
    totalDeltas !== Number(thread.journal_delta_count) ||
    totalDeltas > DIRECT_CHAT_LIMITS.deltasPerThread ||
    totalJournalBytes !== Number(thread.journal_bytes) ||
    totalJournalBytes > DIRECT_CHAT_LIMITS.journalBytesPerThread ||
    activeId !== thread.current_generation_id
  ) {
    throw new StorageCorruptionError('A direct-chat thread generation index is inconsistent.');
  }

  const generationById = new Map(
    generations.map((generation) => [generation.generation_id, generation])
  );
  const dispatchLeases = database.prepare(`
    SELECT * FROM direct_chat_generation_leases
    WHERE account_id = ? AND thread_id = ?
    ORDER BY generation_id
  `).all(thread.account_id, thread.thread_id);
  if (dispatchLeases.length > generations.length) {
    throw new StorageCorruptionError('A thread has more generation dispatch leases than generations.');
  }
  for (const lease of dispatchLeases) {
    auditDispatchLease(lease);
    const generation = generationById.get(lease.generation_id);
    if (!generation) {
      throw new StorageCorruptionError('A generation dispatch lease has no owned generation.');
    }
    if (
      lease.released_at === null &&
      (generation.status !== 'in_progress' || thread.current_generation_id !== lease.generation_id)
    ) {
      throw new StorageCorruptionError('An unreleased dispatch lease is not bound to the active generation.');
    }
  }

  const compactions = database.prepare(`
    SELECT * FROM direct_chat_compactions
    WHERE account_id = ? AND thread_id = ?
    ORDER BY source_end_revision, created_at, snapshot_id
  `).all(thread.account_id, thread.thread_id);
  if (compactions.length > DIRECT_CHAT_LIMITS.compactionsPerThread) {
    throw new StorageCorruptionError('A direct-chat thread exceeds the compaction snapshot bound.');
  }
  for (const snapshot of compactions) {
    assertStoredIdentifier(snapshot.account_id, 'compaction.account_id');
    assertStoredIdentifier(snapshot.thread_id, 'compaction.thread_id');
    assertStoredIdentifier(snapshot.snapshot_id, 'compaction.snapshot_id');
    assertStoredText(snapshot.summary_text, 'compaction.summary_text', {
      maxBytes: DIRECT_CHAT_LIMITS.summaryBytes
    });
    const first = messages[Number(snapshot.source_start_revision) - 1];
    const last = messages[Number(snapshot.source_end_revision) - 1];
    if (
      !first || !last ||
      first.message_hash !== snapshot.source_start_hash ||
      last.message_hash !== snapshot.source_end_hash ||
      Number(snapshot.summary_bytes) !== utf8Bytes(snapshot.summary_text) ||
      snapshot.summary_hash !== sha256(snapshot.summary_text)
    ) {
      throw new StorageCorruptionError('A direct-chat compaction snapshot references an invalid ledger range.');
    }
    assertStoredTimestamp(snapshot.created_at, 'compaction.created_at');
  }
  return { messages, generations, attachments, attachmentBytes };
}

function auditDatabase(database) {
  const threads = database.prepare(`
    SELECT * FROM direct_chat_threads ORDER BY account_id, thread_id
  `).all();
  const counts = new Map();
  const attachmentBytesByAccount = new Map();
  for (const thread of threads) {
    const count = (counts.get(thread.account_id) ?? 0) + 1;
    if (count > DIRECT_CHAT_LIMITS.threadsPerAccount) {
      throw new StorageCorruptionError('An account exceeds the direct-chat thread bound.');
    }
    counts.set(thread.account_id, count);
    const audit = auditThread(database, thread);
    attachmentBytesByAccount.set(
      thread.account_id,
      (attachmentBytesByAccount.get(thread.account_id) ?? 0) + audit.attachmentBytes
    );
    if (attachmentBytesByAccount.get(thread.account_id) > VISION_ATTACHMENT_LIMITS.bytesPerAccount) {
      throw new StorageCorruptionError('An account exceeds its vision attachment storage bound.');
    }
    if ((DATABASE_METADATA.get(database)?.schemaVersion ?? 0) >= 3) {
      for (const descriptor of audit.attachments) {
        attachmentFromRow(database.prepare(`
          SELECT * FROM direct_chat_attachments
          WHERE account_id = ? AND thread_id = ? AND attachment_id = ?
        `).get(thread.account_id, thread.thread_id, descriptor.attachmentId));
      }
    }
  }
  const receiptOverflows = database.prepare(`
    SELECT account_id, count(*) AS count
    FROM direct_chat_idempotency
    GROUP BY account_id
    HAVING count(*) > ?
  `).all(DIRECT_CHAT_LIMITS.idempotencyReceiptsPerAccount);
  if (receiptOverflows.length !== 0) {
    throw new StorageCorruptionError('An account exceeds the direct-chat idempotency receipt bound.');
  }
  const receipts = database.prepare(`
    SELECT account_id, thread_id, resource_id, created_at, expires_at
    FROM direct_chat_idempotency
  `).all();
  for (const receipt of receipts) {
    assertStoredIdentifier(receipt.account_id, 'idempotency.account_id');
    assertStoredIdentifier(receipt.thread_id, 'idempotency.thread_id');
    assertStoredIdentifier(receipt.resource_id, 'idempotency.resource_id');
    assertStoredTimestamp(receipt.created_at, 'idempotency.created_at');
    assertStoredTimestamp(receipt.expires_at, 'idempotency.expires_at');
    if (receipt.expires_at <= receipt.created_at) {
      throw new StorageCorruptionError('A direct-chat idempotency receipt has an invalid lifetime.');
    }
  }
  const deletionReceiptOverflows = database.prepare(`
    SELECT account_id, count(*) AS count
    FROM direct_chat_thread_deletions
    GROUP BY account_id
    HAVING count(*) > ?
  `).all(DIRECT_CHAT_LIMITS.threadDeletionReceiptsPerAccount);
  if (deletionReceiptOverflows.length !== 0) {
    throw new StorageCorruptionError('An account exceeds the direct-chat thread deletion receipt bound.');
  }
  const deletionReceipts = database.prepare(`
    SELECT * FROM direct_chat_thread_deletions
    ORDER BY account_id, thread_id
  `).all();
  const liveDeletedThread = database.prepare(`
    SELECT deletion.account_id, deletion.thread_id
    FROM direct_chat_thread_deletions AS deletion
    INNER JOIN direct_chat_threads AS thread
      ON thread.account_id = deletion.account_id AND thread.thread_id = deletion.thread_id
    LIMIT 1
  `).get();
  if (liveDeletedThread) {
    throw new StorageCorruptionError('A deleted direct-chat thread still has live storage.');
  }
  for (const receipt of deletionReceipts) {
    assertStoredIdentifier(receipt.account_id, 'thread_deletion.account_id');
    assertStoredIdentifier(receipt.thread_id, 'thread_deletion.thread_id');
    assertStoredTimestamp(receipt.deleted_at, 'thread_deletion.deleted_at');
    const revision = Number(receipt.deleted_revision);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > DIRECT_CHAT_LIMITS.messagesPerThread
        || (revision === 0) !== (receipt.deleted_hash === null)
        || (revision > 0 && !HASH_PATTERN.test(receipt.deleted_hash))
        || !HASH_PATTERN.test(receipt.key_hash)
        || !HASH_PATTERN.test(receipt.request_hash)
        || !HASH_PATTERN.test(receipt.result_digest)) {
      throw new StorageCorruptionError('A direct-chat thread deletion receipt is invalid.');
    }
    const cursor = { revision, hash: receipt.deleted_hash };
    const request = threadDeletionRequest(receipt.account_id, receipt.thread_id, cursor);
    const result = threadDeletionView(receipt);
    if (sha256(canonicalJson(request)) !== receipt.request_hash
        || sha256(canonicalJson(threadDeletionDigest(result))) !== receipt.result_digest) {
      throw new StorageCorruptionError('A direct-chat thread deletion receipt digest is inconsistent.');
    }
  }
}

function assertCursor(revision, hash, prefix = 'expected') {
  const normalizedRevision = assertInteger(revision, `${prefix}Revision`, { min: 0 });
  const normalizedHash = assertEventHash(hash, normalizedRevision, `${prefix}Hash`);
  return { revision: normalizedRevision, hash: normalizedHash };
}

function assertCursorMatches(thread, cursor) {
  if (Number(thread.ledger_revision) !== cursor.revision || thread.ledger_hash !== cursor.hash) {
    throw new ConflictError('The direct-chat ledger cursor is stale.');
  }
}

function assertTurnAttachment(value) {
  assertExactKeys(
    value,
    {
      required: [
        'attachmentId', 'mediaType', 'byteLength', 'width', 'height',
        'contentSha256', 'content'
      ]
    },
    'direct chat turn attachment'
  );
  return validateStoredVisionAttachment(value);
}

function assertTurnAttachments(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > VISION_ATTACHMENT_LIMITS.attachmentsPerMessage) {
    throw new ValidationError('Direct Chat attachments must be a bounded non-empty array.');
  }
  const attachments = [];
  const identifiers = new Set();
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new ValidationError('Direct Chat attachments must be dense.');
    const attachment = assertTurnAttachment(value[index]);
    if (identifiers.has(attachment.attachmentId)) {
      throw new ValidationError('Direct Chat attachment identifiers must be unique.');
    }
    identifiers.add(attachment.attachmentId);
    bytes += attachment.byteLength;
    if (bytes > VISION_ATTACHMENT_LIMITS.bytesPerMessage) {
      throw new ValidationError('Direct Chat attachments exceed the per-message byte limit.');
    }
    attachments.push(attachment);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)
        || Number(key) >= value.length))) {
    throw new ValidationError('Direct Chat attachments contain an unsupported property.');
  }
  return Object.freeze(attachments);
}

function statusVersion(generation) {
  const deltaCount = Number(generation.delta_count ?? generation.deltaCount);
  const finalRevision = Number(generation.final_revision ?? generation.finalRevision);
  if (generation.status === 'completed') return finalRevision;
  return deltaCount;
}

function terminalGenerationDigestInput(result) {
  return {
    accountId: result.accountId,
    threadId: result.threadId,
    generationId: result.generationId,
    assistantMessageId: result.assistantMessageId,
    status: result.status,
    modelAlias: result.modelAlias,
    sourceRevision: result.sourceRevision,
    sourceHash: result.sourceHash,
    deltaCount: result.deltaCount,
    deltaBytes: result.deltaBytes,
    lastDeltaHash: result.lastDeltaHash,
    finalRevision: result.finalRevision,
    finalHash: result.finalHash,
    failureCode: result.failureCode,
    terminalAt: result.terminalAt
  };
}

export class DirectChatStore {
  #auditedThreads = new Map();
  #auditDataVersion = null;
  #clock;
  #closed = false;
  #database;
  #databasePath;
  #enableVisionAttachments;
  #modelAlias;
  #readTransactionActive = false;
  #readTransactionDataVersion = null;
  #schemaVersion;
  #visionModelAlias;
  #writeTransactionActive = false;

  constructor({
    databasePath,
    modelAlias = 'local-default',
    visionModelAlias = VISION_MODEL_ALIAS,
    enableVisionAttachments = false,
    clock = DEFAULT_CLOCK,
    readOnly = false
  } = {}) {
    if (typeof clock !== 'function') throw new ValidationError('clock must be a function.');
    if (typeof readOnly !== 'boolean') throw new ValidationError('readOnly must be boolean.');
    if (typeof enableVisionAttachments !== 'boolean') {
      throw new ValidationError('enableVisionAttachments must be boolean.');
    }
    this.#clock = clock;
    this.#modelAlias = assertModelAlias(modelAlias);
    this.#visionModelAlias = assertModelAlias(visionModelAlias);
    this.#enableVisionAttachments = enableVisionAttachments;
    this.#databasePath = readOnly
      ? requireSecureExistingDatabasePath(databasePath)
      : prepareSecureDatabasePath(databasePath);

    let database;
    try {
      database = new DatabaseSync(this.#databasePath, { readOnly });
    } catch (error) {
      throw new StorageCorruptionError('SQLite could not open the direct-chat database.', { cause: error });
    }
    try {
      database.enableLoadExtension(false);
      if (readOnly) {
        database.exec(`
          PRAGMA busy_timeout = 5000;
          PRAGMA query_only = ON;
          PRAGMA foreign_keys = ON;
          PRAGMA trusted_schema = OFF;
        `);
        const allowedSchemaVersions = enableVisionAttachments
          ? [LATEST_CHAT_SCHEMA_VERSION]
          : [...new Set([DEFAULT_CHAT_SCHEMA_VERSION, LATEST_CHAT_SCHEMA_VERSION])];
        this.#schemaVersion = checkOpenSqliteHealth(database, {
          expectedApplicationId: CHAT_SQLITE_APPLICATION_ID,
          allowedSchemaVersions
        }).schemaVersion;
      } else {
        database.exec(`
          PRAGMA busy_timeout = 5000;
          PRAGMA foreign_keys = ON;
          PRAGMA journal_mode = DELETE;
          PRAGMA synchronous = FULL;
          PRAGMA temp_store = MEMORY;
          PRAGMA trusted_schema = OFF;
          PRAGMA secure_delete = ON;
        `);
        this.#schemaVersion = applyChatMigrations(database, nowIso(this.#clock), {
          enableVisionAttachments
        });
      }
      DATABASE_METADATA.set(database, Object.freeze({
        schemaVersion: this.#schemaVersion,
        visionModelAlias: this.#visionModelAlias
      }));
      database.exec('BEGIN');
      try {
        auditDatabase(database);
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the audit failure.
        }
        throw error;
      }
      assertSecureDatabaseFile(this.#databasePath);
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the initialization error.
      }
      if (
        error instanceof StorageCorruptionError ||
        error?.code === 'unsupported_schema' ||
        error?.code === 'storage_security_error' ||
        error?.code === 'invalid_input'
      ) {
        throw error;
      }
      throw new StorageCorruptionError('The direct-chat database could not be initialized safely.', { cause: error });
    }
    this.#database = database;
  }

  #assertOpen() {
    if (this.#closed) throw new StorageCorruptionError('The direct-chat database is closed.');
  }

  #clearAuditedThreads() {
    this.#auditedThreads.clear();
    this.#auditDataVersion = null;
  }

  #dataVersion() {
    const value = Number(this.#database.prepare('PRAGMA data_version').get()?.data_version);
    if (!Number.isSafeInteger(value) || value < 1) {
      this.#clearAuditedThreads();
      throw new StorageCorruptionError('SQLite returned an invalid direct-chat data version.');
    }
    return value;
  }

  #auditThread(thread) {
    // Write transactions deliberately bypass the cache. A transaction can
    // touch several integrity-linked rows without advancing data_version on
    // its own connection, so both its precondition and postcondition audits
    // must inspect the actual transactional snapshot.
    if (this.#writeTransactionActive) return auditThread(this.#database, thread);

    const dataVersion = this.#readTransactionDataVersion ?? this.#dataVersion();
    if (this.#readTransactionActive && this.#readTransactionDataVersion === null) {
      // The owning lookup already pinned this read transaction's snapshot.
      // Reuse one data_version guard for every thread in the same list read.
      this.#readTransactionDataVersion = dataVersion;
    }
    if (this.#auditDataVersion !== dataVersion) {
      this.#auditedThreads.clear();
      this.#auditDataVersion = dataVersion;
    }
    assertStoredIdentifier(thread.account_id, 'thread.account_id');
    assertStoredIdentifier(thread.thread_id, 'thread.thread_id');
    const identity = canonicalJson([thread.account_id, thread.thread_id]);
    if (this.#auditedThreads.has(identity)) {
      // Refresh insertion order so the bounded map behaves as a small LRU.
      this.#auditedThreads.delete(identity);
      this.#auditedThreads.set(identity, dataVersion);
      return null;
    }

    let result;
    try {
      result = auditThread(this.#database, thread);
    } catch (error) {
      this.#auditedThreads.delete(identity);
      throw error;
    }
    // A read transaction validates its version again after COMMIT. Keep the
    // local second check for any future caller that audits outside one.
    if (!this.#readTransactionActive && this.#dataVersion() !== dataVersion) {
      this.#clearAuditedThreads();
      return result;
    }
    this.#auditedThreads.set(identity, dataVersion);
    if (this.#auditedThreads.size > MAX_AUDITED_THREAD_CACHE_ENTRIES) {
      this.#auditedThreads.delete(this.#auditedThreads.keys().next().value);
    }
    return result;
  }

  #transaction(callback) {
    this.#assertOpen();
    // SQLite data_version changes only for commits made by other connections.
    // Clear around every local write transaction and never cache its audits.
    this.#clearAuditedThreads();
    this.#writeTransactionActive = true;
    try {
      try {
        this.#database.exec('BEGIN IMMEDIATE');
        const result = callback();
        this.#database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK');
        } catch {
          // Preserve the mutation error.
        }
        throw error;
      }
    } finally {
      this.#writeTransactionActive = false;
      this.#clearAuditedThreads();
    }
  }

  #readTransaction(callback) {
    this.#assertOpen();
    this.#readTransactionActive = true;
    this.#readTransactionDataVersion = null;
    try {
      try {
        this.#database.exec('BEGIN');
        const result = callback();
        this.#database.exec('COMMIT');
        if (this.#readTransactionDataVersion !== null
            && this.#dataVersion() !== this.#readTransactionDataVersion) {
          // An external WAL-capable connection may commit while a read
          // snapshot is pinned. The result was coherent, but it must not seed
          // cache state for the newer database version.
          this.#clearAuditedThreads();
        }
        return result;
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK');
        } catch {
          // Preserve the read or validation failure.
        }
        this.#clearAuditedThreads();
        throw error;
      }
    } finally {
      this.#readTransactionDataVersion = null;
      this.#readTransactionActive = false;
    }
  }

  #deleteExpiredReceipts(timestamp, limit = DIRECT_CHAT_LIMITS.cleanupRows, accountId = null) {
    const result = this.#database.prepare(`
      DELETE FROM direct_chat_idempotency
      WHERE rowid IN (
        SELECT rowid FROM direct_chat_idempotency
        WHERE expires_at <= ? AND (? IS NULL OR account_id = ?)
        ORDER BY expires_at, rowid
        LIMIT ?
      )
    `).run(timestamp, accountId, accountId, limit);
    return Number(result.changes);
  }

  #generationLease(accountId, threadId, generationId) {
    return this.#database.prepare(`
      SELECT * FROM direct_chat_generation_leases
      WHERE account_id = ? AND thread_id = ? AND generation_id = ?
    `).get(accountId, threadId, generationId) ?? null;
  }

  #reconcileExpiredGenerationDispatches(timestamp) {
    // A one-way dispatch marker is never replayable. Releasing an expired
    // global admission therefore also records the owning generation as
    // interrupted and advances its fence before another inference may start.
    this.#database.prepare(`
      UPDATE direct_chat_generation_leases
      SET fence = fence + 1, phase = 'interrupted', expires_at = ?,
          updated_at = ?, released_at = ?
      WHERE phase = 'dispatch_started' AND released_at IS NULL
        AND expires_at <= ? AND fence < ?
    `).run(timestamp, timestamp, timestamp, timestamp, MAX_DISPATCH_LEASE_FENCE);
    const exhausted = this.#database.prepare(`
      SELECT 1 AS present FROM direct_chat_generation_leases
      WHERE phase = 'dispatch_started' AND released_at IS NULL
        AND expires_at <= ? AND fence >= ?
      LIMIT 1
    `).get(timestamp, MAX_DISPATCH_LEASE_FENCE);
    if (exhausted) throw new ConflictError('An expired generation dispatch fence is exhausted.');
  }

  #requireGenerationLease(
    accountId,
    threadId,
    generationId,
    proof,
    timestamp,
    allowedPhases = ['dispatch_started']
  ) {
    const lease = this.#generationLease(accountId, threadId, generationId);
    if (!lease) {
      if (proof !== null) {
        throw new ConflictError('No dispatch lease is registered for this generation.');
      }
      return null;
    }
    auditDispatchLease(lease);
    if (
      proof === null ||
      lease.owner_hash !== proof.ownerHash ||
      Number(lease.fence) !== proof.fence ||
      lease.released_at !== null ||
      lease.expires_at <= timestamp ||
      !allowedPhases.includes(lease.phase)
    ) {
      throw new ConflictError(
        'The generation dispatch lease is missing, unstarted, expired, released, interrupted, or fenced out.'
      );
    }
    return lease;
  }

  #invalidateGenerationLease(
    accountId,
    threadId,
    generationId,
    timestamp,
    targetPhase = 'released'
  ) {
    if (!['released', 'interrupted'].includes(targetPhase)) {
      throw new StorageCorruptionError('The generation dispatch lease terminal phase is invalid.');
    }
    const lease = this.#generationLease(accountId, threadId, generationId);
    if (!lease) return null;
    auditDispatchLease(lease);
    if (lease.released_at !== null) return lease;
    const releasedAt = timestamp < lease.updated_at ? lease.updated_at : timestamp;
    const updated = this.#database.prepare(`
      UPDATE direct_chat_generation_leases
      SET phase = ?, expires_at = ?, updated_at = ?, released_at = ?
      WHERE account_id = ? AND thread_id = ? AND generation_id = ?
        AND fence = ? AND owner_hash = ? AND released_at IS NULL
    `).run(
      targetPhase,
      releasedAt,
      releasedAt,
      releasedAt,
      accountId,
      threadId,
      generationId,
      lease.fence,
      lease.owner_hash
    );
    if (Number(updated.changes) !== 1) {
      throw new ConflictError('The generation dispatch lease changed concurrently.');
    }
    return this.#generationLease(accountId, threadId, generationId);
  }

  #idempotentMutation(meta, mutation, replay) {
    const accountId = assertIdentifier(meta.accountId, 'accountId');
    const threadId = assertIdentifier(meta.threadId, 'threadId');
    assertIdempotencyKey(meta.idempotencyKey);
    const keyHash = sha256(meta.idempotencyKey);
    const requestHash = sha256(canonicalJson(meta.request));
    const timestamp = nowIso(this.#clock);
    const expiresAt = addMilliseconds(timestamp, DIRECT_CHAT_IDEMPOTENCY_TTL_MS);

    return this.#transaction(() => {
      this.#deleteExpiredReceipts(timestamp);
      const existing = this.#database.prepare(`
        SELECT * FROM direct_chat_idempotency
        WHERE account_id = ? AND operation = ? AND key_hash = ?
      `).get(accountId, meta.operation, keyHash);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new IdempotencyConflictError();
        if (
          existing.resource_kind !== meta.resourceKind ||
          existing.thread_id !== threadId ||
          existing.resource_id !== meta.resourceId ||
          !HASH_PATTERN.test(existing.result_digest)
        ) {
          throw new StorageCorruptionError('A direct-chat idempotency receipt failed closed-schema validation.');
        }
        const result = replay(existing);
        const digestInput = meta.digestOf === undefined ? result : meta.digestOf(result);
        if (sha256(canonicalJson(digestInput)) !== existing.result_digest) {
          throw new ConflictError('The original direct-chat mutation result can no longer be replayed exactly.');
        }
        return result;
      }

      const result = mutation();
      const version = meta.versionOf(result);
      assertInteger(version, 'resourceVersion', { min: 0 });
      this.#database.prepare(`
        INSERT INTO direct_chat_idempotency(
          account_id, operation, key_hash, request_hash, resource_kind,
          thread_id, resource_id, resource_version, result_digest, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId,
        meta.operation,
        keyHash,
        requestHash,
        meta.resourceKind,
        threadId,
        meta.resourceId,
        version,
        sha256(canonicalJson(meta.digestOf === undefined ? result : meta.digestOf(result))),
        timestamp,
        expiresAt
      );
      this.#database.prepare(`
        DELETE FROM direct_chat_idempotency
        WHERE rowid IN (
          SELECT rowid FROM direct_chat_idempotency
          WHERE account_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT -1 OFFSET ?
        )
      `).run(accountId, DIRECT_CHAT_LIMITS.idempotencyReceiptsPerAccount);
      return result;
    });
  }

  createThread(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'idempotencyKey'], optional: ['title'] },
      'direct chat thread'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const title = assertUnicodeScalarString(input.title ?? '', 'title', { minBytes: 0, maxBytes: 512 });
    const request = { accountId, threadId, title: title.value };

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: 'thread.create',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'thread',
        resourceId: threadId,
        versionOf: (result) => result.revision,
        digestOf: (result) => ({
          accountId: result.accountId,
          threadId: result.threadId,
          title: result.title,
          modelAlias: result.modelAlias
        })
      },
      () => {
        const retired = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_thread_deletions
          WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId);
        if (retired) {
          throw new ConflictError('The direct-chat thread identifier was permanently retired.');
        }
        const existing = this.#database.prepare(`
          SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId);
        if (existing) {
          if (existing.title !== title.value || existing.model_alias !== this.#modelAlias) {
            throw new ConflictError('The direct-chat thread identifier already has different immutable settings.');
          }
          this.#auditThread(existing);
          return threadView(existing);
        }
        const count = Number(this.#database.prepare(`
          SELECT count(*) AS count FROM direct_chat_threads WHERE account_id = ?
        `).get(accountId).count);
        if (count >= DIRECT_CHAT_LIMITS.threadsPerAccount) {
          throw new ConflictError('The account reached its direct-chat thread limit.');
        }
        const timestamp = nowIso(this.#clock);
        try {
          this.#database.prepare(`
            INSERT INTO direct_chat_threads(
              account_id, thread_id, title, title_bytes, model_alias, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(accountId, threadId, title.value, title.bytes, this.#modelAlias, timestamp, timestamp);
        } catch (error) {
          if (isConstraintError(error)) throw new ConflictError();
          throw error;
        }
        return threadView(requireThread(this.#database, accountId, threadId));
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        return threadView(thread);
      }
    );
  }

  getThread(accountId, threadId) {
    this.#assertOpen();
    assertIdentifier(accountId, 'accountId');
    assertIdentifier(threadId, 'threadId');
    return this.#readTransaction(() => {
      const row = this.#database.prepare(`
        SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!row) return null;
      this.#auditThread(row);
      return threadView(row);
    });
  }

  listThreads(input) {
    this.#assertOpen();
    assertExactKeys(input, { required: ['accountId'], optional: ['limit'] }, 'direct chat thread query');
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const limit = assertInteger(input.limit ?? 50, 'limit', { min: 1, max: DIRECT_CHAT_LIMITS.listPage });
    return this.#readTransaction(() => {
      const rows = this.#database.prepare(`
        SELECT * FROM direct_chat_threads
        WHERE account_id = ?
        ORDER BY updated_at DESC, thread_id DESC
        LIMIT ?
      `).all(accountId, limit);
      for (const row of rows) this.#auditThread(row);
      return rows.map(threadView);
    });
  }

  deleteThread(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId', 'threadId', 'expectedRevision', 'expectedHash', 'idempotencyKey'
        ]
      },
      'direct chat thread deletion'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const cursor = assertCursor(input.expectedRevision, input.expectedHash);
    assertIdempotencyKey(input.idempotencyKey);
    const keyHash = sha256(input.idempotencyKey);
    const request = threadDeletionRequest(accountId, threadId, cursor);
    const requestHash = sha256(canonicalJson(request));

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT * FROM direct_chat_thread_deletions
        WHERE account_id = ? AND key_hash = ?
      `).get(accountId, keyHash);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new IdempotencyConflictError();
        if (existing.thread_id !== threadId) {
          throw new StorageCorruptionError('A direct-chat deletion receipt has inconsistent ownership.');
        }
        const replayed = threadDeletionView(existing);
        if (sha256(canonicalJson(threadDeletionDigest(replayed))) !== existing.result_digest) {
          throw new ConflictError('The original direct-chat deletion result cannot be replayed exactly.');
        }
        return replayed;
      }

      if (this.#database.prepare(`
        SELECT 1 AS present FROM direct_chat_thread_deletions
        WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId)) {
        throw new NotFoundError();
      }
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      assertCursorMatches(thread, cursor);
      if (thread.current_generation_id !== null) {
        throw new ConflictError('An active or unresolved Direct Chat generation cannot be deleted.');
      }
      const unresolvedUser = this.#database.prepare(`
        SELECT 1 AS present
        FROM direct_chat_messages AS message
        WHERE message.account_id = ? AND message.thread_id = ?
          AND message.revision = ? AND message.role = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM direct_chat_generations AS generation
            WHERE generation.account_id = message.account_id
              AND generation.thread_id = message.thread_id
              AND generation.source_revision = message.revision
              AND generation.source_hash = message.message_hash
          )
      `).get(accountId, threadId, Number(thread.ledger_revision));
      if (unresolvedUser) {
        throw new ConflictError('A Direct Chat send with unresolved acceptance cannot be deleted.');
      }
      const receiptCount = Number(this.#database.prepare(`
        SELECT count(*) AS count FROM direct_chat_thread_deletions WHERE account_id = ?
      `).get(accountId).count);
      if (receiptCount >= DIRECT_CHAT_LIMITS.threadDeletionReceiptsPerAccount) {
        throw new ConflictError('The account reached its durable thread deletion receipt limit.');
      }

      const deletedAt = nowIso(this.#clock);
      const result = {
        accountId,
        threadId,
        deleted: true,
        revision: Number(thread.ledger_revision),
        ledgerHash: thread.ledger_hash,
        deletedAt
      };
      this.#database.prepare(`
        INSERT INTO direct_chat_thread_deletions(
          account_id, thread_id, key_hash, request_hash, deleted_revision,
          deleted_hash, result_digest, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId,
        threadId,
        keyHash,
        requestHash,
        result.revision,
        result.ledgerHash,
        sha256(canonicalJson(threadDeletionDigest(result))),
        deletedAt
      );

      // The durable receipt above is the only authority accepted by the
      // deletion triggers. All private descendants and mutation receipts are
      // removed in one transaction before the owning thread row disappears.
      this.#database.prepare(`
        DELETE FROM direct_chat_attachments WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      this.#database.prepare(`
        DELETE FROM direct_chat_deltas WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      this.#database.prepare(`
        DELETE FROM direct_chat_generation_leases WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      this.#database.prepare(`
        DELETE FROM direct_chat_compactions WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      this.#database.prepare(`
        DELETE FROM direct_chat_generations WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      this.#database.prepare(`
        DELETE FROM direct_chat_messages WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      this.#database.prepare(`
        DELETE FROM direct_chat_idempotency WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      const removed = this.#database.prepare(`
        DELETE FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).run(accountId, threadId);
      if (Number(removed.changes) !== 1) {
        throw new StorageCorruptionError('The authorized direct-chat thread deletion was incomplete.');
      }
      return result;
    });
  }

  startTurn(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId', 'threadId', 'messageId', 'content',
          'generationId', 'assistantMessageId',
          'expectedRevision', 'expectedHash', 'idempotencyKey'
        ],
        optional: ['attachment', 'attachments']
      },
      'atomic direct chat turn'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const messageId = assertIdentifier(input.messageId, 'messageId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const assistantMessageId = assertIdentifier(input.assistantMessageId, 'assistantMessageId');
    const content = assertUnicodeScalarString(input.content, 'content', {
      maxBytes: DIRECT_CHAT_LIMITS.messageBytes
    });
    const cursor = assertCursor(input.expectedRevision, input.expectedHash);
    if (input.attachment !== undefined && input.attachments !== undefined) {
      throw new ValidationError('Use either attachment or attachments, not both.');
    }
    const attachments = input.attachments !== undefined
      ? assertTurnAttachments(input.attachments)
      : (input.attachment === undefined
        ? Object.freeze([])
        : Object.freeze([assertTurnAttachment(input.attachment)]));
    if (messageId === assistantMessageId) {
      throw new ConflictError('The user and assistant message identifiers must be different.');
    }
    const request = {
      accountId,
      threadId,
      messageId,
      content: content.value,
      generationId,
      assistantMessageId,
      expectedRevision: cursor.revision,
      expectedHash: cursor.hash,
      ...attachmentViewFields(attachments)
    };

    const immutableDigest = (result) => ({
      message: {
        accountId: result.message.accountId,
        threadId: result.message.threadId,
        messageId: result.message.messageId,
        revision: result.message.revision,
        role: result.message.role,
        content: result.message.content,
        contentBytes: result.message.contentBytes,
        previousHash: result.message.previousHash,
        messageHash: result.message.messageHash,
        createdAt: result.message.createdAt,
        ...(result.message.attachment === undefined ? {} : { attachment: result.message.attachment }),
        ...(result.message.attachments === undefined ? {} : { attachments: result.message.attachments })
      },
      generation: {
        accountId: result.generation.accountId,
        threadId: result.generation.threadId,
        generationId: result.generation.generationId,
        assistantMessageId: result.generation.assistantMessageId,
        modelAlias: result.generation.modelAlias,
        sourceRevision: result.generation.sourceRevision,
        sourceHash: result.generation.sourceHash,
        startedAt: result.generation.startedAt
      }
    });
    const replayTurn = () => {
      const message = this.#database.prepare(`
        SELECT * FROM direct_chat_messages
        WHERE account_id = ? AND thread_id = ? AND message_id = ?
      `).get(accountId, threadId, messageId);
      const generation = this.#database.prepare(`
        SELECT * FROM direct_chat_generations
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
      `).get(accountId, threadId, generationId);
      if (!message || !generation) {
        throw new ConflictError('The atomic direct-chat turn is only partially present.');
      }
      const storedAttachments = attachmentsForMessage(this.#database, accountId, threadId, messageId);
      const expectedAttachmentFields = attachmentViewFields(attachments);
      const actualAttachmentFields = attachmentViewFields(storedAttachments);
      const latestAttachment = this.#schemaVersion >= 3
        ? this.#database.prepare(`
            SELECT 1 AS present
            FROM direct_chat_attachments AS attachment
            JOIN direct_chat_messages AS owned
              ON owned.account_id = attachment.account_id
             AND owned.thread_id = attachment.thread_id
             AND owned.message_id = attachment.message_id
            WHERE attachment.account_id = ? AND attachment.thread_id = ?
              AND owned.revision <= ?
            LIMIT 1
          `).get(accountId, threadId, Number(message.revision))
        : null;
      const ownerThread = requireThread(this.#database, accountId, threadId);
      const expectedModelAlias = latestAttachment ? this.#visionModelAlias : ownerThread.model_alias;
      if (
        message.role !== 'user' ||
        message.content !== content.value ||
        Number(message.revision) !== cursor.revision + 1 ||
        message.previous_hash !== cursor.hash ||
        generation.assistant_message_id !== assistantMessageId ||
        Number(generation.source_revision) !== Number(message.revision) ||
        generation.source_hash !== message.message_hash ||
        generation.model_alias !== expectedModelAlias ||
        canonicalJson(actualAttachmentFields) !== canonicalJson(expectedAttachmentFields)
      ) {
        throw new ConflictError('The atomic direct-chat turn identifiers are bound to different data.');
      }
      return {
        message: messageView(message, storedAttachments),
        generation: generationView(generation)
      };
    };

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: 'generation.start',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'generation',
        resourceId: generationId,
        versionOf: (result) => result.generation.sourceRevision,
        digestOf: immutableDigest
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        const existingMessage = this.#database.prepare(`
          SELECT * FROM direct_chat_messages
          WHERE account_id = ? AND thread_id = ? AND message_id = ?
        `).get(accountId, threadId, messageId);
        const existingGeneration = this.#database.prepare(`
          SELECT * FROM direct_chat_generations
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
        `).get(accountId, threadId, generationId);
        if (existingMessage || existingGeneration) return replayTurn();

        const existingVision = this.#schemaVersion >= 3
          ? this.#database.prepare(`
              SELECT 1 AS present FROM direct_chat_attachments
              WHERE account_id = ? AND thread_id = ?
              LIMIT 1
            `).get(accountId, threadId)
          : null;
        if ((attachments.length > 0 || existingVision)
            && (!this.#enableVisionAttachments || this.#schemaVersion < 3)) {
          throw new ValidationError('Vision attachments are not enabled for new Direct Chat turns.');
        }
        if (thread.current_generation_id !== null) {
          throw new ConflictError('A user turn cannot start while generation is in progress.');
        }
        assertCursorMatches(thread, cursor);
        if (Number(thread.message_count) >= DIRECT_CHAT_LIMITS.messagesPerThread) {
          throw new ConflictError('The direct-chat thread reached its message limit.');
        }
        if (Number(thread.ledger_bytes) + content.bytes > DIRECT_CHAT_LIMITS.ledgerBytesPerThread) {
          throw new ConflictError('The direct-chat thread reached its ledger byte limit.');
        }
        if (Number(thread.generation_count) >= DIRECT_CHAT_LIMITS.generationsPerThread) {
          throw new ConflictError('The direct-chat thread reached its generation limit.');
        }
        const reservedUserId = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_generations
          WHERE account_id = ? AND thread_id = ? AND assistant_message_id = ?
        `).get(accountId, threadId, messageId);
        if (reservedUserId) {
          throw new ConflictError('The user message identifier is reserved by an assistant generation.');
        }
        const assistantMessageCollision = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_messages
          WHERE account_id = ? AND thread_id = ? AND message_id = ?
        `).get(accountId, threadId, assistantMessageId);
        if (assistantMessageCollision) {
          throw new ConflictError('The assistant message identifier is already used.');
        }
        const assistantReservationCollision = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_generations
          WHERE account_id = ? AND thread_id = ? AND assistant_message_id = ?
        `).get(accountId, threadId, assistantMessageId);
        if (assistantReservationCollision) {
          throw new ConflictError('The assistant message identifier is already reserved.');
        }

        let inferenceModelAlias = thread.model_alias;
        if (existingVision || attachments.length > 0) inferenceModelAlias = this.#visionModelAlias;
        if (attachments.length > 0) {
          const threadAttachmentTotals = this.#database.prepare(`
            SELECT count(*) AS count, coalesce(sum(byte_length), 0) AS bytes
            FROM direct_chat_attachments
            WHERE account_id = ? AND thread_id = ?
          `).get(accountId, threadId);
          const accountAttachmentBytes = Number(this.#database.prepare(`
            SELECT coalesce(sum(byte_length), 0) AS bytes
            FROM direct_chat_attachments WHERE account_id = ?
          `).get(accountId).bytes);
          const incomingBytes = attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
          if (Number(threadAttachmentTotals.count) + attachments.length > VISION_ATTACHMENT_LIMITS.attachmentsPerThread
              || Number(threadAttachmentTotals.bytes) + incomingBytes > VISION_ATTACHMENT_LIMITS.bytesPerThread
              || accountAttachmentBytes + incomingBytes > VISION_ATTACHMENT_LIMITS.bytesPerAccount) {
            throw new ConflictError('The Direct Chat vision attachment storage quota is reached.');
          }
        }

        const timestamp = nowIso(this.#clock);
        const message = {
          account_id: accountId,
          thread_id: threadId,
          message_id: messageId,
          revision: cursor.revision + 1,
          role: 'user',
          content: content.value,
          content_bytes: content.bytes,
          previous_hash: cursor.hash,
          generation_id: null,
          created_at: timestamp
        };
        message.message_hash = calculateMessageHash(message, attachments);
        try {
          this.#database.prepare(`
            INSERT INTO direct_chat_messages(
              account_id, thread_id, message_id, revision, role, content, content_bytes,
              previous_hash, message_hash, generation_id, created_at
            ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, NULL, ?)
          `).run(
            accountId,
            threadId,
            messageId,
            message.revision,
            message.content,
            message.content_bytes,
            message.previous_hash,
            message.message_hash,
            timestamp
          );
          for (let position = 0; position < attachments.length; position += 1) {
            const attachment = attachments[position];
            this.#database.prepare(`
              INSERT INTO direct_chat_attachments(
                account_id, thread_id, attachment_id, message_id, position, media_type,
                byte_length, width, height, content_sha256, content, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              accountId,
              threadId,
              attachment.attachmentId,
              messageId,
              position,
              attachment.mediaType,
              attachment.byteLength,
              attachment.width,
              attachment.height,
              attachment.contentSha256,
              attachment.content,
              timestamp
            );
          }
          this.#database.prepare(`
            INSERT INTO direct_chat_generations(
              account_id, thread_id, generation_id, assistant_message_id, status,
              model_alias, source_revision, source_hash, started_at, updated_at
            ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)
          `).run(
            accountId,
            threadId,
            generationId,
            assistantMessageId,
            inferenceModelAlias,
            message.revision,
            message.message_hash,
            timestamp,
            timestamp
          );
        } catch (error) {
          if (isConstraintError(error)) throw new ConflictError('The atomic direct-chat turn identifiers conflict.');
          throw error;
        }
        const updated = this.#database.prepare(`
          UPDATE direct_chat_threads
          SET ledger_revision = ?, ledger_hash = ?, message_count = message_count + 1,
              ledger_bytes = ledger_bytes + ?, current_generation_id = ?,
              generation_count = generation_count + 1, updated_at = ?
          WHERE account_id = ? AND thread_id = ? AND ledger_revision = ?
            AND ledger_hash IS ? AND current_generation_id IS NULL
        `).run(
          message.revision,
          message.message_hash,
          message.content_bytes,
          generationId,
          timestamp,
          accountId,
          threadId,
          cursor.revision,
          cursor.hash
        );
        if (Number(updated.changes) !== 1) {
          throw new ConflictError('The direct-chat thread changed concurrently.');
        }
        return {
          message: messageView(message, attachments),
          generation: generationView(
            requireGeneration(this.#database, accountId, threadId, generationId)
          )
        };
      },
      replayTurn
    );
  }

  sendUserMessage(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId', 'threadId', 'messageId', 'content',
          'expectedRevision', 'expectedHash', 'idempotencyKey'
        ]
      },
      'direct chat user message'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const messageId = assertIdentifier(input.messageId, 'messageId');
    const content = assertUnicodeScalarString(input.content, 'content', {
      maxBytes: DIRECT_CHAT_LIMITS.messageBytes
    });
    const cursor = assertCursor(input.expectedRevision, input.expectedHash);
    const request = {
      accountId, threadId, messageId, content: content.value,
      expectedRevision: cursor.revision, expectedHash: cursor.hash
    };

    const replayMessage = () => {
      const row = this.#database.prepare(`
        SELECT * FROM direct_chat_messages
        WHERE account_id = ? AND thread_id = ? AND message_id = ?
      `).get(accountId, threadId, messageId);
      if (!row) throw new ConflictError('The idempotent user message is no longer present.');
      return messageView(row);
    };

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: 'message.user.append',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'message',
        resourceId: messageId,
        versionOf: (result) => result.revision
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        const existing = this.#database.prepare(`
          SELECT * FROM direct_chat_messages
          WHERE account_id = ? AND thread_id = ? AND message_id = ?
        `).get(accountId, threadId, messageId);
        if (existing) {
          if (
            existing.role !== 'user' || existing.content !== content.value ||
            Number(existing.revision) !== cursor.revision + 1 || existing.previous_hash !== cursor.hash
          ) {
            throw new ConflictError('The direct-chat message identifier is already bound to different content.');
          }
          return messageView(existing);
        }
        const reservedAssistantId = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_generations
          WHERE account_id = ? AND thread_id = ? AND assistant_message_id = ?
        `).get(accountId, threadId, messageId);
        if (reservedAssistantId) {
          throw new ConflictError('The message identifier is reserved by an assistant generation.');
        }
        if (thread.current_generation_id !== null) {
          throw new ConflictError('A user message cannot be appended while generation is in progress.');
        }
        assertCursorMatches(thread, cursor);
        if (Number(thread.message_count) >= DIRECT_CHAT_LIMITS.messagesPerThread) {
          throw new ConflictError('The direct-chat thread reached its message limit.');
        }
        if (Number(thread.ledger_bytes) + content.bytes > DIRECT_CHAT_LIMITS.ledgerBytesPerThread) {
          throw new ConflictError('The direct-chat thread reached its ledger byte limit.');
        }
        const timestamp = nowIso(this.#clock);
        const row = {
          account_id: accountId,
          thread_id: threadId,
          message_id: messageId,
          revision: cursor.revision + 1,
          role: 'user',
          content: content.value,
          content_bytes: content.bytes,
          previous_hash: cursor.hash,
          generation_id: null,
          created_at: timestamp
        };
        row.message_hash = calculateMessageHash(row);
        this.#database.prepare(`
          INSERT INTO direct_chat_messages(
            account_id, thread_id, message_id, revision, role, content, content_bytes,
            previous_hash, message_hash, generation_id, created_at
          ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, NULL, ?)
        `).run(
          accountId, threadId, messageId, row.revision, row.content, row.content_bytes,
          row.previous_hash, row.message_hash, timestamp
        );
        const updated = this.#database.prepare(`
          UPDATE direct_chat_threads
          SET ledger_revision = ?, ledger_hash = ?, message_count = message_count + 1,
              ledger_bytes = ledger_bytes + ?, updated_at = ?
          WHERE account_id = ? AND thread_id = ? AND ledger_revision = ?
            AND ledger_hash IS ? AND current_generation_id IS NULL
        `).run(
          row.revision, row.message_hash, row.content_bytes, timestamp,
          accountId, threadId, cursor.revision, cursor.hash
        );
        if (Number(updated.changes) !== 1) throw new ConflictError('The direct-chat ledger changed concurrently.');
        return messageView(row);
      },
      replayMessage
    );
  }

  startGeneration(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId', 'threadId', 'generationId', 'assistantMessageId',
          'expectedRevision', 'expectedHash', 'idempotencyKey'
        ]
      },
      'direct chat generation'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const assistantMessageId = assertIdentifier(input.assistantMessageId, 'assistantMessageId');
    const cursor = assertCursor(input.expectedRevision, input.expectedHash);
    if (cursor.revision === 0) throw new ValidationError('A generation must follow a user message.');
    const request = {
      accountId, threadId, generationId, assistantMessageId,
      expectedRevision: cursor.revision, expectedHash: cursor.hash
    };
    const replayGeneration = () => generationView(
      requireGeneration(this.#database, accountId, threadId, generationId)
    );

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: 'generation.start',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'generation',
        resourceId: generationId,
        versionOf: statusVersion,
        digestOf: (result) => ({
          accountId: result.accountId,
          threadId: result.threadId,
          generationId: result.generationId,
          assistantMessageId: result.assistantMessageId,
          modelAlias: result.modelAlias,
          sourceRevision: result.sourceRevision,
          sourceHash: result.sourceHash
        })
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        const inferenceModelAlias = this.#schemaVersion >= 3 && this.#database.prepare(`
          SELECT 1 AS present
          FROM direct_chat_attachments AS attachment
          JOIN direct_chat_messages AS message
            ON message.account_id = attachment.account_id
           AND message.thread_id = attachment.thread_id
           AND message.message_id = attachment.message_id
          WHERE attachment.account_id = ? AND attachment.thread_id = ?
            AND message.revision <= ?
          LIMIT 1
        `).get(accountId, threadId, cursor.revision)
          ? this.#visionModelAlias
          : thread.model_alias;
        const existing = this.#database.prepare(`
          SELECT * FROM direct_chat_generations
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
        `).get(accountId, threadId, generationId);
        if (existing) {
          if (
            existing.assistant_message_id !== assistantMessageId ||
            Number(existing.source_revision) !== cursor.revision ||
            existing.source_hash !== cursor.hash || existing.model_alias !== inferenceModelAlias
          ) {
            throw new ConflictError('The generation identifier is already bound to a different request.');
          }
          return generationView(existing);
        }
        assertCursorMatches(thread, cursor);
        if (thread.current_generation_id !== null) {
          throw new ConflictError('The thread already has an active generation.');
        }
        if (Number(thread.generation_count) >= DIRECT_CHAT_LIMITS.generationsPerThread) {
          throw new ConflictError('The direct-chat thread reached its generation limit.');
        }
        const last = this.#database.prepare(`
          SELECT role, message_hash FROM direct_chat_messages
          WHERE account_id = ? AND thread_id = ? AND revision = ?
        `).get(accountId, threadId, cursor.revision);
        if (!last || last.role !== 'user' || last.message_hash !== cursor.hash) {
          throw new ConflictError('A generation must start from the exact latest user message.');
        }
        const messageCollision = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_messages
          WHERE account_id = ? AND thread_id = ? AND message_id = ?
        `).get(accountId, threadId, assistantMessageId);
        if (messageCollision) throw new ConflictError('The assistant message identifier is already used.');
        const generationMessageCollision = this.#database.prepare(`
          SELECT 1 AS present FROM direct_chat_generations
          WHERE account_id = ? AND thread_id = ? AND assistant_message_id = ?
        `).get(accountId, threadId, assistantMessageId);
        if (generationMessageCollision) {
          throw new ConflictError('The assistant message identifier is already reserved.');
        }
        const timestamp = nowIso(this.#clock);
        this.#database.prepare(`
          INSERT INTO direct_chat_generations(
            account_id, thread_id, generation_id, assistant_message_id, status,
            model_alias, source_revision, source_hash, started_at, updated_at
          ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)
        `).run(
          accountId, threadId, generationId, assistantMessageId,
          inferenceModelAlias, cursor.revision, cursor.hash, timestamp, timestamp
        );
        const updated = this.#database.prepare(`
          UPDATE direct_chat_threads
          SET current_generation_id = ?, generation_count = generation_count + 1, updated_at = ?
          WHERE account_id = ? AND thread_id = ? AND current_generation_id IS NULL
            AND ledger_revision = ? AND ledger_hash = ?
        `).run(generationId, timestamp, accountId, threadId, cursor.revision, cursor.hash);
        if (Number(updated.changes) !== 1) throw new ConflictError('The direct-chat thread changed concurrently.');
        return generationView(requireGeneration(this.#database, accountId, threadId, generationId));
      },
      replayGeneration
    );
  }

  claimGenerationLease(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'generationId', 'ownerToken', 'ttlMs'] },
      'direct chat generation dispatch lease claim'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const ownerHash = sha256(assertDispatchLeaseOwnerToken(input.ownerToken));
    const ttlMs = assertDispatchLeaseTtl(input.ttlMs);

    let blockedMessage = null;
    const claimed = this.#transaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      const generation = requireGeneration(this.#database, accountId, threadId, generationId);
      if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
        throw new ConflictError('Only the active in-progress generation can acquire a dispatch lease.');
      }
      const timestamp = nowIso(this.#clock);
      this.#reconcileExpiredGenerationDispatches(timestamp);
      const existing = this.#generationLease(accountId, threadId, generationId);
      if (existing) auditDispatchLease(existing);
      if (existing?.phase === 'interrupted') {
        blockedMessage = 'This generation has an ambiguous interrupted dispatch and cannot run inference again.';
        return dispatchLeaseView(existing, timestamp);
      }
      if (
        existing &&
        existing.released_at === null &&
        existing.expires_at > timestamp
      ) {
        if (existing.owner_hash !== ownerHash) {
          throw new ConflictError('The generation already has an active dispatch lease.');
        }
        if (existing.phase !== 'claimed') {
          blockedMessage = 'Inference dispatch was already marked started for this generation.';
        }
        return dispatchLeaseView(existing, timestamp);
      }

      if (existing && existing.dispatch_started_at !== null) {
        const fence = Number(existing.fence) + 1;
        if (!Number.isSafeInteger(fence) || fence > MAX_DISPATCH_LEASE_FENCE) {
          throw new ConflictError('The generation dispatch lease fence is exhausted.');
        }
        const interruptedAt = timestamp < existing.updated_at ? existing.updated_at : timestamp;
        const updated = this.#database.prepare(`
          UPDATE direct_chat_generation_leases
          SET fence = ?, phase = 'interrupted', expires_at = ?,
              updated_at = ?, released_at = ?
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
            AND fence = ? AND owner_hash = ? AND phase = 'dispatch_started'
            AND dispatch_started_at IS NOT NULL AND released_at IS NULL
        `).run(
          fence,
          interruptedAt,
          interruptedAt,
          interruptedAt,
          accountId,
          threadId,
          generationId,
          existing.fence,
          existing.owner_hash
        );
        if (Number(updated.changes) !== 1) {
          throw new ConflictError('The generation dispatch lease changed concurrently.');
        }
        blockedMessage = 'The expired generation dispatch may already have run; start a new user generation.';
        return dispatchLeaseView(
          this.#generationLease(accountId, threadId, generationId),
          timestamp
        );
      }

      const fence = existing === null ? 1 : Number(existing.fence) + 1;
      if (!Number.isSafeInteger(fence) || fence > MAX_DISPATCH_LEASE_FENCE) {
        throw new ConflictError('The generation dispatch lease fence is exhausted.');
      }
      const claimedAt = existing && timestamp < existing.updated_at
        ? existing.updated_at
        : timestamp;
      const expiresAt = addMilliseconds(claimedAt, ttlMs);
      if (!existing) {
        this.#database.prepare(`
          INSERT INTO direct_chat_generation_leases(
            account_id, thread_id, generation_id, owner_hash, fence, phase,
            expires_at, claimed_at, dispatch_started_at, updated_at, released_at
          ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, NULL, ?, NULL)
        `).run(
          accountId,
          threadId,
          generationId,
          ownerHash,
          fence,
          expiresAt,
          claimedAt,
          claimedAt
        );
      } else {
        const updated = this.#database.prepare(`
          UPDATE direct_chat_generation_leases
          SET owner_hash = ?, fence = ?, phase = 'claimed', expires_at = ?, claimed_at = ?,
              dispatch_started_at = NULL, updated_at = ?, released_at = NULL
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
            AND fence = ? AND owner_hash = ? AND expires_at = ?
            AND phase IN ('claimed', 'released') AND dispatch_started_at IS NULL
            AND released_at IS ?
        `).run(
          ownerHash,
          fence,
          expiresAt,
          claimedAt,
          claimedAt,
          accountId,
          threadId,
          generationId,
          existing.fence,
          existing.owner_hash,
          existing.expires_at,
          existing.released_at
        );
        if (Number(updated.changes) !== 1) {
          throw new ConflictError('The generation dispatch lease changed concurrently.');
        }
      }
      return dispatchLeaseView(
        this.#generationLease(accountId, threadId, generationId),
        timestamp
      );
    });
    if (blockedMessage !== null) throw new ConflictError(blockedMessage);
    return claimed;
  }

  markGenerationDispatchStarted(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'generationId', 'ownerToken', 'fence'] },
      'direct chat generation dispatch start marker'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const proof = assertDispatchLeaseProof({ ownerToken: input.ownerToken, fence: input.fence });

    return this.#transaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      const generation = requireGeneration(this.#database, accountId, threadId, generationId);
      if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
        throw new ConflictError('Only the active in-progress generation can start dispatch.');
      }
      const timestamp = nowIso(this.#clock);
      const lease = this.#requireGenerationLease(
        accountId,
        threadId,
        generationId,
        proof,
        timestamp,
        ['claimed', 'dispatch_started']
      );
      if (lease.phase === 'dispatch_started') {
        return Object.freeze({
          ...dispatchLeaseView(lease, timestamp),
          dispatchAuthorized: false,
          dispatchState: 'already_started'
        });
      }
      this.#reconcileExpiredGenerationDispatches(timestamp);
      const activeInference = this.#database.prepare(`
        SELECT 1 AS present FROM direct_chat_generation_leases
        WHERE phase = 'dispatch_started' AND released_at IS NULL
          AND NOT (account_id = ? AND thread_id = ? AND generation_id = ?)
        LIMIT 1
      `).get(accountId, threadId, generationId);
      if (activeInference) {
        return Object.freeze({
          ...dispatchLeaseView(lease, timestamp),
          dispatchAuthorized: false,
          dispatchState: 'global_busy'
        });
      }
      const startedAt = timestamp < lease.updated_at ? lease.updated_at : timestamp;
      const updated = this.#database.prepare(`
        UPDATE direct_chat_generation_leases
        SET phase = 'dispatch_started', dispatch_started_at = ?, updated_at = ?
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
          AND owner_hash = ? AND fence = ? AND phase = 'claimed'
          AND dispatch_started_at IS NULL AND released_at IS NULL AND expires_at > ?
      `).run(
        startedAt,
        startedAt,
        accountId,
        threadId,
        generationId,
        proof.ownerHash,
        proof.fence,
        timestamp
      );
      if (Number(updated.changes) !== 1) {
        throw new ConflictError('The generation dispatch start marker changed concurrently.');
      }
      return Object.freeze({
        ...dispatchLeaseView(
          this.#generationLease(accountId, threadId, generationId),
          timestamp
        ),
        dispatchAuthorized: true,
        dispatchState: 'started'
      });
    });
  }

  getGenerationLease(input) {
    this.#assertOpen();
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'generationId'] },
      'direct chat generation dispatch lease lookup'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    return this.#readTransaction(() => {
      const thread = this.#database.prepare(`
        SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!thread) return null;
      this.#auditThread(thread);
      const lease = this.#generationLease(accountId, threadId, generationId);
      if (!lease) return null;
      auditDispatchLease(lease);
      return dispatchLeaseView(lease, nowIso(this.#clock));
    });
  }

  renewGenerationLease(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'generationId', 'ownerToken', 'fence', 'ttlMs'] },
      'direct chat generation dispatch lease renewal'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const proof = assertDispatchLeaseProof({ ownerToken: input.ownerToken, fence: input.fence });
    const ttlMs = assertDispatchLeaseTtl(input.ttlMs);

    return this.#transaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      const generation = requireGeneration(this.#database, accountId, threadId, generationId);
      if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
        throw new ConflictError('Only the active in-progress generation can renew a dispatch lease.');
      }
      const timestamp = nowIso(this.#clock);
      const lease = this.#requireGenerationLease(
        accountId,
        threadId,
        generationId,
        proof,
        timestamp,
        ['claimed', 'dispatch_started']
      );
      const renewedAt = timestamp < lease.updated_at ? lease.updated_at : timestamp;
      const expiresAt = addMilliseconds(renewedAt, ttlMs);
      if (expiresAt <= lease.expires_at) return dispatchLeaseView(lease, timestamp);
      const updated = this.#database.prepare(`
        UPDATE direct_chat_generation_leases
        SET expires_at = ?, updated_at = ?
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
          AND owner_hash = ? AND fence = ? AND expires_at = ? AND released_at IS NULL
      `).run(
        expiresAt,
        renewedAt,
        accountId,
        threadId,
        generationId,
        proof.ownerHash,
        proof.fence,
        lease.expires_at
      );
      if (Number(updated.changes) !== 1) {
        throw new ConflictError('The generation dispatch lease changed concurrently.');
      }
      return dispatchLeaseView(
        this.#generationLease(accountId, threadId, generationId),
        timestamp
      );
    });
  }

  releaseGenerationLease(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'generationId', 'ownerToken', 'fence'] },
      'direct chat generation dispatch lease release'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const proof = assertDispatchLeaseProof({ ownerToken: input.ownerToken, fence: input.fence });

    return this.#transaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      const generation = requireGeneration(this.#database, accountId, threadId, generationId);
      const timestamp = nowIso(this.#clock);
      const existing = this.#generationLease(accountId, threadId, generationId);
      if (
        existing &&
        existing.owner_hash === proof.ownerHash &&
        Number(existing.fence) === proof.fence &&
        existing.released_at !== null
      ) {
        auditDispatchLease(existing);
        return dispatchLeaseView(existing, timestamp);
      }
      if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
        throw new ConflictError('Only the active in-progress generation can release a dispatch lease.');
      }
      const lease = this.#requireGenerationLease(
        accountId,
        threadId,
        generationId,
        proof,
        timestamp,
        ['claimed', 'dispatch_started']
      );
      const targetPhase = lease.phase === 'dispatch_started' ? 'interrupted' : 'released';
      const released = this.#invalidateGenerationLease(
        accountId,
        threadId,
        generationId,
        timestamp,
        targetPhase
      );
      return dispatchLeaseView(released, timestamp);
    });
  }

  appendGenerationDelta(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId', 'threadId', 'generationId', 'expectedSequence',
          'expectedHash', 'content'
        ],
        optional: ['dispatchLease']
      },
      'direct chat generation delta'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const expectedSequence = assertInteger(input.expectedSequence, 'expectedSequence', { min: 0 });
    const expectedHash = assertEventHash(input.expectedHash, expectedSequence, 'expectedHash');
    const content = assertUnicodeScalarString(input.content, 'content', {
      maxBytes: DIRECT_CHAT_LIMITS.deltaBytes
    });
    const dispatchLease = assertDispatchLeaseProof(input.dispatchLease);
    const sequence = expectedSequence + 1;
    return this.#transaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      const generation = requireGeneration(this.#database, accountId, threadId, generationId);
      this.#auditThread(thread);
      const timestamp = nowIso(this.#clock);
      this.#requireGenerationLease(
        accountId,
        threadId,
        generationId,
        dispatchLease,
        timestamp
      );
      const existing = this.#database.prepare(`
        SELECT * FROM direct_chat_deltas
        WHERE account_id = ? AND thread_id = ? AND generation_id = ? AND sequence = ?
      `).get(accountId, threadId, generationId, sequence);
      if (existing) {
        if (existing.content !== content.value || existing.previous_hash !== expectedHash) {
          throw new ConflictError('The generation sequence is already bound to a different hash or content.');
        }
        if (calculateDeltaHash(existing) !== existing.delta_hash) {
          throw new StorageCorruptionError('The naturally idempotent generation delta failed hash validation.');
        }
        return deltaView(existing);
      }
      if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
        throw new ConflictError('The generation is no longer in progress.');
      }
      if (
        Number(generation.delta_count) !== expectedSequence ||
        generation.last_delta_hash !== expectedHash
      ) {
        throw new ConflictError('The generation delta cursor is stale.');
      }
      if (sequence > DIRECT_CHAT_LIMITS.deltasPerGeneration) {
        throw new ConflictError('The generation reached its delta count limit.');
      }
      if (Number(generation.delta_bytes) + content.bytes > DIRECT_CHAT_LIMITS.generationBytes) {
        throw new ConflictError('The generation reached its output byte limit.');
      }
      if (Number(thread.journal_delta_count) >= DIRECT_CHAT_LIMITS.deltasPerThread) {
        throw new ConflictError('The thread reached its durable delta count limit; run bounded maintenance.');
      }
      if (Number(thread.journal_bytes) + content.bytes > DIRECT_CHAT_LIMITS.journalBytesPerThread) {
        throw new ConflictError('The thread reached its durable delta byte limit; run bounded maintenance.');
      }
      const row = {
        account_id: accountId,
        thread_id: threadId,
        generation_id: generationId,
        sequence,
        content: content.value,
        content_bytes: content.bytes,
        previous_hash: expectedHash,
        created_at: timestamp
      };
      row.delta_hash = calculateDeltaHash(row);
      this.#database.prepare(`
        INSERT INTO direct_chat_deltas(
          account_id, thread_id, generation_id, sequence, content, content_bytes,
          previous_hash, delta_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId, threadId, generationId, sequence, row.content, row.content_bytes,
        row.previous_hash, row.delta_hash, timestamp
      );
      const generationUpdated = this.#database.prepare(`
        UPDATE direct_chat_generations
        SET delta_count = delta_count + 1, delta_bytes = delta_bytes + ?,
            last_delta_hash = ?, updated_at = ?
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
          AND status = 'in_progress' AND delta_count = ? AND last_delta_hash IS ?
      `).run(
        content.bytes, row.delta_hash, timestamp,
        accountId, threadId, generationId, expectedSequence, expectedHash
      );
      const threadUpdated = this.#database.prepare(`
        UPDATE direct_chat_threads
        SET journal_delta_count = journal_delta_count + 1,
            journal_bytes = journal_bytes + ?, updated_at = ?
        WHERE account_id = ? AND thread_id = ? AND current_generation_id = ?
      `).run(content.bytes, timestamp, accountId, threadId, generationId);
      if (Number(generationUpdated.changes) !== 1 || Number(threadUpdated.changes) !== 1) {
        throw new ConflictError('The generation changed concurrently.');
      }
      return deltaView(row);
    });
  }

  finalizeGeneration(input) {
    assertExactKeys(
      input,
      {
        required: ['accountId', 'threadId', 'generationId', 'idempotencyKey'],
        optional: ['dispatchLease']
      },
      'direct chat generation finalization'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const dispatchLease = assertDispatchLeaseProof(input.dispatchLease);
    const request = { accountId, threadId, generationId };
    if (dispatchLease !== null) request.dispatchLease = dispatchLease;
    const replayGeneration = () => generationView(
      requireGeneration(this.#database, accountId, threadId, generationId)
    );

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: 'generation.finalize',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'generation',
        resourceId: generationId,
        versionOf: statusVersion,
        digestOf: terminalGenerationDigestInput
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        const generation = requireGeneration(this.#database, accountId, threadId, generationId);
        const timestamp = nowIso(this.#clock);
        this.#requireGenerationLease(
          accountId,
          threadId,
          generationId,
          dispatchLease,
          timestamp
        );
        if (generation.status === 'completed') return generationView(generation);
        if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
          throw new ConflictError('Only an in-progress generation can be finalized.');
        }
        if (Number(generation.delta_count) === 0) {
          throw new ConflictError('An empty generation cannot become an assistant ledger turn.');
        }
        if (
          Number(thread.ledger_revision) !== Number(generation.source_revision) ||
          thread.ledger_hash !== generation.source_hash
        ) {
          throw new ConflictError('The chat ledger changed after generation began.');
        }
        if (Number(thread.message_count) >= DIRECT_CHAT_LIMITS.messagesPerThread) {
          throw new ConflictError('The direct-chat thread reached its message limit.');
        }
        const deltas = auditGeneration(this.#database, generation);
        const content = deltas.map((delta) => delta.content).join('');
        const contentBytes = utf8Bytes(content);
        if (
          contentBytes !== Number(generation.delta_bytes) ||
          contentBytes < 1 ||
          contentBytes > DIRECT_CHAT_LIMITS.messageBytes ||
          Number(thread.ledger_bytes) + contentBytes > DIRECT_CHAT_LIMITS.ledgerBytesPerThread
        ) {
          throw new ConflictError('The completed generation cannot fit in the append-only chat ledger.');
        }
        const message = {
          account_id: accountId,
          thread_id: threadId,
          message_id: generation.assistant_message_id,
          revision: Number(generation.source_revision) + 1,
          role: 'assistant',
          content,
          content_bytes: contentBytes,
          previous_hash: generation.source_hash,
          generation_id: generationId,
          created_at: timestamp
        };
        message.message_hash = calculateMessageHash(message);
        this.#database.prepare(`
          INSERT INTO direct_chat_messages(
            account_id, thread_id, message_id, revision, role, content, content_bytes,
            previous_hash, message_hash, generation_id, created_at
          ) VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)
        `).run(
          accountId, threadId, message.message_id, message.revision, content, contentBytes,
          message.previous_hash, message.message_hash, generationId, timestamp
        );
        const generationUpdated = this.#database.prepare(`
          UPDATE direct_chat_generations
          SET status = 'completed', final_revision = ?, final_hash = ?,
              updated_at = ?, terminal_at = ?
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
            AND status = 'in_progress'
        `).run(
          message.revision, message.message_hash, timestamp, timestamp,
          accountId, threadId, generationId
        );
        const threadUpdated = this.#database.prepare(`
          UPDATE direct_chat_threads
          SET ledger_revision = ?, ledger_hash = ?, message_count = message_count + 1,
              ledger_bytes = ledger_bytes + ?, current_generation_id = NULL, updated_at = ?
          WHERE account_id = ? AND thread_id = ? AND current_generation_id = ?
            AND ledger_revision = ? AND ledger_hash = ?
        `).run(
          message.revision, message.message_hash, contentBytes, timestamp,
          accountId, threadId, generationId,
          generation.source_revision, generation.source_hash
        );
        if (Number(generationUpdated.changes) !== 1 || Number(threadUpdated.changes) !== 1) {
          throw new ConflictError('The generation changed concurrently.');
        }
        this.#invalidateGenerationLease(accountId, threadId, generationId, timestamp);
        return generationView(requireGeneration(this.#database, accountId, threadId, generationId));
      },
      replayGeneration
    );
  }

  cancelGeneration(input) {
    return this.#terminateGeneration(input, 'cancelled');
  }

  failGeneration(input) {
    return this.#terminateGeneration(input, 'failed');
  }

  #terminateGeneration(input, targetStatus) {
    const required = targetStatus === 'failed'
      ? ['accountId', 'threadId', 'generationId', 'failureCode', 'idempotencyKey']
      : ['accountId', 'threadId', 'generationId', 'idempotencyKey'];
    const optional = targetStatus === 'failed' ? ['dispatchLease'] : [];
    assertExactKeys(input, { required, optional }, `direct chat generation ${targetStatus}`);
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const failureCode = targetStatus === 'failed' ? assertFailureCode(input.failureCode) : null;
    const dispatchLease = targetStatus === 'failed'
      ? assertDispatchLeaseProof(input.dispatchLease)
      : null;
    const request = { accountId, threadId, generationId, failureCode };
    if (dispatchLease !== null) request.dispatchLease = dispatchLease;
    const replayGeneration = () => generationView(
      requireGeneration(this.#database, accountId, threadId, generationId)
    );

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: `generation.${targetStatus === 'cancelled' ? 'cancel' : 'fail'}`,
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'generation',
        resourceId: generationId,
        versionOf: statusVersion,
        digestOf: terminalGenerationDigestInput
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        const generation = requireGeneration(this.#database, accountId, threadId, generationId);
        const timestamp = nowIso(this.#clock);
        if (targetStatus === 'failed') {
          const lease = this.#generationLease(accountId, threadId, generationId);
          if (
            dispatchLease === null && lease !== null &&
            lease.phase === 'interrupted' && lease.released_at !== null &&
            failureCode === 'provider_unavailable'
          ) {
            auditDispatchLease(lease);
          } else {
            this.#requireGenerationLease(
              accountId,
              threadId,
              generationId,
              dispatchLease,
              timestamp,
              dispatchLease !== null && PRE_DISPATCH_FAILURE_CODES.has(failureCode)
                ? ['claimed', 'dispatch_started']
                : ['dispatch_started']
            );
          }
        }
        if (generation.status === targetStatus) {
          if (generation.failure_code !== failureCode) {
            throw new ConflictError('The terminal generation has a different failure category.');
          }
          return generationView(generation);
        }
        if (generation.status !== 'in_progress' || thread.current_generation_id !== generationId) {
          throw new ConflictError('Only an in-progress generation can be terminated.');
        }
        const generationUpdated = this.#database.prepare(`
          UPDATE direct_chat_generations
          SET status = ?, failure_code = ?, updated_at = ?, terminal_at = ?
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
            AND status = 'in_progress'
        `).run(
          targetStatus, failureCode, timestamp, timestamp,
          accountId, threadId, generationId
        );
        const threadUpdated = this.#database.prepare(`
          UPDATE direct_chat_threads SET current_generation_id = NULL, updated_at = ?
          WHERE account_id = ? AND thread_id = ? AND current_generation_id = ?
        `).run(timestamp, accountId, threadId, generationId);
        if (Number(generationUpdated.changes) !== 1 || Number(threadUpdated.changes) !== 1) {
          throw new ConflictError('The generation changed concurrently.');
        }
        this.#invalidateGenerationLease(accountId, threadId, generationId, timestamp);
        return generationView(requireGeneration(this.#database, accountId, threadId, generationId));
      },
      replayGeneration
    );
  }

  getGeneration(input) {
    this.#assertOpen();
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'generationId'] },
      'direct chat generation lookup'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    return this.#readTransaction(() => {
      const thread = this.#database.prepare(`
        SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!thread) return null;
      this.#auditThread(thread);
      const row = this.#database.prepare(`
        SELECT * FROM direct_chat_generations
        WHERE account_id = ? AND thread_id = ? AND generation_id = ?
      `).get(accountId, threadId, generationId);
      if (!row) return null;
      return generationView(row);
    });
  }

  replayGeneration(input) {
    this.#assertOpen();
    assertExactKeys(
      input,
      {
        required: ['accountId', 'threadId', 'generationId'],
        optional: ['afterSequence', 'limit']
      },
      'direct chat generation replay'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const generationId = assertIdentifier(input.generationId, 'generationId');
    const afterSequence = assertInteger(input.afterSequence ?? 0, 'afterSequence', { min: 0 });
    const limit = assertInteger(input.limit ?? 200, 'limit', { min: 1, max: DIRECT_CHAT_LIMITS.listPage });
    return this.#readTransaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      const generation = requireGeneration(this.#database, accountId, threadId, generationId);
      const rows = this.#database.prepare(`
        SELECT * FROM direct_chat_deltas
        WHERE account_id = ? AND thread_id = ? AND generation_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?
      `).all(accountId, threadId, generationId, afterSequence, limit);
      return {
        generation: generationView(generation),
        deltas: rows.map(deltaView),
        hasMore: rows.length === limit && Number(rows[rows.length - 1].sequence) < Number(generation.delta_count)
      };
    });
  }

  listMessages(input) {
    this.#assertOpen();
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId'], optional: ['afterRevision', 'limit'] },
      'direct chat message query'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const afterRevision = assertInteger(input.afterRevision ?? 0, 'afterRevision', { min: 0 });
    const limit = assertInteger(input.limit ?? 100, 'limit', { min: 1, max: DIRECT_CHAT_LIMITS.listPage });
    return this.#readTransaction(() => {
      const thread = requireThread(this.#database, accountId, threadId);
      this.#auditThread(thread);
      const rows = this.#database.prepare(`
        SELECT * FROM direct_chat_messages
        WHERE account_id = ? AND thread_id = ? AND revision > ?
        ORDER BY revision
        LIMIT ?
      `).all(accountId, threadId, afterRevision, limit);
      if (this.#schemaVersion < 3 || rows.length === 0) return rows.map((row) => messageView(row));
      const attachmentRows = this.#database.prepare(`
        SELECT attachment.account_id, attachment.thread_id, attachment.attachment_id,
               attachment.message_id, attachment.position, attachment.media_type, attachment.byte_length,
               attachment.width, attachment.height, attachment.content_sha256,
               attachment.created_at, length(attachment.content) AS content_length
        FROM direct_chat_attachments AS attachment
        JOIN direct_chat_messages AS message
          ON message.account_id = attachment.account_id
         AND message.thread_id = attachment.thread_id
         AND message.message_id = attachment.message_id
        WHERE attachment.account_id = ? AND attachment.thread_id = ?
          AND message.revision > ? AND message.revision <= ?
        ORDER BY message.revision, attachment.position
      `).all(accountId, threadId, afterRevision, Number(rows.at(-1).revision));
      const byMessage = new Map();
      for (const row of attachmentRows) {
        const attachment = attachmentDescriptorFromRow(row);
        const owned = byMessage.get(attachment.messageId) ?? [];
        owned.push(attachment);
        byMessage.set(attachment.messageId, owned);
      }
      return rows.map((row) => messageView(row, byMessage.get(row.message_id) ?? []));
    });
  }

  getVisionAttachment(input) {
    this.#assertOpen();
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'attachmentId'] },
      'direct chat vision attachment lookup'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const attachmentId = assertIdentifier(input.attachmentId, 'attachmentId');
    if (this.#schemaVersion < 3) return null;
    return this.#readTransaction(() => {
      const thread = this.#database.prepare(`
        SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!thread) return null;
      this.#auditThread(thread);
      return attachmentFromRow(this.#database.prepare(`
        SELECT * FROM direct_chat_attachments
        WHERE account_id = ? AND thread_id = ? AND attachment_id = ?
      `).get(accountId, threadId, attachmentId));
    });
  }

  getLatestVisionAttachments(input) {
    this.#assertOpen();
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'sourceRevision'] },
      'latest direct chat vision attachments lookup'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const sourceRevision = assertInteger(input.sourceRevision, 'sourceRevision', { min: 1, max: 2_000 });
    if (this.#schemaVersion < 3) return Object.freeze([]);
    return this.#readTransaction(() => {
      const thread = this.#database.prepare(`
        SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!thread) return Object.freeze([]);
      this.#auditThread(thread);
      const owner = this.#database.prepare(`
        SELECT attachment.message_id
        FROM direct_chat_attachments AS attachment
        JOIN direct_chat_messages AS message
          ON message.account_id = attachment.account_id
         AND message.thread_id = attachment.thread_id
         AND message.message_id = attachment.message_id
        WHERE attachment.account_id = ? AND attachment.thread_id = ?
          AND message.revision <= ?
        ORDER BY message.revision DESC
        LIMIT 1
      `).get(accountId, threadId, sourceRevision);
      if (!owner) return Object.freeze([]);
      return Object.freeze(this.#database.prepare(`
        SELECT * FROM direct_chat_attachments
        WHERE account_id = ? AND thread_id = ? AND message_id = ?
        ORDER BY position
      `).all(accountId, threadId, owner.message_id).map(attachmentFromRow));
    });
  }

  getLatestVisionAttachment(input) {
    const attachments = this.getLatestVisionAttachments(input);
    return attachments[0] ?? null;
  }

  createCompactionSnapshot(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId', 'threadId', 'snapshotId', 'sourceStartRevision',
          'sourceStartHash', 'sourceEndRevision', 'sourceEndHash',
          'summaryText', 'idempotencyKey'
        ]
      },
      'direct chat compaction snapshot'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const snapshotId = assertIdentifier(input.snapshotId, 'snapshotId');
    const sourceStartRevision = assertInteger(input.sourceStartRevision, 'sourceStartRevision', { min: 1 });
    const sourceEndRevision = assertInteger(input.sourceEndRevision, 'sourceEndRevision', {
      min: sourceStartRevision
    });
    const sourceStartHash = assertEventHash(input.sourceStartHash, sourceStartRevision, 'sourceStartHash');
    const sourceEndHash = assertEventHash(input.sourceEndHash, sourceEndRevision, 'sourceEndHash');
    const summary = assertUnicodeScalarString(input.summaryText, 'summaryText', {
      maxBytes: DIRECT_CHAT_LIMITS.summaryBytes
    });
    const summaryHash = sha256(summary.value);
    const request = {
      accountId, threadId, snapshotId, sourceStartRevision, sourceStartHash,
      sourceEndRevision, sourceEndHash, summaryText: summary.value
    };
    const replaySnapshot = () => {
      const row = this.#database.prepare(`
        SELECT * FROM direct_chat_compactions
        WHERE account_id = ? AND thread_id = ? AND snapshot_id = ?
      `).get(accountId, threadId, snapshotId);
      if (!row) throw new ConflictError('The idempotent compaction snapshot is no longer present.');
      return compactionView(row);
    };

    return this.#idempotentMutation(
      {
        accountId,
        threadId,
        operation: 'compaction.create',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'compaction',
        resourceId: snapshotId,
        versionOf: (result) => result.sourceEndRevision
      },
      () => {
        const thread = requireThread(this.#database, accountId, threadId);
        this.#auditThread(thread);
        const existing = this.#database.prepare(`
          SELECT * FROM direct_chat_compactions
          WHERE account_id = ? AND thread_id = ? AND snapshot_id = ?
        `).get(accountId, threadId, snapshotId);
        if (existing) {
          if (
            Number(existing.source_start_revision) !== sourceStartRevision ||
            existing.source_start_hash !== sourceStartHash ||
            Number(existing.source_end_revision) !== sourceEndRevision ||
            existing.source_end_hash !== sourceEndHash || existing.summary_text !== summary.value ||
            existing.summary_hash !== summaryHash
          ) {
            throw new ConflictError('The compaction snapshot identifier is already bound to different data.');
          }
          return compactionView(existing);
        }
        if (thread.current_generation_id !== null) {
          throw new ConflictError('A compaction snapshot cannot be recorded during an active generation.');
        }
        if (sourceEndRevision > Number(thread.ledger_revision)) {
          throw new ConflictError('The compaction range extends beyond the raw chat ledger.');
        }
        const count = Number(this.#database.prepare(`
          SELECT count(*) AS count FROM direct_chat_compactions
          WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId).count);
        if (count >= DIRECT_CHAT_LIMITS.compactionsPerThread) {
          throw new ConflictError('The thread reached its compaction snapshot limit.');
        }
        const endpoints = this.#database.prepare(`
          SELECT revision, message_hash FROM direct_chat_messages
          WHERE account_id = ? AND thread_id = ? AND revision IN (?, ?)
          ORDER BY revision
        `).all(accountId, threadId, sourceStartRevision, sourceEndRevision);
        const first = endpoints.find((row) => Number(row.revision) === sourceStartRevision);
        const last = endpoints.find((row) => Number(row.revision) === sourceEndRevision);
        if (!first || first.message_hash !== sourceStartHash || !last || last.message_hash !== sourceEndHash) {
          throw new ConflictError('The compaction snapshot hashes do not match the exact raw ledger range.');
        }
        const timestamp = nowIso(this.#clock);
        this.#database.prepare(`
          INSERT INTO direct_chat_compactions(
            account_id, thread_id, snapshot_id, source_start_revision, source_start_hash,
            source_end_revision, source_end_hash, summary_text, summary_bytes, summary_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          accountId, threadId, snapshotId, sourceStartRevision, sourceStartHash,
          sourceEndRevision, sourceEndHash, summary.value, summary.bytes, summaryHash, timestamp
        );
        return replaySnapshot();
      },
      replaySnapshot
    );
  }

  getLatestCompactionSnapshot(accountId, threadId) {
    this.#assertOpen();
    assertIdentifier(accountId, 'accountId');
    assertIdentifier(threadId, 'threadId');
    return this.#readTransaction(() => {
      const thread = this.#database.prepare(`
        SELECT * FROM direct_chat_threads WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!thread) return null;
      this.#auditThread(thread);
      return compactionView(this.#database.prepare(`
        SELECT * FROM direct_chat_compactions
        WHERE account_id = ? AND thread_id = ?
        ORDER BY source_end_revision DESC, created_at DESC, snapshot_id DESC
        LIMIT 1
      `).get(accountId, threadId));
    });
  }

  runMaintenance(input) {
    assertExactKeys(
      input,
      { required: ['accountId'], optional: ['terminalBefore', 'snapshotBefore', 'limit'] },
      'direct chat maintenance'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const timestamp = nowIso(this.#clock);
    const retentionCutoff = addMilliseconds(timestamp, -DIRECT_CHAT_TERMINAL_DELTA_RETENTION_MS);
    const requestedTerminalBefore = input.terminalBefore === undefined
      ? retentionCutoff
      : assertCanonicalIsoTimestamp(input.terminalBefore, 'terminalBefore');
    const terminalBefore = requestedTerminalBefore < retentionCutoff
      ? requestedTerminalBefore
      : retentionCutoff;
    const requestedSnapshotBefore = input.snapshotBefore === undefined
      ? timestamp
      : assertCanonicalIsoTimestamp(input.snapshotBefore, 'snapshotBefore');
    const snapshotBefore = requestedSnapshotBefore < timestamp ? requestedSnapshotBefore : timestamp;
    const limit = assertInteger(input.limit ?? DIRECT_CHAT_LIMITS.cleanupRows, 'limit', {
      min: 1,
      max: DIRECT_CHAT_LIMITS.cleanupRows
    });

    return this.#transaction(() => {
      let remaining = limit;
      let terminalGenerationsPruned = 0;
      let deltaRowsRemoved = 0;
      let deltaBytesReleased = 0;
      let compactionSnapshotsRemoved = 0;
      const touchedThreads = new Set();

      const candidates = this.#database.prepare(`
        SELECT g.*
        FROM direct_chat_generations AS g
        WHERE g.account_id = ?
          AND g.status = 'completed'
          AND g.deltas_pruned = 0
          AND g.terminal_at <= ?
          AND EXISTS (
            SELECT 1 FROM direct_chat_generations AS newer
            WHERE newer.account_id = g.account_id
              AND newer.thread_id = g.thread_id
              AND newer.status = 'completed'
              AND (
                newer.terminal_at > g.terminal_at
                OR (newer.terminal_at = g.terminal_at AND newer.generation_id > g.generation_id)
              )
          )
        ORDER BY g.terminal_at, g.thread_id, g.generation_id
        LIMIT ?
      `).all(accountId, terminalBefore, remaining);
      for (const generation of candidates) {
        const thread = requireThread(this.#database, accountId, generation.thread_id);
        this.#auditThread(thread);
        const marked = this.#database.prepare(`
          UPDATE direct_chat_generations
          SET deltas_pruned = 1, pruned_at = ?
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
            AND status = 'completed' AND deltas_pruned = 0
        `).run(timestamp, accountId, generation.thread_id, generation.generation_id);
        if (Number(marked.changes) !== 1) {
          throw new ConflictError('A terminal generation changed during maintenance.');
        }
        const deleted = this.#database.prepare(`
          DELETE FROM direct_chat_deltas
          WHERE account_id = ? AND thread_id = ? AND generation_id = ?
        `).run(accountId, generation.thread_id, generation.generation_id);
        if (Number(deleted.changes) !== Number(generation.delta_count)) {
          throw new StorageCorruptionError('Terminal delta pruning removed an unexpected row count.');
        }
        const counters = this.#database.prepare(`
          UPDATE direct_chat_threads
          SET journal_delta_count = journal_delta_count - ?, journal_bytes = journal_bytes - ?
          WHERE account_id = ? AND thread_id = ?
            AND current_generation_id IS NOT ?
            AND journal_delta_count >= ? AND journal_bytes >= ?
        `).run(
          generation.delta_count,
          generation.delta_bytes,
          accountId,
          generation.thread_id,
          generation.generation_id,
          generation.delta_count,
          generation.delta_bytes
        );
        if (Number(counters.changes) !== 1) {
          throw new StorageCorruptionError('Terminal delta pruning could not safely release thread counters.');
        }
        terminalGenerationsPruned += 1;
        deltaRowsRemoved += Number(deleted.changes);
        deltaBytesReleased += Number(generation.delta_bytes);
        remaining -= 1;
        touchedThreads.add(generation.thread_id);
      }

      if (remaining > 0) {
        const snapshots = this.#database.prepare(`
          SELECT old.account_id, old.thread_id, old.snapshot_id
          FROM direct_chat_compactions AS old
          WHERE old.account_id = ? AND old.created_at <= ?
            AND EXISTS (
              SELECT 1 FROM direct_chat_compactions AS newer
              WHERE newer.account_id = old.account_id
                AND newer.thread_id = old.thread_id
                AND (
                  newer.source_end_revision > old.source_end_revision
                  OR (
                    newer.source_end_revision = old.source_end_revision
                    AND newer.created_at > old.created_at
                  )
                  OR (
                    newer.source_end_revision = old.source_end_revision
                    AND newer.created_at = old.created_at
                    AND newer.snapshot_id > old.snapshot_id
                  )
                )
            )
          ORDER BY old.created_at, old.thread_id, old.snapshot_id
          LIMIT ?
        `).all(accountId, snapshotBefore, remaining);
        for (const snapshot of snapshots) {
          const deleted = this.#database.prepare(`
            DELETE FROM direct_chat_compactions
            WHERE account_id = ? AND thread_id = ? AND snapshot_id = ?
          `).run(accountId, snapshot.thread_id, snapshot.snapshot_id);
          if (Number(deleted.changes) !== 1) {
            throw new ConflictError('A compaction snapshot changed during maintenance.');
          }
          compactionSnapshotsRemoved += 1;
          remaining -= 1;
          touchedThreads.add(snapshot.thread_id);
        }
      }

      const idempotencyReceiptsRemoved = remaining > 0
        ? this.#deleteExpiredReceipts(timestamp, remaining, accountId)
        : 0;
      for (const threadId of touchedThreads) {
        this.#auditThread(requireThread(this.#database, accountId, threadId));
      }
      return {
        terminalGenerationsPruned,
        deltaRowsRemoved,
        deltaBytesReleased,
        compactionSnapshotsRemoved,
        idempotencyReceiptsRemoved,
        chatMessagesRemoved: 0,
        activeGenerationsRemoved: 0
      };
    });
  }

  cleanupExpiredIdempotency(input = {}) {
    assertExactKeys(input, { optional: ['before', 'limit'] }, 'direct chat cleanup');
    const now = nowIso(this.#clock);
    const requestedBefore = input.before === undefined
      ? now
      : assertCanonicalIsoTimestamp(input.before, 'before');
    const before = requestedBefore < now ? requestedBefore : now;
    const limit = assertInteger(input.limit ?? DIRECT_CHAT_LIMITS.cleanupRows, 'limit', {
      min: 1,
      max: DIRECT_CHAT_LIMITS.cleanupRows
    });
    return this.#transaction(() => ({
      idempotencyReceiptsRemoved: this.#deleteExpiredReceipts(before, limit),
      chatRowsRemoved: 0
    }));
  }

  healthCheck() {
    this.#assertOpen();
    return checkOpenSqliteHealth(this.#database, {
      expectedApplicationId: CHAT_SQLITE_APPLICATION_ID,
      allowedSchemaVersions: [this.#schemaVersion]
    });
  }

  close() {
    if (this.#closed) return;
    try {
      assertSecureDatabaseFile(this.#databasePath);
    } finally {
      try {
        this.#database.close();
      } finally {
        this.#clearAuditedThreads();
        this.#closed = true;
      }
    }
  }
}
