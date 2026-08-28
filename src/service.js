import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  createAgintiAgentAdapter,
  validateAgintiTransportCredential
} from './aginti-adapter.js';
import { DirectChatContextCoordinator } from './chat-context.js';
import {
  CHAT_SQLITE_APPLICATION_ID,
  DEFAULT_CHAT_SCHEMA_VERSION,
  LATEST_CHAT_SCHEMA_VERSION
} from './chat-migrations.js';
import { DirectChatStore } from './chat-store.js';
import { createCloudServer } from './cloud-server.js';
import { createDeterministicContextSummarizer } from './deterministic-context-summarizer.js';
import { createLocalLlmConnector } from './localllm-connector.js';
import { LATEST_SCHEMA_VERSION, SQLITE_APPLICATION_ID } from './migrations.js';
import {
  DEFAULT_ROLLOUT_ADMISSION_SOCKET,
  RolloutAdmissionLatch,
  validateRolloutAdmissionSocketPath
} from './rollout-admission.js';
import {
  OPERATOR_HEALTH_TIMEOUT_MS,
  createOperatorHealthReport
} from './operator-health.js';
import {
  createScryptPasswordVerifier,
  validateScryptPasswordHash
} from './password-verifier.js';
import { assertLoadedServiceConfig } from './service-config.js';
import { checkSqliteFileHealth } from './sqlite-health.js';
import { CloudIndexStore } from './store.js';
import { AGINTI_RPC_PATHS } from './web/aginti-protocol.js';
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

const OPERATOR_HEALTH_BROWSER_SESSION = sha256('lazying-agent-web/operator-health/v1');

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

export async function checkStandaloneServiceHealth(loadedConfig, {
  fetchImpl,
  dependencyTimeoutMs = OPERATOR_HEALTH_TIMEOUT_MS,
  databaseHealthChecker = checkSqliteFileHealth,
  clock
} = {}) {
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }
  if (typeof databaseHealthChecker !== 'function') {
    throw new TypeError('databaseHealthChecker must be a function');
  }
  if (clock !== undefined && typeof clock !== 'function') throw new TypeError('clock must be a function');

  const loaded = assertLoadedServiceConfig(loadedConfig);
  const config = loaded.config;
  const assetMap = await buildAssetMap(config);
  const localLlmConnector = createLocalLlmConnector({
    baseUrl: config.localLlm.baseUrl,
    allowedModelAliases: config.localLlm.allowedModelAliases,
    credentialProvider: loaded.createCredentialProvider('localLlmToken'),
    ...(fetchImpl === undefined ? {} : { fetchImpl })
  });
  const agintiAdapter = config.aginti.enabled
    ? createAgintiAgentAdapter({
        upstream: config.aginti.baseUrl,
        credentialProvider: loaded.createCredentialProvider('agintiToken'),
        ...(fetchImpl === undefined ? {} : { fetchImpl })
      })
    : null;
  const allowedDirectChatSchemas = config.localLlm.vision.enabled
    ? [LATEST_CHAT_SCHEMA_VERSION]
    : [...new Set([DEFAULT_CHAT_SCHEMA_VERSION, LATEST_CHAT_SCHEMA_VERSION])];

  return createOperatorHealthReport({
    releaseId: assetMap.releaseVersion,
    cloudIndexProbe: () => databaseHealthChecker({
      databasePath: config.state.cloudIndexDatabase,
      expectedApplicationId: SQLITE_APPLICATION_ID,
      allowedSchemaVersions: [LATEST_SCHEMA_VERSION]
    }),
    directChatProbe: () => databaseHealthChecker({
      databasePath: config.state.directChatDatabase,
      expectedApplicationId: CHAT_SQLITE_APPLICATION_ID,
      allowedSchemaVersions: allowedDirectChatSchemas
    }),
    localLlmProbe: ({ signal }) => localLlmConnector.readiness({ signal }),
    agintiProbe: agintiAdapter === null
      ? null
      : ({ signal }) => agintiAdapter.rpc(AGINTI_RPC_PATHS.capabilities, {}, {
          principalId: config.account.principalId,
          browserSession: OPERATOR_HEALTH_BROWSER_SESSION,
          signal
        }),
    dependencyTimeoutMs,
    ...(clock === undefined ? {} : { clock })
  });
}

export async function createStandaloneService({
  loadedConfig,
  fetchImpl,
  localSummarizer,
  serverFactory = createCloudServer,
  rolloutAdmissionSocketPath = DEFAULT_ROLLOUT_ADMISSION_SOCKET,
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
  const admissionSocketPath = validateRolloutAdmissionSocketPath(rolloutAdmissionSocketPath);

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
    const rolloutAdmissionMarker = join(
      dirname(config.state.cloudIndexDatabase),
      'rollout-admission.closed.json'
    );
    const rolloutAdmission = new RolloutAdmissionLatch({
      closedMarkerPath: rolloutAdmissionMarker
    });
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
      rolloutAdmission,
      rolloutAdmissionSocketPath: admissionSocketPath,
      requestOutcomeObserver(outcome) {
        if (outcome.result === 'rejected') {
          console.warn(JSON.stringify({ event: 'cloud_request_outcome', ...outcome }));
        }
      },
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
      startPromise = (async () => {
        if (typeof server.startAdmissionControl === 'function') {
          await server.startAdmissionControl();
        }
        if (stopped || shutdownPromise !== null) {
          throw new Error('standalone service was stopped during startup');
        }
        return await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            server.removeListener('error', onError);
            server.removeListener('close', onClose);
          };
          const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const onError = (error) => {
            fail(error);
          };
          const onClose = () => fail(new Error('standalone service stopped during HTTP startup'));
          server.once('error', onError);
          server.once('close', onClose);
          server.listen(config.listen.port, '127.0.0.1', () => {
            if (stopped || shutdownPromise !== null) {
              fail(new Error('standalone service was stopped during HTTP startup'));
              return;
            }
            const address = server.address();
            if (!address || typeof address !== 'object' || address.address !== '127.0.0.1'
                || address.port !== config.listen.port) {
              void shutdown();
              fail(new Error('server did not bind the exact configured loopback endpoint'));
              return;
            }
            if (settled) return;
            settled = true;
            cleanup();
            resolve(Object.freeze({ address: '127.0.0.1', port: address.port }));
          });
        });
      })();
      return startPromise;
    };
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      stopped = true;
      const pendingStart = startPromise;
      shutdownPromise = (async () => {
        const failures = [];
        try {
          await server.shutdown();
        } catch (error) {
          failures.push(error);
        }
        if (pendingStart !== null) {
          try { await pendingStart; }
          catch {
            // Shutdown owns startup cancellation; its rejection is expected.
          }
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
      rolloutAdmission,
      rolloutAdmissionMarker,
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
