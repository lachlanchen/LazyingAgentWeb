import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CloudIndexStore } from '../src/index.js';

export function createTestStore(test, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-agent-web-test-'));
  const databasePath = join(root, 'private', 'index.sqlite');
  const store = new CloudIndexStore({ databasePath, ...options });
  test.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, databasePath, store };
}

export function provisionAccount(store, suffix = 'one') {
  return store.provisionAccount({
    accountId: `account-${suffix}`,
    issuer: 'https://identity.example.test',
    subject: `subject-${suffix}`,
    displayName: `Account ${suffix}`,
    idempotencyKey: `account-provision-${suffix}-0001`
  });
}

