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
  isSystemdCredentialPath,
  isTrustedCredentialMode,
  isTrustedCredentialOwner,
  loadServiceConfig
} from '../src/service-config.js';

const PASSWORD_RECORD = 'scrypt$v=1$n=131072,r=8,p=1$ABEiM0RVZneImaq7zN3u_w$ODwJaN-PM0aUzMtLvhFdDx1N8hFXxjq516BA_8qqt8ZvPCFPrAO-5S8bx0vVTiFV-6f3T9LPL5YPBEUJ6yTR2Q';
const TOKEN_ONE = 'local-token-one-0000000000000001';
const TOKEN_TWO = 'local-token-two-0000000000000002';
const AGINTI_TOKEN = 'aginti-token-one-0000000000000001';
const SPEECH_TOKEN = 'speech-token-one-0000000000000001';

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
    aginti: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:18009'
    },
    credentials: {
      passwordHash: 'login-password-hash',
      localLlmToken: 'localllm-token',
      agintiToken: 'aginti-token'
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
  writeFileSync(join(credentialsDirectory, 'aginti-token'), AGINTI_TOKEN, { mode: 0o400 });
  writeFileSync(join(credentialsDirectory, 'speech-token'), SPEECH_TOKEN, { mode: 0o400 });
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
  assert.equal(loaded.readCredential('agintiToken'), AGINTI_TOKEN);
  const provider = loaded.createCredentialProvider('localLlmToken');
  const agentProvider = loaded.createCredentialProvider('agintiToken');
  assert.equal(await provider(), TOKEN_ONE);
  assert.equal(await agentProvider(), AGINTI_TOKEN);

  chmodSync(join(state.credentialsDirectory, 'localllm-token'), 0o600);
  writeFileSync(join(state.credentialsDirectory, 'localllm-token'), TOKEN_TWO);
  chmodSync(join(state.credentialsDirectory, 'localllm-token'), 0o400);
  assert.equal(await provider(), TOKEN_TWO);

  const serialized = JSON.stringify(loaded.config);
  assert.equal(serialized.includes(PASSWORD_RECORD), false);
  assert.equal(serialized.includes(TOKEN_ONE), false);
  assert.equal(serialized.includes(TOKEN_TWO), false);
  assert.equal(serialized.includes(AGINTI_TOKEN), false);
  assert.equal(serialized.includes('password"'), false);
});

test('accepts only the service uid or root for systemd credential ownership', () => {
  assert.equal(isTrustedCredentialOwner(1_000, 1_000), true);
  assert.equal(isTrustedCredentialOwner(0, 1_000, 0), true);
  assert.equal(isTrustedCredentialOwner(0, 1_000, 100), false);
  assert.equal(isTrustedCredentialOwner(0, 0, 100), false);
  assert.equal(isTrustedCredentialOwner(2_000, 1_000), false);
  assert.equal(isTrustedCredentialOwner(0, null, 0), true);
  assert.throws(() => isTrustedCredentialOwner(-1, 1_000), TypeError);
  assert.equal(isSystemdCredentialPath('/run/credentials/lazying-agent-web.service', { directory: true }), true);
  assert.equal(isSystemdCredentialPath('/run/credentials/lazying-agent-web.service/localllm-token'), true);
  assert.equal(isSystemdCredentialPath('/run/credentials/lazying-agent-web@blue.service/token.name'), true);
  assert.equal(isSystemdCredentialPath('/run/credentials/lazying-agent-web.service', { directory: false }), false);
  assert.equal(isSystemdCredentialPath('/run/credentials/lazying-agent-web.service/../token'), false);
  assert.equal(isSystemdCredentialPath('/tmp/credentials/lazying-agent-web.service/token'), false);
  assert.equal(isTrustedCredentialMode(0o100440, { rootOwned: true }), true);
  assert.equal(isTrustedCredentialMode(0o040550, { rootOwned: true, directory: true }), true);
  assert.equal(isTrustedCredentialMode(0o100640, { rootOwned: true }), true);
  assert.equal(isTrustedCredentialMode(0o040750, { rootOwned: true, directory: true }), true);
  assert.equal(isTrustedCredentialMode(0o100460, { rootOwned: true }), false);
  assert.equal(isTrustedCredentialMode(0o040570, { rootOwned: true, directory: true }), false);
  assert.equal(isTrustedCredentialMode(0o100600), true);
  assert.equal(isTrustedCredentialMode(0o100640), false);
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

test('supports an explicitly disabled Agent without an AgInTi endpoint or credential', (t) => {
  const state = fixture(t, {
    aginti: { enabled: false },
    credentials: { passwordHash: 'login-password-hash', localLlmToken: 'localllm-token' }
  });
  const loaded = loadServiceConfig(state);
  assert.deepEqual(loaded.config.aginti, { enabled: false });
  assert.throws(() => loaded.readCredential('agintiToken'), /not configured/u);
  assert.throws(() => loaded.createCredentialProvider('agintiToken'), /not configured/u);
});

test('keeps vision fail-closed by default and enables only the fixed LocalLLM vision alias', (t) => {
  const disabled = loadServiceConfig(fixture(t));
  assert.deepEqual(disabled.config.localLlm.vision, {
    enabled: false,
    modelAlias: 'localllm-vision'
  });

  const enabledState = fixture(t, {
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-test', 'localllm-vision'],
      defaultModelAlias: 'localllm-test',
      vision: { enabled: true }
    }
  });
  assert.deepEqual(loadServiceConfig(enabledState).config.localLlm.vision, {
    enabled: true,
    modelAlias: 'localllm-vision'
  });

  const missingAlias = fixture(t, {
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-test'],
      defaultModelAlias: 'localllm-test',
      vision: { enabled: true }
    }
  });
  assert.throws(() => loadServiceConfig(missingAlias), /must include localllm-vision/u);

  const visionAsText = fixture(t, {
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-vision'],
      defaultModelAlias: 'localllm-vision',
      vision: { enabled: true }
    }
  });
  assert.throws(() => loadServiceConfig(visionAsText), /must remain the text alias/u);
});

