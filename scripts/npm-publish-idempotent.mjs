#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const VERIFY_ATTEMPTS = 10;
const VERIFY_DELAY_MS = 3_000;

let requestSequence = 0;

function nextCacheBust() {
  requestSequence += 1;
  return `${Date.now()}-${process.pid}-${requestSequence}`;
}

export async function digest(filename) {
  const integrity = createHash('sha512');
  const shasum = createHash('sha1');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', (chunk) => {
      integrity.update(chunk);
      shasum.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return {
    integrity: `sha512-${integrity.digest('base64')}`,
    shasum: shasum.digest('hex'),
  };
}

export function exactVersionEndpoint(registry, name, version, cacheBust = nextCacheBust()) {
  const base = new URL(registry);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const endpoint = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, base);
  endpoint.searchParams.set('cache-bust', cacheBust);
  return endpoint;
}

export async function registryDocument(name, version, {
  registry = DEFAULT_REGISTRY,
  fetchImpl = globalThis.fetch,
  cacheBust,
  timeoutMs = 15_000,
} = {}) {
  const endpoint = exactVersionEndpoint(registry, name, version, cacheBust);
  const response = await fetchImpl(endpoint, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store, max-age=0',
      pragma: 'no-cache',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry exact-version endpoint returned HTTP ${response.status}`);
  }

  let document;
  try {
    document = await response.json();
  } catch (error) {
    throw new Error('npm registry exact-version endpoint returned invalid JSON', { cause: error });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('npm registry exact-version endpoint returned an invalid document');
  }
  return document;
}

export function assertExact(document, pkg, local) {
  const failures = [];
  if (document.name !== pkg.name) failures.push('name');
  if (document.version !== pkg.version) failures.push('version');
  if (typeof document.dist?.integrity !== 'string'
      || document.dist.integrity !== local.integrity) {
    failures.push('dist.integrity');
  }
  if (typeof document.dist?.shasum !== 'string'
      || document.dist.shasum !== local.shasum) {
    failures.push('dist.shasum');
  }
  if (failures.length) {
    throw new Error(
      `Registry version exists but ${failures.join(', ')} differs; refusing to publish or claim success`,
    );
  }
}

function validatePackage(pkg) {
  if (!pkg.name || !pkg.version) throw new Error('package.json needs exact name and version');
  if (pkg.private) throw new Error('package.json is private; refusing to publish');
}

function publishTarball(tarball, spawnImpl) {
  return spawnImpl(
    'npm',
    ['publish', tarball, '--access', 'public', '--provenance'],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function publishIdempotently({
  pkg,
  tarball,
  registry = pkg?.publishConfig?.registry ?? DEFAULT_REGISTRY,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawnSync,
  wait = sleep,
  verifyAttempts = VERIFY_ATTEMPTS,
  verifyDelayMs = VERIFY_DELAY_MS,
  log = (message) => process.stdout.write(`${message}\n`),
}) {
  validatePackage(pkg);
  if (!tarball) throw new Error('An exact package tarball path is required');
  if (!Number.isInteger(verifyAttempts) || verifyAttempts < 1) {
    throw new Error('verifyAttempts must be a positive integer');
  }

  const local = await digest(tarball);
  const lookup = () => registryDocument(pkg.name, pkg.version, { registry, fetchImpl });
  const existing = await lookup();
  if (existing) {
    assertExact(existing, pkg, local);
    log(`Exact ${pkg.name}@${pkg.version} is already published with identical integrity and shasum.`);
    return { outcome: 'already-published', ...local };
  }

  const publishResult = publishTarball(tarball, spawnImpl);
  let published = null;
  let lastLookupError = null;
  for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
    try {
      published = await lookup();
      lastLookupError = null;
      if (published) break;
    } catch (error) {
      lastLookupError = error;
    }
    if (attempt + 1 < verifyAttempts) await wait(verifyDelayMs);
  }

  if (published) {
    assertExact(published, pkg, local);
    if (publishResult.status === 0 && !publishResult.error) {
      log(`Published and byte-verified ${pkg.name}@${pkg.version}.`);
      return { outcome: 'published', ...local };
    }
    log(
      `npm publish did not exit successfully, but exact ${pkg.name}@${pkg.version} `
      + 'is published with identical integrity and shasum.',
    );
    return { outcome: 'published-after-race', ...local };
  }

  const publishFailure = publishResult.error
    ? publishResult.error.message
    : `status ${publishResult.status ?? 'unknown'}`;
  if (publishResult.status !== 0 || publishResult.error) {
    throw new Error(
      `npm publish failed with ${publishFailure}, and no identical exact registry version appeared`,
      lastLookupError ? { cause: lastLookupError } : undefined,
    );
  }
  throw new Error(
    'npm publish succeeded, but the exact registry version did not appear in time',
    lastLookupError ? { cause: lastLookupError } : undefined,
  );
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error('Usage: node scripts/npm-publish-idempotent.mjs <package.tgz>');
  }
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const tarball = path.resolve(argv[0]);
  await publishIdempotently({ pkg, tarball });
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
