import { COMPONENT_ID, COMPONENT_ROLE } from './contracts.js';
import { ControlPlaneError, ValidationError } from './errors.js';
import { nowIso } from './validation.js';

export const OPERATOR_HEALTH_SCHEMA = 'lazying-agent-web/operator-health/v1';
export const OPERATOR_HEALTH_TIMEOUT_MS = 5_000;

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const MODEL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SQLITE_VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const STORAGE_FAILURE_REASONS = new Set([
  'storage_corruption',
  'storage_security_error',
  'unsupported_schema'
]);
const DEFAULT_CLOCK = () => new Date();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function storageFailure(error) {
  const reason = error instanceof ControlPlaneError && STORAGE_FAILURE_REASONS.has(error.code)
    ? error.code
    : 'storage_unavailable';
  return Object.freeze({ state: 'unavailable', reason });
}

function storageSuccess(value) {
  if (!value || value.ready !== true
      || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1
      || typeof value.sqliteVersion !== 'string'
      || !SQLITE_VERSION_PATTERN.test(value.sqliteVersion)) {
    throw new TypeError('storage health response is invalid');
  }
  return Object.freeze({
    state: 'ready',
    schemaVersion: value.schemaVersion,
    sqliteVersion: value.sqliteVersion
  });
}

async function inspectStorage(probe) {
  try {
    return storageSuccess(await probe());
  } catch (error) {
    return storageFailure(error);
  }
}

function timeoutError() {
  const error = new Error('operator dependency health probe timed out');
  error.name = 'TimeoutError';
  return error;
}

async function withTimeout(probe, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => probe({ signal: controller.signal })),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function dependencyFailure(error) {
  return Object.freeze({
    state: 'unavailable',
    reason: error?.name === 'TimeoutError' ? 'timeout' : 'dependency_unavailable'
  });
}

async function inspectLocalLlm(probe, timeoutMs) {
  try {
    const value = await withTimeout(probe, timeoutMs);
    if (!value || typeof value.ready !== 'boolean'
        || !Array.isArray(value.availableModelAliases)
        || value.availableModelAliases.length > 64
        || value.availableModelAliases.some((alias) => (
          typeof alias !== 'string' || !MODEL_ALIAS_PATTERN.test(alias)
        ))) {
      throw new TypeError('LocalLLM health response is invalid');
    }
    if (!value.ready) return Object.freeze({ state: 'unavailable', reason: 'model_unavailable' });
    return Object.freeze({
      state: 'ready',
      availableModelAliasCount: value.availableModelAliases.length
    });
  } catch (error) {
    return dependencyFailure(error);
  }
}

async function inspectAginti(probe, timeoutMs) {
  if (probe === null) return Object.freeze({ state: 'not_configured' });
  try {
    const value = await withTimeout(probe, timeoutMs);
    if (!value || typeof value.enabled !== 'boolean') {
      throw new TypeError('AgInTi health response is invalid');
    }
    return Object.freeze({
      state: 'ready',
      capabilityEnabled: value.enabled
    });
  } catch (error) {
    return dependencyFailure(error);
  }
}

export async function createOperatorHealthReport({
  releaseId,
  cloudIndexProbe,
  directChatProbe,
  localLlmProbe,
  agintiProbe = null,
  dependencyTimeoutMs = OPERATOR_HEALTH_TIMEOUT_MS,
  clock = DEFAULT_CLOCK
} = {}) {
  if (typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new ValidationError('releaseId is invalid.');
  }
  if (typeof cloudIndexProbe !== 'function' || typeof directChatProbe !== 'function'
      || typeof localLlmProbe !== 'function'
      || (agintiProbe !== null && typeof agintiProbe !== 'function')) {
    throw new ValidationError('operator health probes must be functions or an absent AgInTi probe.');
  }
  if (!Number.isSafeInteger(dependencyTimeoutMs)
      || dependencyTimeoutMs < 10 || dependencyTimeoutMs > 30_000) {
    throw new ValidationError('dependencyTimeoutMs is outside the operator health bound.');
  }
  if (typeof clock !== 'function') throw new ValidationError('clock must be a function.');

  const checkedAt = nowIso(clock);
  const [cloudIndexStore, directChatStore, localLlm, aginti] = await Promise.all([
    inspectStorage(cloudIndexProbe),
    inspectStorage(directChatProbe),
    inspectLocalLlm(localLlmProbe, dependencyTimeoutMs),
    inspectAginti(agintiProbe, dependencyTimeoutMs)
  ]);
  const storageReady = cloudIndexStore.state === 'ready' && directChatStore.state === 'ready';
  const dependenciesReady = localLlm.state === 'ready'
    && (aginti.state === 'ready' || aginti.state === 'not_configured');

  return deepFreeze({
    schema: OPERATOR_HEALTH_SCHEMA,
    checkedAt,
    status: storageReady ? (dependenciesReady ? 'ready' : 'degraded') : 'unavailable',
    component: {
      id: COMPONENT_ID,
      role: COMPONENT_ROLE,
      releaseId
    },
    scope: {
      audience: 'operator',
      publicHttpEndpoint: false,
      staticShell: 'independent'
    },
    storage: { cloudIndexStore, directChatStore },
    dependencies: {
      localLlm,
      aginti,
      lazyEdge: {
        state: 'not_probed',
        healthClaim: false,
        authority: 'lazyedge'
      }
    }
  });
}
