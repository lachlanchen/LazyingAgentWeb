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
