import { createHash } from 'node:crypto';

import { StorageCorruptionError, UnsupportedSchemaError } from './errors.js';

// "LADC" -- deliberately different from the Agent presentation-index database.
export const CHAT_SQLITE_APPLICATION_ID = 0x4c414443;

const INITIAL_CHAT_SCHEMA = `
CREATE TABLE chat_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE direct_chat_threads (
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  title TEXT NOT NULL DEFAULT '',
  title_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
    title_bytes BETWEEN 0 AND 512
    AND length(CAST(title AS BLOB)) = title_bytes
  ),
  model_alias TEXT NOT NULL CHECK (length(model_alias) BETWEEN 1 AND 64),
  ledger_revision INTEGER NOT NULL DEFAULT 0 CHECK (ledger_revision >= 0),
  ledger_hash TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  ledger_bytes INTEGER NOT NULL DEFAULT 0 CHECK (ledger_bytes >= 0),
  generation_count INTEGER NOT NULL DEFAULT 0 CHECK (generation_count BETWEEN 0 AND 1024),
  journal_delta_count INTEGER NOT NULL DEFAULT 0 CHECK (journal_delta_count BETWEEN 0 AND 32768),
  journal_bytes INTEGER NOT NULL DEFAULT 0 CHECK (journal_bytes BETWEEN 0 AND 16777216),
  current_generation_id TEXT CHECK (
    current_generation_id IS NULL OR length(current_generation_id) BETWEEN 1 AND 128
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id),
  CHECK (message_count = ledger_revision),
  CHECK (
    (ledger_revision = 0 AND ledger_hash IS NULL)
    OR (
      ledger_revision > 0
      AND length(ledger_hash) = 64
      AND ledger_hash NOT GLOB '*[^0-9a-f]*'
    )
  )
) STRICT;

CREATE INDEX direct_chat_threads_owner_updated
  ON direct_chat_threads(account_id, updated_at DESC, thread_id DESC);

CREATE TABLE direct_chat_messages (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (
    content_bytes BETWEEN 1 AND 65536
    AND length(CAST(content AS BLOB)) = content_bytes
  ),
  previous_hash TEXT,
  message_hash TEXT NOT NULL CHECK (
    length(message_hash) = 64 AND message_hash NOT GLOB '*[^0-9a-f]*'
  ),
  generation_id TEXT CHECK (
    generation_id IS NULL OR length(generation_id) BETWEEN 1 AND 128
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, message_id),
  UNIQUE (account_id, thread_id, revision),
  FOREIGN KEY (account_id, thread_id)
    REFERENCES direct_chat_threads(account_id, thread_id) ON DELETE RESTRICT,
  CHECK (
    (revision = 1 AND previous_hash IS NULL)
    OR (
      revision > 1
      AND length(previous_hash) = 64
      AND previous_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (role = 'user' AND generation_id IS NULL)
    OR (role = 'assistant' AND generation_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX direct_chat_messages_owner_revision
  ON direct_chat_messages(account_id, thread_id, revision);

CREATE TRIGGER direct_chat_messages_no_update
BEFORE UPDATE ON direct_chat_messages
BEGIN
  SELECT RAISE(ABORT, 'direct chat messages are append-only');
END;

CREATE TRIGGER direct_chat_messages_no_delete
BEFORE DELETE ON direct_chat_messages
BEGIN
  SELECT RAISE(ABORT, 'direct chat messages are append-only');
END;

CREATE TABLE direct_chat_generations (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation_id TEXT NOT NULL CHECK (length(generation_id) BETWEEN 1 AND 128),
  assistant_message_id TEXT NOT NULL CHECK (length(assistant_message_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'cancelled', 'failed')),
  model_alias TEXT NOT NULL CHECK (length(model_alias) BETWEEN 1 AND 64),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  source_hash TEXT NOT NULL CHECK (
    length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
  ),
  delta_count INTEGER NOT NULL DEFAULT 0 CHECK (delta_count BETWEEN 0 AND 8192),
  delta_bytes INTEGER NOT NULL DEFAULT 0 CHECK (delta_bytes BETWEEN 0 AND 65536),
  last_delta_hash TEXT,
  final_revision INTEGER CHECK (final_revision IS NULL OR final_revision >= 2),
  final_hash TEXT CHECK (
    final_hash IS NULL OR (
      length(final_hash) = 64 AND final_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'provider_unavailable', 'timeout', 'internal_error',
      'response_limit', 'content_rejected'
    )
  ),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  deltas_pruned INTEGER NOT NULL DEFAULT 0 CHECK (deltas_pruned IN (0, 1)),
  pruned_at TEXT,
  PRIMARY KEY (account_id, thread_id, generation_id),
  UNIQUE (account_id, thread_id, assistant_message_id),
  FOREIGN KEY (account_id, thread_id)
    REFERENCES direct_chat_threads(account_id, thread_id) ON DELETE RESTRICT,
  CHECK (
    (delta_count = 0 AND last_delta_hash IS NULL)
    OR (
      delta_count > 0
      AND length(last_delta_hash) = 64
      AND last_delta_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (status = 'in_progress' AND terminal_at IS NULL AND final_revision IS NULL
      AND final_hash IS NULL AND failure_code IS NULL
      AND deltas_pruned = 0 AND pruned_at IS NULL)
    OR (status = 'completed' AND terminal_at IS NOT NULL AND final_revision IS NOT NULL
      AND final_hash IS NOT NULL AND failure_code IS NULL
      AND ((deltas_pruned = 0 AND pruned_at IS NULL) OR (deltas_pruned = 1 AND pruned_at IS NOT NULL)))
    OR (status = 'cancelled' AND terminal_at IS NOT NULL AND final_revision IS NULL
      AND final_hash IS NULL AND failure_code IS NULL
      AND deltas_pruned = 0 AND pruned_at IS NULL)
    OR (status = 'failed' AND terminal_at IS NOT NULL AND final_revision IS NULL
      AND final_hash IS NULL AND failure_code IS NOT NULL
      AND deltas_pruned = 0 AND pruned_at IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX direct_chat_one_active_generation
  ON direct_chat_generations(account_id, thread_id)
  WHERE status = 'in_progress';

CREATE INDEX direct_chat_generations_owner_started
  ON direct_chat_generations(account_id, thread_id, started_at DESC, generation_id DESC);

CREATE TRIGGER direct_chat_generations_no_delete
BEFORE DELETE ON direct_chat_generations
BEGIN
  SELECT RAISE(ABORT, 'direct chat generation records are durable');
END;

CREATE TRIGGER direct_chat_generations_prune_only_superseded
BEFORE UPDATE OF deltas_pruned, pruned_at ON direct_chat_generations
WHEN OLD.deltas_pruned = 0 AND NEW.deltas_pruned = 1 AND NOT EXISTS (
  SELECT 1 FROM direct_chat_generations AS newer
  WHERE newer.account_id = OLD.account_id
    AND newer.thread_id = OLD.thread_id
    AND newer.status = 'completed'
    AND (
      newer.terminal_at > OLD.terminal_at
      OR (newer.terminal_at = OLD.terminal_at AND newer.generation_id > OLD.generation_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'only superseded completed generation deltas may be pruned');
END;

CREATE TRIGGER direct_chat_generations_prune_irreversible
BEFORE UPDATE OF deltas_pruned, pruned_at ON direct_chat_generations
WHEN OLD.deltas_pruned = 1 AND (
  NEW.deltas_pruned != OLD.deltas_pruned OR NEW.pruned_at IS NOT OLD.pruned_at
)
BEGIN
  SELECT RAISE(ABORT, 'direct chat generation pruning is irreversible');
END;

CREATE TABLE direct_chat_deltas (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  content TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (
    content_bytes BETWEEN 1 AND 16384
    AND length(CAST(content AS BLOB)) = content_bytes
  ),
  previous_hash TEXT,
  delta_hash TEXT NOT NULL CHECK (
    length(delta_hash) = 64 AND delta_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, generation_id, sequence),
  FOREIGN KEY (account_id, thread_id, generation_id)
    REFERENCES direct_chat_generations(account_id, thread_id, generation_id) ON DELETE RESTRICT,
  CHECK (
    (sequence = 1 AND previous_hash IS NULL)
    OR (
      sequence > 1
      AND length(previous_hash) = 64
      AND previous_hash NOT GLOB '*[^0-9a-f]*'
    )
  )
) STRICT;

CREATE INDEX direct_chat_deltas_replay
  ON direct_chat_deltas(account_id, thread_id, generation_id, sequence);

CREATE TRIGGER direct_chat_deltas_no_update
BEFORE UPDATE ON direct_chat_deltas
BEGIN
  SELECT RAISE(ABORT, 'direct chat deltas are append-only');
END;

CREATE TRIGGER direct_chat_deltas_no_delete
BEFORE DELETE ON direct_chat_deltas
WHEN NOT EXISTS (
  SELECT 1 FROM direct_chat_generations
  WHERE account_id = OLD.account_id
    AND thread_id = OLD.thread_id
    AND generation_id = OLD.generation_id
    AND status = 'completed'
    AND deltas_pruned = 1
    AND EXISTS (
      SELECT 1 FROM direct_chat_generations AS newer
      WHERE newer.account_id = OLD.account_id
        AND newer.thread_id = OLD.thread_id
        AND newer.status = 'completed'
        AND (
          newer.terminal_at > direct_chat_generations.terminal_at
          OR (
            newer.terminal_at = direct_chat_generations.terminal_at
            AND newer.generation_id > direct_chat_generations.generation_id
          )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'only safely retained terminal direct chat deltas may be pruned');
END;

CREATE TABLE direct_chat_compactions (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) BETWEEN 1 AND 128),
  source_start_revision INTEGER NOT NULL CHECK (source_start_revision >= 1),
  source_start_hash TEXT NOT NULL CHECK (
    length(source_start_hash) = 64 AND source_start_hash NOT GLOB '*[^0-9a-f]*'
  ),
  source_end_revision INTEGER NOT NULL CHECK (source_end_revision >= source_start_revision),
  source_end_hash TEXT NOT NULL CHECK (
    length(source_end_hash) = 64 AND source_end_hash NOT GLOB '*[^0-9a-f]*'
  ),
  summary_text TEXT NOT NULL,
  summary_bytes INTEGER NOT NULL CHECK (
    summary_bytes BETWEEN 1 AND 262144
    AND length(CAST(summary_text AS BLOB)) = summary_bytes
  ),
  summary_hash TEXT NOT NULL CHECK (
    length(summary_hash) = 64 AND summary_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, snapshot_id),
  FOREIGN KEY (account_id, thread_id)
    REFERENCES direct_chat_threads(account_id, thread_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX direct_chat_compactions_owner_range
  ON direct_chat_compactions(
    account_id, thread_id, source_end_revision DESC, created_at DESC, snapshot_id DESC
  );

CREATE TRIGGER direct_chat_compactions_no_update
BEFORE UPDATE ON direct_chat_compactions
BEGIN
  SELECT RAISE(ABORT, 'direct chat compaction snapshots are immutable');
END;

CREATE TRIGGER direct_chat_compactions_no_delete
BEFORE DELETE ON direct_chat_compactions
WHEN NOT EXISTS (
  SELECT 1 FROM direct_chat_compactions AS newer
  WHERE newer.account_id = OLD.account_id
    AND newer.thread_id = OLD.thread_id
    AND (
      newer.source_end_revision > OLD.source_end_revision
      OR (
        newer.source_end_revision = OLD.source_end_revision
        AND newer.created_at > OLD.created_at
      )
      OR (
        newer.source_end_revision = OLD.source_end_revision
        AND newer.created_at = OLD.created_at
        AND newer.snapshot_id > OLD.snapshot_id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'the current direct chat compaction snapshot cannot be pruned');
END;

CREATE TABLE direct_chat_idempotency (
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'thread.create', 'message.user.append', 'generation.start',
    'generation.finalize', 'generation.cancel',
    'generation.fail', 'compaction.create'
  )),
  key_hash TEXT NOT NULL CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  resource_kind TEXT NOT NULL CHECK (
    resource_kind IN ('thread', 'message', 'generation', 'compaction')
  ),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 0),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id, operation, key_hash),
  FOREIGN KEY (account_id, thread_id)
    REFERENCES direct_chat_threads(account_id, thread_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'thread.create' AND resource_kind = 'thread')
    OR (operation = 'message.user.append' AND resource_kind = 'message')
    OR (operation IN (
      'generation.start', 'generation.finalize', 'generation.cancel', 'generation.fail'
    ) AND resource_kind = 'generation')
    OR (operation = 'compaction.create' AND resource_kind = 'compaction')
  )
) STRICT;

CREATE INDEX direct_chat_idempotency_expiry
  ON direct_chat_idempotency(expires_at);

CREATE INDEX direct_chat_idempotency_owner_created
  ON direct_chat_idempotency(account_id, created_at DESC);
`;

