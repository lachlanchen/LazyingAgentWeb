import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  STANDALONE_SERVICE_CONFIG_SCHEMA,
  assertLoadedServiceConfig,
  loadServiceConfig
} from '../src/service-config.js';

const PASSWORD_RECORD = 'scrypt$v=1$n=131072,r=8,p=1$ABEiM0RVZneImaq7zN3u_w$ODwJaN-PM0aUzMtLvhFdDx1N8hFXxjq516BA_8qqt8ZvPCFPrAO-5S8bx0vVTiFV-6f3T9LPL5YPBEUJ6yTR2Q';
const TOKEN_ONE = 'local-token-one-0000000000000001';
const TOKEN_TWO = 'local-token-two-0000000000000002';

function configValue(root, overrides = {}) {
  const value = {
    schema: STANDALONE_SERVICE_CONFIG_SCHEMA,
    listen: { host: '127.0.0.1', port: 18_543 },
    publicOrigin: 'https://llm.test',
    account: {
      username: 'lachlanchen',
      principalId: 'principal_account_one',
      displayName: 'Lachlan'
    },
    state: {
      cloudIndexDatabase: join(root, 'state', 'cloud', 'index.sqlite'),
      directChatDatabase: join(root, 'state', 'chat', 'chat.sqlite')
    },
    pwa: {
      versionLabel: 'test',
      title: 'LazyingArt Agent',
      name: 'LazyingArt Agent',
      shortName: 'Lazying Agent'
    },
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-test'],
      defaultModelAlias: 'localllm-test'
    },
    credentials: {
      passwordHash: 'login-password-hash',
      localLlmToken: 'localllm-token'
    }
  };
  return { ...value, ...overrides };
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lazying-service-config-test-'));
  const credentialsDirectory = join(root, 'credentials');
  const configPath = join(root, 'service.json');
  mkdirSync(credentialsDirectory, { mode: 0o700 });
  writeFileSync(join(credentialsDirectory, 'login-password-hash'), `${PASSWORD_RECORD}\n`, { mode: 0o600 });
  writeFileSync(join(credentialsDirectory, 'localllm-token'), TOKEN_ONE, { mode: 0o400 });
  writeFileSync(configPath, JSON.stringify(configValue(root, overrides)), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, credentialsDirectory, configPath };
}

test('loads only owner-private config and rotating LoadCredential-style files', async (t) => {
  const state = fixture(t);
  const loaded = loadServiceConfig(state);

  assert.equal(assertLoadedServiceConfig(loaded), loaded);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.config), true);
  assert.equal(loaded.config.listen.host, '127.0.0.1');
  assert.notEqual(loaded.config.state.cloudIndexDatabase, loaded.config.state.directChatDatabase);
  assert.equal(loaded.readCredential('passwordHash'), PASSWORD_RECORD);
  assert.equal(loaded.readCredential('localLlmToken'), TOKEN_ONE);
  const provider = loaded.createCredentialProvider('localLlmToken');
  assert.equal(await provider(), TOKEN_ONE);

  chmodSync(join(state.credentialsDirectory, 'localllm-token'), 0o600);
  writeFileSync(join(state.credentialsDirectory, 'localllm-token'), TOKEN_TWO);
  chmodSync(join(state.credentialsDirectory, 'localllm-token'), 0o400);
  assert.equal(await provider(), TOKEN_TWO);

  const serialized = JSON.stringify(loaded.config);
  assert.equal(serialized.includes(PASSWORD_RECORD), false);
  assert.equal(serialized.includes(TOKEN_ONE), false);
  assert.equal(serialized.includes(TOKEN_TWO), false);
  assert.equal(serialized.includes('password"'), false);
});

test('rejects permissive modes, symlinks, and hard-linked credential inputs', (t) => {
  const permissive = fixture(t);
  chmodSync(permissive.configPath, 0o644);
  assert.throws(() => loadServiceConfig(permissive), /owner-only/u);

  const linked = fixture(t);
  const linkedConfig = join(linked.root, 'linked-config.json');
  symlinkSync(linked.configPath, linkedConfig);
  assert.throws(
    () => loadServiceConfig({ ...linked, configPath: linkedConfig }),
    /without links|symlink|real/u
  );

  const hardLinked = fixture(t);
  linkSync(
    join(hardLinked.credentialsDirectory, 'localllm-token'),
    join(hardLinked.root, 'token-copy')
  );
  const loaded = loadServiceConfig(hardLinked);
  assert.throws(() => loaded.readCredential('localLlmToken'), /without links/u);
});

test('rejects public binds, non-private LocalLLM, shared databases, and secret config fields', (t) => {
  const cases = [
    (root) => configValue(root, { listen: { host: '0.0.0.0', port: 18_543 } }),
    (root) => configValue(root, {
      localLlm: {
        baseUrl: 'https://provider.example/v1',
        allowedModelAliases: ['localllm-test'],
        defaultModelAlias: 'localllm-test'
      }
    }),
    (root) => {
      const path = join(root, 'state', 'same.sqlite');
      return configValue(root, { state: { cloudIndexDatabase: path, directChatDatabase: path } });
    },
    (root) => ({ ...configValue(root), password: 'must-not-be-in-config' }),
    (root) => configValue(root, {
      credentials: { passwordHash: '../password', localLlmToken: 'localllm-token' }
    })
  ];

  for (const create of cases) {
    const state = fixture(t);
    writeFileSync(state.configPath, JSON.stringify(create(state.root)), { mode: 0o600 });
    assert.throws(() => loadServiceConfig(state), TypeError);
  }
});

test('rejects duplicate JSON keys before semantic validation', (t) => {
  const state = fixture(t);
  const source = JSON.stringify(configValue(state.root));
  const duplicated = source.replace(
    `"schema":"${STANDALONE_SERVICE_CONFIG_SCHEMA}"`,
    `"schema":"${STANDALONE_SERVICE_CONFIG_SCHEMA}","schema":"${STANDALONE_SERVICE_CONFIG_SCHEMA}"`
  );
  writeFileSync(state.configPath, duplicated, { mode: 0o600 });
  assert.throws(() => loadServiceConfig(state), /not valid JSON/u);
});
