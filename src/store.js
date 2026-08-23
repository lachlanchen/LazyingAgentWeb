import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  StorageCorruptionError,
  ValidationError
} from './errors.js';
import {
  LATEST_SCHEMA_VERSION,
  SQLITE_APPLICATION_ID,
  applyMigrations
} from './migrations.js';
import { checkOpenSqliteHealth } from './sqlite-health.js';
import { assertSecureDatabaseFile, prepareSecureDatabasePath } from './storage-path.js';
import {
  assertBoolean,
  assertBoundedString,
  assertCanonicalIsoTimestamp,
  assertEventHash,
  assertExactKeys,
  assertIdentifier,
  assertIdempotencyKey,
  assertInteger,
  canonicalJson,
  digestSecret,
  nowIso,
  sha256
} from './validation.js';

const DEFAULT_CLOCK = () => new Date();

export const IDEMPOTENCY_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_RECEIPTS_PER_ACCOUNT = 256;
export const MAX_BROWSER_SESSIONS_PER_ACCOUNT = 32;

function addMilliseconds(timestamp, milliseconds) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function pruneExpiredRows(database, timestamp) {
  const sessions = database.prepare(`
    DELETE FROM browser_sessions
    WHERE expires_at <= ? OR revoked_at IS NOT NULL
  `).run(timestamp);
  const receipts = database.prepare(`
    DELETE FROM idempotency_records WHERE expires_at <= ?
  `).run(timestamp);
  return {
    browserSessionsRemoved: Number(sessions.changes),
    idempotencyReceiptsRemoved: Number(receipts.changes)
  };
}

function accountView(row) {
  if (!row) return null;
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sessionView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at
  };
}

function threadView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    authority: row.authority,
    title: row.title,
    pinned: row.pinned === 1,
    routingNodeId: row.routing_node_id,
    authorityRevision: row.authority_revision,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  };
}

function cursorView(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    runId: row.run_id,
    lastSeq: Number(row.last_seq),
    lastEventHash: row.last_event_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('ERR_SQLITE_CONSTRAINT');
}