const GENERATION_DISPATCH_LEASE_SCHEMA = `
CREATE TABLE direct_chat_generation_leases (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  owner_hash TEXT NOT NULL CHECK (
    length(owner_hash) = 64 AND owner_hash NOT GLOB '*[^0-9a-f]*'
  ),
  fence INTEGER NOT NULL CHECK (fence BETWEEN 1 AND 9007199254740991),
  phase TEXT NOT NULL CHECK (
    phase IN ('claimed', 'dispatch_started', 'released', 'interrupted')
  ),
  expires_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  dispatch_started_at TEXT,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (account_id, thread_id, generation_id),
  FOREIGN KEY (account_id, thread_id, generation_id)
    REFERENCES direct_chat_generations(account_id, thread_id, generation_id) ON DELETE RESTRICT,
  CHECK (
    (phase IN ('claimed', 'dispatch_started') AND released_at IS NULL)
    OR (phase IN ('released', 'interrupted') AND released_at = expires_at)
  ),
  CHECK (
    (phase = 'claimed' AND dispatch_started_at IS NULL)
    OR (phase = 'released')
    OR (phase IN ('dispatch_started', 'interrupted') AND dispatch_started_at IS NOT NULL)
  )
) STRICT;

-- LocalLLM inference is a workstation-wide scarce resource for this service.
-- A partial unique index on the fixed dispatch phase makes the one-active-
-- inference policy durable across overlapping BFF processes, not merely an
-- in-memory per-process convention.
CREATE UNIQUE INDEX direct_chat_one_active_dispatch
  ON direct_chat_generation_leases(phase)
  WHERE phase = 'dispatch_started' AND released_at IS NULL;

CREATE TRIGGER direct_chat_generation_leases_fence_monotonic
BEFORE UPDATE ON direct_chat_generation_leases
WHEN NEW.fence < OLD.fence
  OR NEW.fence > OLD.fence + 1
  OR (NEW.owner_hash != OLD.owner_hash AND NEW.fence != OLD.fence + 1)
  OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NULL AND NEW.fence != OLD.fence + 1)
  OR (OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'direct chat generation lease fence must advance monotonically');
END;

CREATE TRIGGER direct_chat_generation_leases_phase_monotonic
BEFORE UPDATE ON direct_chat_generation_leases
WHEN NOT (
  (OLD.phase = 'claimed' AND NEW.phase IN ('claimed', 'dispatch_started', 'released'))
  OR (OLD.phase = 'dispatch_started' AND NEW.phase IN ('dispatch_started', 'released', 'interrupted'))
  OR (
    OLD.phase = 'released' AND NEW.phase = 'released'
  )
  OR (
    OLD.phase = 'released' AND OLD.dispatch_started_at IS NULL
      AND NEW.phase = 'claimed' AND NEW.fence = OLD.fence + 1
  )
  OR (OLD.phase = 'interrupted' AND NEW.phase = 'interrupted')
)
BEGIN
  SELECT RAISE(ABORT, 'direct chat generation lease phase must advance monotonically');
END;

CREATE TRIGGER direct_chat_generation_leases_no_delete
BEFORE DELETE ON direct_chat_generation_leases
BEGIN
  SELECT RAISE(ABORT, 'direct chat generation lease fences are durable');
END;
`;

