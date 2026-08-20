import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PASSWORD_SCRYPT_FORMAT,
  createScryptPasswordVerifier,
  validateScryptPasswordHash
} from '../src/password-verifier.js';

const PASSWORD = 'correct horse battery staple';
const RECORD = 'scrypt$v=1$n=131072,r=8,p=1$ABEiM0RVZneImaq7zN3u_w$ODwJaN-PM0aUzMtLvhFdDx1N8hFXxjq516BA_8qqt8ZvPCFPrAO-5S8bx0vVTiFV-6f3T9LPL5YPBEUJ6yTR2Q';
const LEGACY_32_BYTE_RECORD = 'scrypt$v=1$n=131072,r=8,p=1$ABEiM0RVZneImaq7zN3u_w$ODwJaN-PM0aUzMtLvhFdDx1N8hFXxjq516BA_8qqt8Y';

test('verifies only the frozen production scrypt format without exposing its credential', async () => {
  assert.equal(validateScryptPasswordHash(RECORD), true);
  const verifier = createScryptPasswordVerifier(RECORD);

  assert.equal(Object.isFrozen(verifier), true);
  assert.equal(verifier.algorithm, 'scrypt');
  assert.deepEqual(verifier.parameters, {
    version: 1,
    n: 131_072,
    r: 8,
    p: 1,
    keyLength: 64
  });
  assert.equal(await verifier.verify(PASSWORD), true);
  assert.equal(await verifier.verify(`${PASSWORD}!`), false);
  assert.equal(JSON.stringify(verifier).includes(RECORD), false);
  assert.equal(JSON.stringify(verifier).includes('ODwJaN'), false);

  const controller = new AbortController();
  controller.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(verifier.verify(PASSWORD, { signal: controller.signal }), { name: 'AbortError' });
});

test('accepts the canonical legacy 32-byte verifier without weakening scrypt parameters', async () => {
  assert.equal(validateScryptPasswordHash(LEGACY_32_BYTE_RECORD), true);
  const verifier = createScryptPasswordVerifier(LEGACY_32_BYTE_RECORD);
  assert.deepEqual(verifier.parameters, {
    version: 1,
    n: 131_072,
    r: 8,
    p: 1,
    keyLength: 32
  });
  assert.equal(await verifier.verify(PASSWORD), true);
  assert.equal(await verifier.verify(`${PASSWORD}!`), false);
});

test('rejects parameter downgrade, noncanonical encoding, and malformed fixed records', () => {
  assert.deepEqual(PASSWORD_SCRYPT_FORMAT, {
    prefix: 'scrypt$v=1$n=131072,r=8,p=1$',
    version: 1,
    n: 131_072,
    r: 8,
    p: 1,
    keyLength: 64
  });
  for (const malformed of [
    RECORD.replace('n=131072', 'n=16384'),
    RECORD.replace('r=8', 'r=1'),
    RECORD.replace('p=1', 'p=2'),
    RECORD.replace('$ABEi', '$ABEi='),
    `${RECORD}\n`,
    'scrypt$v=1$n=131072,r=8,p=1$c2hvcnQ$YWxzby1zaG9ydA',
    RECORD.replace(/\$[^$]+$/u, '$' + 'A'.repeat(64)),
    RECORD.replace(/\$[^$]+$/u, '$' + 'A'.repeat(85))
  ]) {
    assert.throws(() => createScryptPasswordVerifier(malformed), TypeError);
  }
});