function secretDigestsEqual(first, second) {
  if (
    typeof first !== 'string' ||
    typeof second !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(first) ||
    !/^[a-f0-9]{64}$/u.test(second)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

function validateDisplayName(value) {
  if (value === undefined || value === null) return null;
  return assertBoundedString(value, 'displayName', { min: 1, max: 256 });
}

function validateThreadPatch(patch) {
  assertExactKeys(
    patch,
    { optional: ['title', 'pinned'] },
    'patch'
  );
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('patch must change at least one presentation field.');
  }
  const result = {};
  if (Object.hasOwn(patch, 'title')) {
    result.title = assertBoundedString(patch.title, 'patch.title', { min: 0, max: 120 });
  }
  if (Object.hasOwn(patch, 'pinned')) {
    result.pinned = assertBoolean(patch.pinned, 'patch.pinned');
  }
  return result;
}

function validateAuthorityMetadata(input) {
  const routingNodeId = input.routingNodeId === null
    ? null
    : assertIdentifier(input.routingNodeId, 'routingNodeId');
  const authorityRevision = input.authorityRevision === null
    ? null
    : assertInteger(input.authorityRevision, 'authorityRevision', { min: 0 });
  return { routingNodeId, authorityRevision };
}

export class CloudIndexStore {
  #clock;
  #closed = false;
  #database;
  #databasePath;

  constructor({ databasePath, clock = DEFAULT_CLOCK } = {}) {
    if (typeof clock !== 'function') throw new ValidationError('clock must be a function.');
    this.#clock = clock;
    this.#databasePath = prepareSecureDatabasePath(databasePath);

    let database;
    try {
      database = new DatabaseSync(this.#databasePath);
    } catch (error) {
      throw new StorageCorruptionError('SQLite could not open the control-plane database.', { cause: error });
    }

    try {
      database.enableLoadExtension(false);
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA temp_store = MEMORY;
        PRAGMA trusted_schema = OFF;
        PRAGMA secure_delete = ON;
      `);
      applyMigrations(database, nowIso(this.#clock));
      database.exec('BEGIN IMMEDIATE');
      try {
        pruneExpiredRows(database, nowIso(this.#clock));
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the retention failure.
        }
        throw error;
      }
      assertSecureDatabaseFile(this.#databasePath);
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the validation failure.
      }
      if (
        error instanceof StorageCorruptionError ||
        error?.code === 'unsupported_schema' ||
        error?.code === 'storage_security_error' ||
        error?.code === 'invalid_input'
      ) {
        throw error;
      }
      throw new StorageCorruptionError('The control-plane database could not be initialized safely.', { cause: error });
    }

    this.#database = database;
  }

  #assertOpen() {
    if (this.#closed) throw new StorageCorruptionError('The control-plane database is closed.');
  }

  #transaction(callback) {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
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
  }

  #idempotentMutation(
    { accountId, operation, idempotencyKey, request, resourceKind, resourceId },
    mutation,
    replay
  ) {
    assertIdentifier(accountId, 'accountId');
    assertBoundedString(operation, 'operation', { min: 1, max: 128 });
    assertIdempotencyKey(idempotencyKey);
    if (!['account', 'browser_session', 'thread_index'].includes(resourceKind)) {
      throw new ValidationError('resourceKind is not a supported idempotency receipt type.');
    }
    assertIdentifier(resourceId, 'resourceId');
    if (typeof replay !== 'function') throw new ValidationError('An idempotency replay function is required.');
    const keyHash = sha256(idempotencyKey);
    const requestHash = sha256(canonicalJson(request));
    const receiptTimestamp = nowIso(this.#clock);
    const receiptExpiresAt = addMilliseconds(receiptTimestamp, IDEMPOTENCY_RECEIPT_TTL_MS);

    return this.#transaction(() => {
      pruneExpiredRows(this.#database, receiptTimestamp);
      const existing = this.#database.prepare(`
        SELECT request_hash, outcome_code, resource_kind, resource_id, result_digest
        FROM idempotency_records
        WHERE account_id = ? AND operation = ? AND key_hash = ?
      `).get(accountId, operation, keyHash);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new IdempotencyConflictError();
        if (
          existing.outcome_code !== 'succeeded' ||
          existing.resource_kind !== resourceKind ||
          existing.resource_id !== resourceId ||
          typeof existing.result_digest !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(existing.result_digest)
        ) {
          throw new StorageCorruptionError('An idempotency receipt failed closed-schema validation.');
        }
        const replayResult = replay(existing);
        const replayDigest = sha256(canonicalJson(replayResult));
        if (replayDigest !== existing.result_digest) {
          throw new ConflictError('The original idempotent response can no longer be replayed exactly.');
        }
        return replayResult;
      }

      const result = mutation();
      const resultDigest = sha256(canonicalJson(result));
      this.#database.prepare(`
        INSERT INTO idempotency_records(
          account_id, operation, key_hash, request_hash, outcome_code,
          resource_kind, resource_id, result_digest, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)
      `).run(
        accountId,
        operation,
        keyHash,
        requestHash,
        resourceKind,
        resourceId,
        resultDigest,
        receiptTimestamp,
        receiptExpiresAt
      );
      this.#database.prepare(`
        DELETE FROM idempotency_records
        WHERE rowid IN (
          SELECT rowid
          FROM idempotency_records
          WHERE account_id = ?
          ORDER BY rowid DESC
          LIMIT -1 OFFSET ?
        )
      `).run(accountId, MAX_IDEMPOTENCY_RECEIPTS_PER_ACCOUNT);
      return result;
    });
  }

  #assertAccountExists(accountId) {
    const row = this.#database.prepare('SELECT 1 AS present FROM accounts WHERE id = ?').get(accountId);
    if (!row) throw new NotFoundError();
  }

  provisionAccount(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'issuer', 'subject', 'idempotencyKey'], optional: ['displayName'] },
      'account'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const issuer = assertBoundedString(input.issuer, 'issuer', { min: 1, max: 256 });
    const subject = assertBoundedString(input.subject, 'subject', { min: 1, max: 512 });
    const displayName = validateDisplayName(input.displayName);
    const request = { accountId, issuer, subject, displayName };

    return this.#idempotentMutation(
      {
        accountId,
        operation: 'account.provision',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'account',
        resourceId: accountId
      },
      () => {
        const byId = this.#database.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
        if (byId) {
          if (byId.issuer !== issuer || byId.subject !== subject) throw new ConflictError();
          return accountView(byId);
        }
        const byIdentity = this.#database.prepare(`
          SELECT id FROM accounts WHERE issuer = ? AND subject = ?
        `).get(issuer, subject);
        if (byIdentity) throw new ConflictError();
        const timestamp = nowIso(this.#clock);
        try {
          this.#database.prepare(`
            INSERT INTO accounts(id, issuer, subject, display_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(accountId, issuer, subject, displayName, timestamp, timestamp);
        } catch (error) {
          if (isConstraintError(error)) throw new ConflictError();
          throw error;
        }
        return accountView(this.#database.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
      },
      () => {
        const row = accountView(this.#database.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
        if (!row) throw new ConflictError('The idempotent account resource is no longer present.');
        return row;
      }
    );
  }

  getAccount(accountId) {
    this.#assertOpen();
    assertIdentifier(accountId, 'accountId');
    return accountView(this.#database.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
  }

  resolveAccountIdentity(input) {
    this.#assertOpen();
    assertExactKeys(input, { required: ['issuer', 'subject'] }, 'identity');
    const issuer = assertBoundedString(input.issuer, 'issuer', { min: 1, max: 256 });
    const subject = assertBoundedString(input.subject, 'subject', { min: 1, max: 512 });
    return accountView(this.#database.prepare(`
      SELECT * FROM accounts WHERE issuer = ? AND subject = ?
    `).get(issuer, subject));
  }

  createBrowserSession(input) {
    assertExactKeys(
      input,
      {
        required: ['accountId', 'sessionToken', 'csrfToken', 'expiresAt', 'idempotencyKey']
      },
      'browser session'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const sessionDigest = digestSecret(input.sessionToken, 'sessionToken');
    const csrfDigest = digestSecret(input.csrfToken, 'csrfToken');
    const expiresAt = assertCanonicalIsoTimestamp(input.expiresAt, 'expiresAt');
    const request = { accountId, sessionDigest, csrfDigest, expiresAt };

    return this.#idempotentMutation(
      {
        accountId,
        operation: 'browser_session.create',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'browser_session',
        resourceId: sessionDigest
      },
      () => {
        this.#assertAccountExists(accountId);
        const timestamp = nowIso(this.#clock);
        if (expiresAt <= timestamp) throw new ValidationError('expiresAt must be in the future.');
        const sessionCount = Number(this.#database.prepare(`
          SELECT count(*) AS count
          FROM browser_sessions
          WHERE account_id = ?
        `).get(accountId)?.count);
        if (sessionCount >= MAX_BROWSER_SESSIONS_PER_ACCOUNT) {
          throw new ConflictError('The account has reached the active browser-session limit.');
        }
        try {
          this.#database.prepare(`
            INSERT INTO browser_sessions(
              session_digest, account_id, csrf_digest, created_at, expires_at, last_seen_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          `).run(sessionDigest, accountId, csrfDigest, timestamp, expiresAt, timestamp);
        } catch (error) {
          if (isConstraintError(error)) throw new ConflictError();
          throw error;
        }
        return sessionView(this.#database.prepare(`
          SELECT * FROM browser_sessions
          WHERE session_digest = ? AND account_id = ?
        `).get(sessionDigest, accountId));
      },
      () => {
        const row = sessionView(this.#database.prepare(`
          SELECT * FROM browser_sessions WHERE account_id = ? AND session_digest = ?
        `).get(accountId, sessionDigest));
        if (!row) throw new ConflictError('The idempotent browser session is no longer present.');
        return row;
      }
    );
  }

  #authenticateBrowserSession(input, requireCsrf) {
    this.#assertOpen();
    assertExactKeys(
      input,
      requireCsrf ? { required: ['sessionToken', 'csrfToken'] } : { required: ['sessionToken'] },
      'browser authentication'
    );
    const sessionDigest = digestSecret(input.sessionToken, 'sessionToken');
    const row = this.#database.prepare(`
      SELECT * FROM browser_sessions
      WHERE session_digest = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(sessionDigest, nowIso(this.#clock));
    if (!row) return null;
    if (requireCsrf) {
      const csrfDigest = digestSecret(input.csrfToken, 'csrfToken');
      if (!secretDigestsEqual(row.csrf_digest, csrfDigest)) return null;
    }
    return sessionView(row);
  }

  authenticateBrowserSession(input) {
    return this.#authenticateBrowserSession(input, false);
  }

  authenticateBrowserMutation(input) {
    return this.#authenticateBrowserSession(input, true);
  }

  revokeBrowserSession(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'sessionToken', 'idempotencyKey'] },
      'browser session revocation'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const sessionDigest = digestSecret(input.sessionToken, 'sessionToken');
    const request = { accountId, sessionDigest };
    return this.#idempotentMutation(
      {
        accountId,
        operation: 'browser_session.revoke',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'browser_session',
        resourceId: sessionDigest
      },
      () => {
        const row = this.#database.prepare(`
          SELECT * FROM browser_sessions WHERE account_id = ? AND session_digest = ?
        `).get(accountId, sessionDigest);
        if (!row) throw new NotFoundError();
        this.#database.prepare(`
          DELETE FROM browser_sessions
          WHERE account_id = ? AND session_digest = ?
        `).run(accountId, sessionDigest);
        return { accountId, revoked: true };
      },
      () => ({ accountId, revoked: true })
    );
  }

  registerThread(input) {
    assertExactKeys(
      input,
      {
        required: ['accountId', 'threadId', 'idempotencyKey'],
        optional: ['title', 'pinned', 'routingNodeId', 'authorityRevision']
      },
      'thread index'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const title = input.title === undefined
      ? ''
      : assertBoundedString(input.title, 'title', { min: 0, max: 120 });
    const pinned = input.pinned === undefined ? false : assertBoolean(input.pinned, 'pinned');
    const routingNodeId = input.routingNodeId === undefined || input.routingNodeId === null
      ? null
      : assertIdentifier(input.routingNodeId, 'routingNodeId');
    const authorityRevision = input.authorityRevision === undefined || input.authorityRevision === null
      ? null
      : assertInteger(input.authorityRevision, 'authorityRevision', { min: 0 });
    const request = {
      accountId,
      threadId,
      title,
      pinned,
      routingNodeId,
      authorityRevision
    };

    return this.#idempotentMutation(
      {
        accountId,
        operation: 'thread.register',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'thread_index',
        resourceId: threadId
      },
      () => {
        this.#assertAccountExists(accountId);
        const existing = this.#database.prepare('SELECT 1 AS present FROM thread_index WHERE thread_id = ?').get(threadId);
        if (existing) throw new ConflictError();
        const timestamp = nowIso(this.#clock);
        try {
          this.#database.prepare(`
            INSERT INTO thread_index(
              thread_id, account_id, authority, title, pinned, routing_node_id,
              authority_revision, last_run_id, created_at, updated_at, last_seen_at
            ) VALUES (?, ?, 'aginti', ?, ?, ?, ?, NULL, ?, ?, ?)
          `).run(
            threadId,
            accountId,
            title,
            pinned ? 1 : 0,
            routingNodeId,
            authorityRevision,
            timestamp,
            timestamp,
            timestamp
          );
        } catch (error) {
          if (isConstraintError(error)) throw new ConflictError();
          throw error;
        }
        return threadView(this.#database.prepare(`
          SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId));
      },
      () => {
        const row = threadView(this.#database.prepare(`
          SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId));
        if (!row) throw new ConflictError('The idempotent thread index is no longer present.');
        return row;
      }
    );
  }

  getThread(accountId, threadId) {
    this.#assertOpen();
    assertIdentifier(accountId, 'accountId');
    assertIdentifier(threadId, 'threadId');
    return threadView(this.#database.prepare(`
      SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
    `).get(accountId, threadId));
  }

  listThreads(input) {
    this.#assertOpen();
    assertExactKeys(input, { required: ['accountId'], optional: ['limit', 'before'] }, 'thread list');
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const limit = input.limit === undefined ? 50 : assertInteger(input.limit, 'limit', { min: 1, max: 100 });
    if (input.before === undefined || input.before === null) {
      return this.#database.prepare(`
        SELECT * FROM thread_index
        WHERE account_id = ?
        ORDER BY updated_at DESC, thread_id DESC
        LIMIT ?
      `).all(accountId, limit).map(threadView);
    }
    assertExactKeys(input.before, { required: ['updatedAt', 'threadId'] }, 'before');
    const updatedAt = assertCanonicalIsoTimestamp(input.before.updatedAt, 'before.updatedAt');
    const threadId = assertIdentifier(input.before.threadId, 'before.threadId');
    return this.#database.prepare(`
      SELECT * FROM thread_index
      WHERE account_id = ?
        AND (updated_at < ? OR (updated_at = ? AND thread_id < ?))
      ORDER BY updated_at DESC, thread_id DESC
      LIMIT ?
    `).all(accountId, updatedAt, updatedAt, threadId, limit).map(threadView);
  }

  updateThreadPresentation(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'patch', 'idempotencyKey'] },
      'thread update'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const patch = validateThreadPatch(input.patch);
    const request = { accountId, threadId, patch };

    return this.#idempotentMutation(
      {
        accountId,
        operation: 'thread.update',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'thread_index',
        resourceId: threadId
      },
      () => {
        const existing = this.#database.prepare(`
          SELECT 1 AS present FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId);
        if (!existing) throw new NotFoundError();

        const assignments = [];
        const values = [];
        if (Object.hasOwn(patch, 'title')) {
          assignments.push('title = ?');
          values.push(patch.title);
        }
        if (Object.hasOwn(patch, 'pinned')) {
          assignments.push('pinned = ?');
          values.push(patch.pinned ? 1 : 0);
        }
        const timestamp = nowIso(this.#clock);
        assignments.push('updated_at = ?', 'last_seen_at = ?');
        values.push(timestamp, timestamp, accountId, threadId);
        this.#database.prepare(`
          UPDATE thread_index SET ${assignments.join(', ')}
          WHERE account_id = ? AND thread_id = ?
        `).run(...values);
        return threadView(this.#database.prepare(`
          SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId));
      },
      () => {
        const row = threadView(this.#database.prepare(`
          SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId));
        if (!row) throw new ConflictError('The idempotent thread index is no longer present.');
        return row;
      }
    );
  }

  syncThreadAuthorityMetadataFromAginti(input) {
    assertExactKeys(
      input,
      {
        required: [
          'accountId',
          'threadId',
          'routingNodeId',
          'authorityRevision',
          'idempotencyKey'
        ]
      },
      'AgInTi thread metadata sync'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const { routingNodeId, authorityRevision } = validateAuthorityMetadata(input);
    const request = { accountId, threadId, routingNodeId, authorityRevision };

    return this.#idempotentMutation(
      {
        accountId,
        operation: 'thread.sync_aginti_metadata',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'thread_index',
        resourceId: threadId
      },
      () => {
        const timestamp = nowIso(this.#clock);
        const result = this.#database.prepare(`
          UPDATE thread_index
          SET routing_node_id = ?, authority_revision = ?,
              updated_at = ?, last_seen_at = ?
          WHERE account_id = ? AND thread_id = ?
        `).run(
          routingNodeId,
          authorityRevision,
          timestamp,
          timestamp,
          accountId,
          threadId
        );
        if (Number(result.changes) !== 1) throw new NotFoundError();
        return threadView(this.#database.prepare(`
          SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId));
      },
      () => {
        const row = threadView(this.#database.prepare(`
          SELECT * FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).get(accountId, threadId));
        if (!row) throw new ConflictError('The idempotent thread index is no longer present.');
        return row;
      }
    );
  }

  removeThreadIndex(input) {
    assertExactKeys(
      input,
      { required: ['accountId', 'threadId', 'idempotencyKey'] },
      'thread index removal'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const request = { accountId, threadId };
    return this.#idempotentMutation(
      {
        accountId,
        operation: 'thread.remove_index',
        idempotencyKey: input.idempotencyKey,
        request,
        resourceKind: 'thread_index',
        resourceId: threadId
      },
      () => {
        const result = this.#database.prepare(`
          DELETE FROM thread_index WHERE account_id = ? AND thread_id = ?
        `).run(accountId, threadId);
        if (Number(result.changes) !== 1) throw new NotFoundError();
        return { threadId, removedFromCloudIndex: true };
      },
      () => ({ threadId, removedFromCloudIndex: true })
    );
  }

  recordRunCursor(input) {
    assertExactKeys(
      input,
      {
        required: ['accountId', 'threadId', 'runId', 'lastSeq', 'lastEventHash']
      },
      'run cursor'
    );
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const runId = assertIdentifier(input.runId, 'runId');
    const lastSeq = assertInteger(input.lastSeq, 'lastSeq', { min: 0 });
    const lastEventHash = assertEventHash(input.lastEventHash, lastSeq);
    const retentionTimestamp = nowIso(this.#clock);

    return this.#transaction(() => {
      pruneExpiredRows(this.#database, retentionTimestamp);
      const thread = this.#database.prepare(`
        SELECT 1 AS present FROM thread_index WHERE account_id = ? AND thread_id = ?
      `).get(accountId, threadId);
      if (!thread) throw new NotFoundError();

      const existing = this.#database.prepare(`
        SELECT * FROM run_cursors WHERE account_id = ? AND run_id = ?
      `).get(accountId, runId);
      if (existing) {
        if (existing.thread_id !== threadId) throw new ConflictError();
        if (lastSeq < Number(existing.last_seq)) {
          throw new ConflictError('A delivery cursor must not move backwards.');
        }
        if (lastSeq === Number(existing.last_seq)) {
          if (existing.last_event_hash !== lastEventHash) {
            throw new ConflictError('A delivery sequence cannot be rebound to a different event hash.');
          }
          return cursorView(existing);
        }
      }

      const timestamp = nowIso(this.#clock);
      if (!existing) {
        const globalCollision = this.#database.prepare(`
          SELECT 1 AS present FROM run_cursors WHERE run_id = ?
        `).get(runId);
        if (globalCollision) throw new ConflictError();
        try {
          this.#database.prepare(`
            INSERT INTO run_cursors(
              run_id, account_id, thread_id, last_seq, last_event_hash,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            runId,
            accountId,
            threadId,
            lastSeq,
            lastEventHash,
            timestamp,
            timestamp
          );
        } catch (error) {
          if (isConstraintError(error)) throw new ConflictError();
          throw error;
        }
      } else {
        this.#database.prepare(`
          UPDATE run_cursors
          SET last_seq = ?, last_event_hash = ?, updated_at = ?
          WHERE account_id = ? AND run_id = ?
        `).run(lastSeq, lastEventHash, timestamp, accountId, runId);
      }
      this.#database.prepare(`
        UPDATE thread_index
        SET last_run_id = ?, updated_at = ?, last_seen_at = ?
        WHERE account_id = ? AND thread_id = ?
      `).run(runId, timestamp, timestamp, accountId, threadId);
      return cursorView(this.#database.prepare(`
        SELECT * FROM run_cursors WHERE account_id = ? AND run_id = ?
      `).get(accountId, runId));
    });
  }

  getRunCursor(accountId, runId) {
    this.#assertOpen();
    assertIdentifier(accountId, 'accountId');
    assertIdentifier(runId, 'runId');
    return cursorView(this.#database.prepare(`
      SELECT * FROM run_cursors WHERE account_id = ? AND run_id = ?
    `).get(accountId, runId));
  }

  listRunCursors(input) {
    this.#assertOpen();
    assertExactKeys(input, { required: ['accountId', 'threadId'], optional: ['limit'] }, 'run cursor list');
    const accountId = assertIdentifier(input.accountId, 'accountId');
    const threadId = assertIdentifier(input.threadId, 'threadId');
    const limit = input.limit === undefined ? 50 : assertInteger(input.limit, 'limit', { min: 1, max: 100 });
    return this.#database.prepare(`
      SELECT * FROM run_cursors
      WHERE account_id = ? AND thread_id = ?
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ?
    `).all(accountId, threadId, limit).map(cursorView);
  }

  pruneExpiredState() {
    const timestamp = nowIso(this.#clock);
    return this.#transaction(() => pruneExpiredRows(this.#database, timestamp));
  }

  healthCheck() {
    this.#assertOpen();
    return checkOpenSqliteHealth(this.#database, {
      expectedApplicationId: SQLITE_APPLICATION_ID,
      allowedSchemaVersions: [LATEST_SCHEMA_VERSION]
    });
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
