import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryUrl = 'https://github.com/lachlanchen/LazyingAgentWeb.git';
const registryUrl = 'https://registry.npmjs.org/';

test('npm publishing is release-bound, reproducible, and tokenless', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const workflow = await readFile(
    new URL('../.github/workflows/npm-publish.yml', import.meta.url),
    'utf8',
  );
  const publisher = await readFile(
    new URL('../scripts/npm-publish-idempotent.mjs', import.meta.url),
    'utf8',
  );
  const verificationWorkflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );

  assert.deepEqual(packageJson.repository, { type: 'git', url: repositoryUrl });
  assert.equal(packageJson.homepage, 'https://llm.lazying.art');
  assert.equal(packageJson.bugs?.url, 'https://github.com/lachlanchen/LazyingAgentWeb/issues');
  assert.deepEqual(packageJson.publishConfig, { access: 'public', registry: registryUrl });

  for (const required of [
    'release:\n    types: [published]',
    'id-token: write',
    'persist-credentials: false',
    "test \"$(git describe --tags --exact-match HEAD)\" = \"$RELEASE_TAG\"",
    'npm ci --ignore-scripts',
    'const x=Array.isArray(p)?p:Object.values(p)',
    'cmp --silent "$RUNNER_TEMP/fresh-package.manifest" "$RUNNER_TEMP/release-package.manifest"',
    'diff --no-dereference --recursive --brief "$FRESH_TREE/package" "$RELEASE_TREE/package"',
    'node scripts/npm-publish-idempotent.mjs "$TARBALL"',
  ]) {
    assert.ok(workflow.includes(required), `missing publishing invariant: ${required}`);
  }

  for (const required of [
    "['publish', tarball, '--access', 'public', '--provenance']",
    "cache: 'no-store'",
    "'cache-control': 'no-cache, no-store, max-age=0'",
    "endpoint.searchParams.set('cache-bust'",
    'document.dist.integrity !== local.integrity',
    'document.dist.shasum !== local.shasum',
  ]) {
    assert.ok(publisher.includes(required), `missing idempotent publisher invariant: ${required}`);
  }

  assert.doesNotMatch(workflow, /(?:npm view|NODE_AUTH_TOKEN|NPM_TOKEN|pull_request_target|pull_request:)/u);
  assert.match(verificationWorkflow, /node: \['22\.21\.0', '24'\]/u);
  assert.match(verificationWorkflow, /permissions:\n  contents: read/u);
  assert.match(verificationWorkflow, /npm ci --ignore-scripts/u);
  assert.match(verificationWorkflow, /npm pack --dry-run --json --ignore-scripts/u);
  assert.match(verificationWorkflow, /git diff --exit-code/u);
  assert.doesNotMatch(verificationWorkflow, /(?:id-token: write|NODE_AUTH_TOKEN|NPM_TOKEN|pull_request_target)/u);
});
