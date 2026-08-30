import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  CloudIndexStore,
  StorageCorruptionError,
  StorageSecurityError,
  UnsupportedSchemaError
} from '../src/index.js';

function privateTemp(test) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-agent-web-security-'));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fileSha256(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

test('creates a private directory and database file', (t) => {
  const root = privateTemp(t);
  const databasePath = join(root, 'state', 'index.sqlite');
  const store = new CloudIndexStore({ databasePath });
  t.after(() => store.close());

  assert.equal(lstatSync(join(root, 'state')).mode & 0o777, 0o700);
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
  assert.equal(lstatSync(databasePath).nlink, 1);
});

test('rejects a group-accessible state directory', (t) => {
  const root = privateTemp(t);
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o750);

  assert.throws(
    () => new CloudIndexStore({ databasePath: join(state, 'index.sqlite') }),
    StorageSecurityError
  );
});

test('rejects a group-accessible database file', (t) => {
  const root = privateTemp(t);
  const databasePath = join(root, 'state', 'index.sqlite');
  const store = new CloudIndexStore({ databasePath });
  store.close();
  chmodSync(databasePath, 0o640);

  assert.throws(() => new CloudIndexStore({ databasePath }), StorageSecurityError);
});

test('read-only mode never creates a missing database and preserves exact bytes', (t) => {
  const root = privateTemp(t);
  const state = join(root, 'state');
  const databasePath = join(state, 'index.sqlite');
  mkdirSync(state, { mode: 0o700 });

  assert.throws(() => new CloudIndexStore({ databasePath, readOnly: true }));
  assert.equal(existsSync(databasePath), false);

  const writer = new CloudIndexStore({ databasePath });
  writer.provisionAccount({
    accountId: 'account-read-only',
    issuer: 'local-login',
    subject: 'read-only',
    displayName: 'Read Only',
    idempotencyKey: 'account-provision-read-only-0001'
  });
  writer.close();
  const before = fileSha256(databasePath);

  const reader = new CloudIndexStore({ databasePath, readOnly: true });
  assert.equal(reader.getAccount('account-read-only').displayName, 'Read Only');
  assert.throws(() => reader.provisionAccount({
    accountId: 'account-read-only',
    issuer: 'local-login',
    subject: 'read-only',
    displayName: 'Changed',
    idempotencyKey: 'account-provision-read-only-0002'
  }));
  reader.close();
  assert.equal(fileSha256(databasePath), before);
});

test('rejects symbolic links and hard-linked database files', (t) => {
  const root = privateTemp(t);
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  const realDatabase = join(root, 'real.sqlite');
  const descriptor = openSync(realDatabase, 'wx', 0o600);
  closeSync(descriptor);
  const symbolicDatabase = join(state, 'symbolic.sqlite');
  symlinkSync(realDatabase, symbolicDatabase);
  assert.throws(() => new CloudIndexStore({ databasePath: symbolicDatabase }), StorageSecurityError);

  const hardLinkedDatabase = join(state, 'hard.sqlite');
  linkSync(realDatabase, hardLinkedDatabase);
  assert.throws(() => new CloudIndexStore({ databasePath: hardLinkedDatabase }), StorageSecurityError);
});

test('rejects corrupt, future, and migration-tampered databases', (t) => {
  const root = privateTemp(t);

  const corruptDirectory = join(root, 'corrupt');
  mkdirSync(corruptDirectory, { mode: 0o700 });
  const corruptPath = join(corruptDirectory, 'index.sqlite');
  writeFileSync(corruptPath, 'this is not sqlite', { mode: 0o600 });
  assert.throws(() => new CloudIndexStore({ databasePath: corruptPath }), StorageCorruptionError);

  const futurePath = join(root, 'future', 'index.sqlite');
  const futureStore = new CloudIndexStore({ databasePath: futurePath });
  futureStore.close();
  const futureDatabase = new DatabaseSync(futurePath);
  futureDatabase.exec('PRAGMA user_version = 999');
  futureDatabase.close();
  assert.throws(() => new CloudIndexStore({ databasePath: futurePath }), UnsupportedSchemaError);

  const tamperedPath = join(root, 'tampered', 'index.sqlite');
  const tamperedStore = new CloudIndexStore({ databasePath: tamperedPath });
  tamperedStore.close();
  const tamperedDatabase = new DatabaseSync(tamperedPath);
  tamperedDatabase.prepare(`
    UPDATE schema_migrations SET checksum = ? WHERE version = 1
  `).run('0'.repeat(64));
  tamperedDatabase.close();
  assert.throws(() => new CloudIndexStore({ databasePath: tamperedPath }), StorageCorruptionError);
});

test('refuses to claim an unidentified non-empty SQLite database', (t) => {
  const root = privateTemp(t);
  const state = join(root, 'foreign');
  mkdirSync(state, { mode: 0o700 });
  const databasePath = join(state, 'index.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE foreign_data(value TEXT) STRICT');
  database.close();
  chmodSync(databasePath, 0o600);

  assert.throws(() => new CloudIndexStore({ databasePath }), StorageCorruptionError);
});
