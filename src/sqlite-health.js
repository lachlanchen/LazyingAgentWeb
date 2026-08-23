import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, resolve } from 'node:path';

import { StorageCorruptionError, ValidationError } from './errors.js';
import { assertSecureDatabaseFile } from './storage-path.js';

const SQLITE_VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

function normalizedSchemaVersions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new ValidationError('allowedSchemaVersions must be a short non-empty array.');
  }
  const versions = [...new Set(value)];
  if (versions.length !== value.length
      || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new ValidationError('allowedSchemaVersions contains an invalid schema version.');
  }
  return Object.freeze(versions);
}

export function checkOpenSqliteHealth(database, {
  expectedApplicationId,
  allowedSchemaVersions
} = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new ValidationError('database must provide prepare().');
  }
  if (!Number.isSafeInteger(expectedApplicationId) || expectedApplicationId < 1) {
    throw new ValidationError('expectedApplicationId is invalid.');
  }
  const schemaVersions = normalizedSchemaVersions(allowedSchemaVersions);

  const quickCheck = database.prepare('PRAGMA quick_check').get();
  if (quickCheck?.quick_check !== 'ok') throw new StorageCorruptionError();
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw new StorageCorruptionError('The database contains invalid ownership references.');
  }
  const schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  const applicationId = Number(database.prepare('PRAGMA application_id').get()?.application_id);
  if (!schemaVersions.includes(schemaVersion) || applicationId !== expectedApplicationId) {
    throw new StorageCorruptionError('The database identity or schema version changed unexpectedly.');
  }
  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get()?.version;
  if (typeof sqliteVersion !== 'string' || !SQLITE_VERSION_PATTERN.test(sqliteVersion)) {
    throw new StorageCorruptionError('SQLite returned an invalid runtime version.');
  }
  return Object.freeze({ ready: true, schemaVersion, sqliteVersion });
}

export function checkSqliteFileHealth({
  databasePath,
  expectedApplicationId,
  allowedSchemaVersions
} = {}) {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)
      || resolve(databasePath) !== databasePath) {
    throw new ValidationError('databasePath must be an absolute normalized path.');
  }
  assertSecureDatabaseFile(databasePath);
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.enableLoadExtension(false);
    database.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
    `);
    return checkOpenSqliteHealth(database, {
      expectedApplicationId,
      allowedSchemaVersions
    });
  } catch (error) {
    if (error instanceof StorageCorruptionError || error instanceof ValidationError) throw error;
    throw new StorageCorruptionError('The database could not be inspected read-only.', { cause: error });
  } finally {
    try {
      database?.close();
    } finally {
      assertSecureDatabaseFile(databasePath);
    }
  }
}