test('keeps speech disabled by default and requires a separate private route credential when enabled', async (t) => {
  const disabled = loadServiceConfig(fixture(t));
  assert.deepEqual(disabled.config.localLlm.speech, { enabled: false });
  assert.throws(() => disabled.readCredential('speechToken'), /not configured/u);

  const enabled = loadServiceConfig(fixture(t, {
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-test'],
      defaultModelAlias: 'localllm-test',
      speech: { enabled: true, baseUrl: 'http://127.0.0.1:18023/api/speech' }
    },
    credentials: {
      passwordHash: 'login-password-hash',
      localLlmToken: 'localllm-token',
      agintiToken: 'aginti-token',
      speechToken: 'speech-token'
    }
  }));
  assert.deepEqual(enabled.config.localLlm.speech, {
    enabled: true,
    baseUrl: 'http://127.0.0.1:18023/api/speech'
  });
  assert.equal(enabled.readCredential('speechToken'), SPEECH_TOKEN);
  assert.equal(await enabled.createCredentialProvider('speechToken')(), SPEECH_TOKEN);

  for (const speech of [
    { enabled: true },
    { enabled: false, baseUrl: 'http://127.0.0.1:18023/api/speech' },
    { enabled: true, baseUrl: 'https://127.0.0.1:18023/api/speech' },
    { enabled: true, baseUrl: 'http://localhost:18023/api/speech' },
    { enabled: true, baseUrl: 'http://127.0.0.1:18023/api/speech/' }
  ]) {
    const state = fixture(t, {
      localLlm: {
        baseUrl: 'http://127.0.0.1:18008/v1',
        allowedModelAliases: ['localllm-test'],
        defaultModelAlias: 'localllm-test',
        speech
      },
      credentials: {
        passwordHash: 'login-password-hash',
        localLlmToken: 'localllm-token',
        agintiToken: 'aginti-token',
        ...(speech.enabled ? { speechToken: 'speech-token' } : {})
      }
    });
    assert.throws(() => loadServiceConfig(state), TypeError);
  }

  const reused = fixture(t, {
    localLlm: {
      baseUrl: 'http://127.0.0.1:18008/v1',
      allowedModelAliases: ['localllm-test'],
      defaultModelAlias: 'localllm-test',
      speech: { enabled: true, baseUrl: 'http://127.0.0.1:18023/api/speech' }
    },
    credentials: {
      passwordHash: 'login-password-hash',
      localLlmToken: 'localllm-token',
      agintiToken: 'aginti-token',
      speechToken: 'localllm-token'
    }
  });
  assert.throws(() => loadServiceConfig(reused), /separate files/u);
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
      credentials: { passwordHash: '../password', localLlmToken: 'localllm-token', agintiToken: 'aginti-token' }
    }),
    (root) => configValue(root, { aginti: { enabled: true, baseUrl: 'http://192.168.1.2:18009' } }),
    (root) => configValue(root, {
      aginti: { enabled: false },
      credentials: { passwordHash: 'login-password-hash', localLlmToken: 'localllm-token', agintiToken: 'aginti-token' }
    }),
    (root) => configValue(root, {
      credentials: { passwordHash: 'login-password-hash', localLlmToken: 'localllm-token' }
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
