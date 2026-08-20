import { createHash } from 'node:crypto';

import { StorageCorruptionError, UnsupportedSchemaError } from './errors.js';

export const SQLITE_APPLICATION_ID = 0x4c415757;

const INITIAL_SCHEMA = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 256),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (issuer, subject)
) STRICT;

CREATE TABLE browser_sessions (
  session_digest TEXT PRIMARY KEY CHECK (
    length(session_digest) = 64 AND session_digest NOT GLOB '*[^0-9a-f]*'
  ),
  account_id TEXT NOT NULL,
  csrf_digest TEXT NOT NULL CHECK (
    length(csrf_digest) = 64 AND csrf_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX browser_sessions_account_expiry
  ON browser_sessions(account_id, expires_at DESC);

CREATE TABLE thread_index (
  thread_id TEXT PRIMARY KEY CHECK (length(thread_id) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'aginti' CHECK (authority = 'aginti'),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  routing_node_id TEXT CHECK (routing_node_id IS NULL OR length(routing_node_id) BETWEEN 1 AND 128),
  authority_revision INTEGER CHECK (authority_revision IS NULL OR authority_revision >= 0),
  last_run_id TEXT CHECK (last_run_id IS NULL OR length(last_run_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (account_id, thread_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX thread_index_owner_updated
  ON thread_index(account_id, updated_at DESC, thread_id DESC);

CREATE TABLE run_cursors (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  last_event_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (last_seq = 0 AND last_event_hash IS NULL)
    OR (
      last_seq > 0
      AND length(last_event_hash) = 64
      AND last_event_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  UNIQUE (account_id, run_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES thread_index(account_id, thread_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX run_cursors_owner_thread_updated
  ON run_cursors(account_id, thread_id, updated_at DESC, run_id DESC);

CREATE TABLE idempotency_records (
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 128),
  key_hash TEXT NOT NULL CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  outcome_code TEXT NOT NULL CHECK (outcome_code = 'succeeded'),
  resource_kind TEXT NOT NULL CHECK (
    resource_kind IN ('account', 'browser_session', 'thread_index')
  ),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id, operation, key_hash),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idempotency_records_expiry
  ON idempotency_records(expires_at);

CREATE INDEX idempotency_records_owner_created
  ON idempotency_records(account_id, created_at DESC);
`;

function checksum(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'cloud_presentation_index',
    sql: INITIAL_SCHEMA,
    checksum: checksum(INITIAL_SCHEMA)
  })
]);

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1).version;

function pragmaInteger(database, pragma) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma];
  if (!Number.isSafeInteger(value)) {
    throw new StorageCorruptionError(`SQLite returned an invalid ${pragma} value.`);
  }
  return value;
}

function assertIntegrity(database) {
  const integrity = database.prepare('PRAGMA integrity_check').get();
  if (integrity?.integrity_check !== 'ok') {
    throw new StorageCorruptionError();
  }
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length !== 0) {
    throw new StorageCorruptionError('The control-plane database contains invalid ownership references.');
  }
}

function existingUserTables(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
}

function verifyMigrationLedger(database, currentVersion) {
  let rows;
  try {
    rows = database.prepare(`
      SELECT version, name, checksum
      FROM schema_migrations
      ORDER BY version
    `).all();
  } catch (error) {
    throw new StorageCorruptionError('The migration ledger is missing or unreadable.', { cause: error });
  }
  if (rows.length !== currentVersion) {
    throw new StorageCorruptionError('The migration ledger does not match the schema version.');
  }
  for (let index = 0; index < currentVersion; index += 1) {
    const expected = MIGRATIONS[index];
    const actual = rows[index];
    if (
      Number(actual?.version) !== expected.version ||
      actual?.name !== expected.name ||
      actual?.checksum !== expected.checksum
    ) {
      throw new StorageCorruptionError(`Migration ${expected.version} failed checksum validation.`);
    }
  }
}

export function applyMigrations(database, appliedAt) {
  assertIntegrity(database);

  const currentVersion = pragmaInteger(database, 'user_version');
  const applicationId = pragmaInteger(database, 'application_id');
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError();
  }
  if (currentVersion === 0 && applicationId === 0 && existingUserTables(database).length !== 0) {
    throw new StorageCorruptionError('Refusing to claim a non-empty, unidentified SQLite database.');
  }
  if (currentVersion > 0 && applicationId !== SQLITE_APPLICATION_ID) {
    throw new StorageCorruptionError('The database belongs to a different application.');
  }
  if (applicationId !== 0 && applicationId !== SQLITE_APPLICATION_ID) {
    throw new StorageCorruptionError('The database application identifier is not recognized.');
  }

  if (currentVersion > 0) verifyMigrationLedger(database, currentVersion);

  for (const migration of MIGRATIONS.slice(currentVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migration.checksum, appliedAt);
      database.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}`);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original migration failure.
      }
      throw new StorageCorruptionError(`Migration ${migration.version} could not be applied.`, { cause: error });
    }
  }

  verifyMigrationLedger(database, LATEST_SCHEMA_VERSION);
  assertIntegrity(database);
}