function checksum(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export const CHAT_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'standalone_direct_chat_ledger',
    sql: INITIAL_CHAT_SCHEMA,
    checksum: checksum(INITIAL_CHAT_SCHEMA)
  }),
  Object.freeze({
    version: 2,
    name: 'fenced_generation_dispatch_leases',
    sql: GENERATION_DISPATCH_LEASE_SCHEMA,
    checksum: checksum(GENERATION_DISPATCH_LEASE_SCHEMA)
  })
]);

export const LATEST_CHAT_SCHEMA_VERSION = CHAT_MIGRATIONS[CHAT_MIGRATIONS.length - 1].version;

const EXPECTED_SCHEMA_OBJECTS = Object.freeze([
  'index:direct_chat_compactions_owner_range:direct_chat_compactions',
  'index:direct_chat_deltas_replay:direct_chat_deltas',
  'index:direct_chat_generations_owner_started:direct_chat_generations',
  'index:direct_chat_idempotency_expiry:direct_chat_idempotency',
  'index:direct_chat_idempotency_owner_created:direct_chat_idempotency',
  'index:direct_chat_messages_owner_revision:direct_chat_messages',
  'index:direct_chat_one_active_dispatch:direct_chat_generation_leases',
  'index:direct_chat_one_active_generation:direct_chat_generations',
  'index:direct_chat_threads_owner_updated:direct_chat_threads',
  'table:chat_schema_migrations:chat_schema_migrations',
  'table:direct_chat_compactions:direct_chat_compactions',
  'table:direct_chat_deltas:direct_chat_deltas',
  'table:direct_chat_generation_leases:direct_chat_generation_leases',
  'table:direct_chat_generations:direct_chat_generations',
  'table:direct_chat_idempotency:direct_chat_idempotency',
  'table:direct_chat_messages:direct_chat_messages',
  'table:direct_chat_threads:direct_chat_threads',
  'trigger:direct_chat_compactions_no_delete:direct_chat_compactions',
  'trigger:direct_chat_compactions_no_update:direct_chat_compactions',
  'trigger:direct_chat_deltas_no_delete:direct_chat_deltas',
  'trigger:direct_chat_deltas_no_update:direct_chat_deltas',
  'trigger:direct_chat_generation_leases_fence_monotonic:direct_chat_generation_leases',
  'trigger:direct_chat_generation_leases_no_delete:direct_chat_generation_leases',
  'trigger:direct_chat_generation_leases_phase_monotonic:direct_chat_generation_leases',
  'trigger:direct_chat_generations_no_delete:direct_chat_generations',
  'trigger:direct_chat_generations_prune_irreversible:direct_chat_generations',
  'trigger:direct_chat_generations_prune_only_superseded:direct_chat_generations',
  'trigger:direct_chat_messages_no_delete:direct_chat_messages',
  'trigger:direct_chat_messages_no_update:direct_chat_messages'
]);

