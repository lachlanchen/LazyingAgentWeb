import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertExact,
  digest,
  publishIdempotently,
  registryDocument,
} from '../scripts/npm-publish-idempotent.mjs';

const pkg = {
  name: '@lazyingart/agent-web',
  version: '0.1.41',
  publishConfig: { registry: 'https://registry.npmjs.org/' },
};

function response(status, document) {
  return new Response(document === undefined ? null : JSON.stringify(document), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withTarball(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'npm-publish-idempotent-test-'));
  try {
    const tarball = path.join(directory, 'package.tgz');
    await writeFile(tarball, 'deterministic package bytes');
    return await run(tarball, await digest(tarball));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function exactDocument(local, overrides = {}) {
  return {
    name: pkg.name,
    version: pkg.version,
    dist: { ...local },
    ...overrides,
  };
}

test('exact registry lookup bypasses caches and does not use npm view semantics', async () => {
  let request;
  const document = await registryDocument(pkg.name, pkg.version, {
    cacheBust: 'unit-test',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response(200, { name: pkg.name, version: pkg.version, dist: {} });
    },
  });

  assert.equal(document.name, pkg.name);
  assert.equal(
    request.url,
    'https://registry.npmjs.org/%40lazyingart%2Fagent-web/0.1.41?cache-bust=unit-test',
  );
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers['cache-control'], 'no-cache, no-store, max-age=0');
  assert.equal(request.options.headers.pragma, 'no-cache');
});

test('an identical exact version is idempotent only when integrity and shasum match', async () => {
  await withTarball(async (tarball, local) => {
    let publishCalls = 0;
    const result = await publishIdempotently({
      pkg,
      tarball,
      fetchImpl: async () => response(200, exactDocument(local)),
      spawnImpl: () => {
        publishCalls += 1;
        return { status: 0 };
      },
      log: () => {},
    });

    assert.equal(result.outcome, 'already-published');
    assert.equal(publishCalls, 0);

    assert.throws(
      () => assertExact(exactDocument(local, {
        dist: { integrity: local.integrity, shasum: 'wrong' },
      }), pkg, local),
      /dist\.shasum differs/u,
    );
    assert.throws(
      () => assertExact(exactDocument(local, {
        dist: { integrity: local.integrity },
      }), pkg, local),
      /dist\.shasum differs/u,
    );
    assert.throws(
      () => assertExact(exactDocument(local, {
        dist: { shasum: local.shasum },
      }), pkg, local),
      /dist\.integrity differs/u,
    );
  });
});

test('an invalid success response fails closed before npm publish', async () => {
  await withTarball(async (tarball) => {
    let publishCalls = 0;
    await assert.rejects(
      publishIdempotently({
        pkg,
        tarball,
        fetchImpl: async () => response(200),
        spawnImpl: () => {
          publishCalls += 1;
          return { status: 0 };
        },
        log: () => {},
      }),
      /exact-version endpoint returned invalid JSON/u,
    );
    assert.equal(publishCalls, 0);
  });
});

test('a missing version is published once and exact-byte verified afterward', async () => {
  await withTarball(async (tarball, local) => {
    const replies = [response(404), response(200, exactDocument(local))];
    const calls = [];
    const result = await publishIdempotently({
      pkg,
      tarball,
      fetchImpl: async () => replies.shift(),
      spawnImpl: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      verifyAttempts: 1,
      wait: async () => {},
      log: () => {},
    });

    assert.equal(result.outcome, 'published');
    assert.deepEqual(calls[0][1], [
      'publish',
      tarball,
      '--access',
      'public',
      '--provenance',
    ]);
  });
});

test('a publish race is successful only when the exact bytes become visible', async () => {
  await withTarball(async (tarball, local) => {
    const replies = [response(404), response(200, exactDocument(local))];
    const result = await publishIdempotently({
      pkg,
      tarball,
      fetchImpl: async () => replies.shift(),
      spawnImpl: () => ({ status: 1 }),
      verifyAttempts: 1,
      wait: async () => {},
      log: () => {},
    });

    assert.equal(result.outcome, 'published-after-race');
  });
});
