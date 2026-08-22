import { createHash } from 'node:crypto';

import {
  createAgintiAgentAdapter,
  validateAgintiTransportCredential
} from './aginti-adapter.js';
import { DirectChatContextCoordinator } from './chat-context.js';
import { DirectChatStore } from './chat-store.js';
import { createCloudServer } from './cloud-server.js';
import { createDeterministicContextSummarizer } from './deterministic-context-summarizer.js';
import { createLocalLlmConnector } from './localllm-connector.js';
import {
  createScryptPasswordVerifier,
  validateScryptPasswordHash
} from './password-verifier.js';
import { assertLoadedServiceConfig } from './service-config.js';
import { CloudIndexStore } from './store.js';
import {
  createStandaloneAssetMap,
  verifyStandaloneAssetMap
} from './web/asset-map.js';

export const TRUSTED_STANDALONE_BOOTSTRAP_SOURCE = `
import katex from "./katex.mjs";
import { createBrowserApp } from "./browser-app.js";
import { createSafeRenderer } from "./safe-rendering.js";

const renderer = createSafeRenderer({ katex });
const app = createBrowserApp({ renderer });
void app.initialize();
`;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateTransportCredential(value, label) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4_096
      || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} transport credential is invalid`);
  }
  return true;
}

async function buildAssetMap(config) {
  const assetMap = await createStandaloneAssetMap({
    bootstrapSource: TRUSTED_STANDALONE_BOOTSTRAP_SOURCE,
    versionLabel: config.pwa.versionLabel,
    basePath: '/',
    title: config.pwa.title,
    loginPath: '/api/login',
    name: config.pwa.name,
    shortName: config.pwa.shortName
  });
  verifyStandaloneAssetMap(assetMap);
  if (assetMap.serviceWorkerRoute !== '/sw.js') {
    throw new TypeError('standalone PWA service worker must remain at stable /sw.js');
  }
  return assetMap;
}

async function materializeInputs(loadedConfig, { createVerifier = true } = {}) {
  const loaded = assertLoadedServiceConfig(loadedConfig);
  let passwordHash = loaded.readCredential('passwordHash');
  let passwordVerifier;
  try {
    if (createVerifier) passwordVerifier = createScryptPasswordVerifier(passwordHash);
    else validateScryptPasswordHash(passwordHash);
  } finally {
    passwordHash = null;
  }
  let localLlmCredential = loaded.readCredential('localLlmToken');
  try {
    validateTransportCredential(localLlmCredential, 'LocalLLM');
  } finally {
    localLlmCredential = null;
  }
  if (loaded.config.aginti.enabled) {
    let agintiCredential = loaded.readCredential('agintiToken');
    try {
      validateAgintiTransportCredential(agintiCredential);
    } finally {
      agintiCredential = null;
    }
  }
  const assetMap = await buildAssetMap(loaded.config);
  return Object.freeze({
    loaded,
    passwordVerifier,
    assetMap,
    localLlmCredentialProvider: loaded.createCredentialProvider('localLlmToken'),
    ...(loaded.config.aginti.enabled
      ? { agintiCredentialProvider: loaded.createCredentialProvider('agintiToken') }
      : {})
  });
}

function accountProvisionKey(config) {
  return `service-account-v1.${sha256(JSON.stringify({
    principalId: config.account.principalId,
    username: config.account.username,
    displayName: config.account.displayName
  }))}`;
}

function closeStores(controlStore, directChatStore) {
  const failures = [];
  for (const store of [directChatStore, controlStore]) {
    if (!store) continue;
    try {
      store.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'service stores did not close cleanly');
}

function safeReport(config, assetMap) {
  return Object.freeze({
    valid: true,
    schema: config.schema,
    listen: Object.freeze({ ...config.listen }),
    publicOrigin: config.publicOrigin,
    releaseId: assetMap.releaseVersion,
    serviceWorkerRoute: assetMap.serviceWorkerRoute,
    agentEnabled: false,
    agentConfigured: config.aginti.enabled,
    directChatEnabled: true
  });
}

function safeEdgeRouteManifest(config, assetMap) {
  verifyStandaloneAssetMap(assetMap);
  const requestTargets = Object.freeze([...assetMap.routes]);
  const paths = Object.freeze([...new Set(requestTargets.map((target) => target.split('?', 1)[0]))].sort());
  if (paths.some((pathname) => typeof pathname !== 'string' || !pathname.startsWith('/'))
      || requestTargets.some((target) => typeof target !== 'string' || !target.startsWith('/'))) {
    throw new TypeError('standalone PWA edge route manifest is invalid');
  }
  return Object.freeze({
    schema: 'lazying-agent-web/edge-route-manifest/v1',
    publicOrigin: config.publicOrigin,
    releaseId: assetMap.releaseVersion,
    methods: Object.freeze(['GET', 'HEAD']),
    paths,
    requestTargets
  });
}

export async function checkStandaloneServiceConfiguration(loadedConfig) {
  const materialized = await materializeInputs(loadedConfig, { createVerifier: false });
  return safeReport(materialized.loaded.config, materialized.assetMap);
}

export async function createStandaloneServiceEdgeRouteManifest(loadedConfig) {
  const materialized = await materializeInputs(loadedConfig, { createVerifier: false });
  return safeEdgeRouteManifest(materialized.loaded.config, materialized.assetMap);
}

export async function createStandaloneService({
  loadedConfig,
  fetchImpl,
  localSummarizer,
  serverFactory = createCloudServer,
  clock
} = {}) {
  if (typeof serverFactory !== 'function') throw new TypeError('serverFactory must be a function');
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }
  if (localSummarizer !== undefined && localSummarizer !== null
      && (typeof localSummarizer !== 'object' || localSummarizer.locality !== 'local'
        || typeof localSummarizer.summarizeDirectChat !== 'function')) {
    throw new TypeError('localSummarizer must be a local-only Direct Chat summarizer');
  }
  if (clock !== undefined && typeof clock !== 'function') throw new TypeError('clock must be a function');

  const materialized = await materializeInputs(loadedConfig);
  const config = materialized.loaded.config;
  let controlStore;
  let directChatStore;
  let server;
  try {
    controlStore = new CloudIndexStore({
      databasePath: config.state.cloudIndexDatabase,
      ...(clock === undefined ? {} : { clock })
    });
    directChatStore = new DirectChatStore({
      databasePath: config.state.directChatDatabase,
      modelAlias: config.localLlm.defaultModelAlias,
      visionModelAlias: config.localLlm.vision.modelAlias,
      enableVisionAttachments: config.localLlm.vision.enabled,
      ...(clock === undefined ? {} : { clock })
    });
    const account = controlStore.provisionAccount({
      accountId: config.account.principalId,
      issuer: 'local-login',
      subject: config.account.username,
      displayName: config.account.displayName,
      idempotencyKey: accountProvisionKey(config)
    });
    if (account.issuer !== 'local-login' || account.subject !== config.account.username
        || account.displayName !== config.account.displayName) {
      throw new TypeError('provisioned account does not match the immutable service identity config');
    }
    const directChatSummarizer = localSummarizer ?? createDeterministicContextSummarizer();
    const directChatContext = new DirectChatContextCoordinator({
      store: directChatStore,
      localSummarizer: directChatSummarizer
    });
    const directChatConnector = createLocalLlmConnector({
      baseUrl: config.localLlm.baseUrl,
      allowedModelAliases: config.localLlm.allowedModelAliases,
      credentialProvider: materialized.localLlmCredentialProvider,
      ...(fetchImpl === undefined ? {} : { fetchImpl })
    });
    const agintiAdapter = config.aginti.enabled
      ? createAgintiAgentAdapter({
          upstream: config.aginti.baseUrl,
          credentialProvider: materialized.agintiCredentialProvider,
          ...(fetchImpl === undefined ? {} : { fetchImpl })
        })
      : null;
    server = serverFactory({
      releaseId: materialized.assetMap.releaseVersion,
      assetMap: materialized.assetMap,
      publicOrigin: config.publicOrigin,
      account: {
        username: config.account.username,
        principalId: config.account.principalId
      },
      passwordVerifier: materialized.passwordVerifier,
      sessionStore: controlStore,
      controlStore,
      directChatStore,
      directChatContext,
      directChatSummarizer,
      directChatConnector,
      visionEnabled: config.localLlm.vision.enabled,
      visionModelAlias: config.localLlm.vision.modelAlias,
      agintiAdapter,
      ...(clock === undefined ? {} : { clock })
    });
    if (!server || typeof server.listen !== 'function' || typeof server.shutdown !== 'function'
        || typeof server.address !== 'function' || typeof server.once !== 'function'
        || typeof server.removeListener !== 'function') {
      throw new TypeError('serverFactory returned an invalid graceful server');
    }

    let startPromise = null;
    let shutdownPromise = null;
    let stopped = false;
    const start = () => {
      if (stopped) return Promise.reject(new Error('standalone service is already stopped'));
      if (startPromise) return startPromise;
      startPromise = new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(config.listen.port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          const address = server.address();
          if (!address || typeof address !== 'object' || address.address !== '127.0.0.1'
              || address.port !== config.listen.port) {
            void shutdown();
            reject(new Error('server did not bind the exact configured loopback endpoint'));
            return;
          }
          resolve(Object.freeze({ address: '127.0.0.1', port: address.port }));
        });
      });
      return startPromise;
    };
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      stopped = true;
      shutdownPromise = (async () => {
        const failures = [];
        try {
          await server.shutdown();
        } catch (error) {
          failures.push(error);
        }
        try {
          closeStores(controlStore, directChatStore);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'standalone service shutdown failed');
      })();
      return shutdownPromise;
    };

    return Object.freeze({
      kind: 'lazying-agent-standalone-service',
      releaseId: materialized.assetMap.releaseVersion,
      listen: Object.freeze({ ...config.listen }),
      publicOrigin: config.publicOrigin,
      account: Object.freeze({ ...account }),
      agentEnabled: false,
      assetMap: materialized.assetMap,
      server,
      controlStore,
      directChatStore,
      directChatContext,
      directChatSummarizer,
      directChatConnector,
      agintiAdapter,
      start,
      shutdown
    });
  } catch (error) {
    try {
      if (server?.shutdown) await server.shutdown();
    } catch {
      // Preserve the construction failure.
    }
    try {
      closeStores(controlStore, directChatStore);
    } catch {
      // Preserve the construction failure.
    }
    throw error;
  }
}