const EXPECTED_SCHEMA_FINGERPRINT = 'ad84514c28ac6762061439579862853249f6c87b613f81b79a20947d5c52d4d5';

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
    throw new StorageCorruptionError('The direct-chat database failed SQLite integrity validation.');
  }
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length !== 0) {
    throw new StorageCorruptionError('The direct-chat database contains invalid ownership references.');
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
      FROM chat_schema_migrations
      ORDER BY version
    `).all();
  } catch (error) {
    throw new StorageCorruptionError('The direct-chat migration ledger is missing or unreadable.', { cause: error });
  }
  if (rows.length !== currentVersion) {
    throw new StorageCorruptionError('The direct-chat migration ledger does not match the schema version.');
  }
  for (let index = 0; index < currentVersion; index += 1) {
    const expected = CHAT_MIGRATIONS[index];
    const actual = rows[index];
    if (
      Number(actual?.version) !== expected.version ||
      actual?.name !== expected.name ||
      actual?.checksum !== expected.checksum
    ) {
      throw new StorageCorruptionError(`Direct-chat migration ${expected.version} failed checksum validation.`);
    }
  }
}

function verifySchemaObjects(database) {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all();
  const actual = rows.map((row) => `${row.type}:${row.name}:${row.tbl_name}`);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_SCHEMA_OBJECTS)) {
    throw new StorageCorruptionError('The direct-chat schema object set is missing, altered, or extended.');
  }
  if (checksum(JSON.stringify(rows)) !== EXPECTED_SCHEMA_FINGERPRINT) {
    throw new StorageCorruptionError('The direct-chat schema definition fingerprint does not match.');
  }
}

export function applyChatMigrations(database, appliedAt) {
  assertIntegrity(database);

  const currentVersion = pragmaInteger(database, 'user_version');
  const applicationId = pragmaInteger(database, 'application_id');
  if (currentVersion > LATEST_CHAT_SCHEMA_VERSION) throw new UnsupportedSchemaError();
  if (currentVersion === 0 && applicationId === 0 && existingUserTables(database).length !== 0) {
    throw new StorageCorruptionError('Refusing to claim a non-empty, unidentified direct-chat database.');
  }
  if (currentVersion > 0 && applicationId !== CHAT_SQLITE_APPLICATION_ID) {
    throw new StorageCorruptionError('The database belongs to a different application.');
  }
  if (applicationId !== 0 && applicationId !== CHAT_SQLITE_APPLICATION_ID) {
    throw new StorageCorruptionError('The direct-chat database application identifier is not recognized.');
  }

  if (currentVersion > 0) verifyMigrationLedger(database, currentVersion);

  for (const migration of CHAT_MIGRATIONS.slice(currentVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO chat_schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migration.checksum, appliedAt);
      database.exec(`PRAGMA application_id = ${CHAT_SQLITE_APPLICATION_ID}`);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the migration failure.
      }
      throw new StorageCorruptionError(
        `Direct-chat migration ${migration.version} could not be applied.`,
        { cause: error }
      );
    }
  }

  verifyMigrationLedger(database, LATEST_CHAT_SCHEMA_VERSION);
  verifySchemaObjects(database);
  assertIntegrity(database);
}
