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
    'cmp --silent "$TARBALL" "$RUNNER_TEMP/release-asset/$TARBALL"',
    'test "$PUBLISHED_INTEGRITY" = "$EXPECTED_INTEGRITY"',
    'npm publish "./$TARBALL" --access public --provenance',
  ]) {
    assert.ok(workflow.includes(required), `missing publishing invariant: ${required}`);
  }

  assert.doesNotMatch(workflow, /(?:NODE_AUTH_TOKEN|NPM_TOKEN|pull_request_target|pull_request:)/u);
});
