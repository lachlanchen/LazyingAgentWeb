import { ControlPlaneError, ValidationError } from './errors.js';
import { nowIso } from './validation.js';

export const CONTRACT_VERSION = 1;
export const COMPONENT_ID = 'lazying-agent-web';
export const COMPONENT_ROLE = 'cloud-presentation-control-plane';

const DEFAULT_CLOCK = () => new Date();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createCapabilityContract({ clock = DEFAULT_CLOCK } = {}) {
  if (typeof clock !== 'function') throw new ValidationError('clock must be a function.');
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    generatedAt: nowIso(clock),
    component: {
      id: COMPONENT_ID,
      role: COMPONENT_ROLE,
      standalone: true
    },
    authorities: {
      agent: 'aginti',
      inference: 'localllm',
      transport: 'lazyedge',
      presentation: COMPONENT_ID
    },
    capabilities: {
      accounts: { owner: COMPONENT_ID, available: true },
      browserSessions: {
        owner: COMPONENT_ID,
        available: true,
        rawTokensStored: false,
        maximumPerAccount: 32,
        expiredRowsPruned: true
      },
      csrfBinding: { owner: COMPONENT_ID, available: true, rawTokensStored: false },
      threadPresentationIndex: {
        owner: COMPONENT_ID,
        available: true,
        authoritative: false
      },
      resumableDeliveryCursor: {
        owner: COMPONENT_ID,
        available: true,
        authoritative: false,
        monotonic: true,
        idempotencyReceipts: false
      },
      safeRendering: { owner: COMPONENT_ID, available: false },
      agentThreads: { owner: 'aginti', availableThroughThisComponent: false },
      agentRuns: { owner: 'aginti', availableThroughThisComponent: false },
      contextAndCompaction: { owner: 'aginti', availableThroughThisComponent: false },
      plansAndTools: { owner: 'aginti', availableThroughThisComponent: false },
      artifacts: { owner: 'aginti', availableThroughThisComponent: false },
      inference: { owner: 'localllm', availableThroughThisComponent: false },
      edgeTransport: { owner: 'lazyedge', availableThroughThisComponent: false }
    }
  });
}

export function createHealthContract({ store, clock = DEFAULT_CLOCK } = {}) {
  if (!store || typeof store.healthCheck !== 'function') {
    throw new ValidationError('store must provide healthCheck().');
  }
  if (typeof clock !== 'function') throw new ValidationError('clock must be a function.');
  const checkedAt = nowIso(clock);
  try {
    const storage = store.healthCheck();
    return deepFreeze({
      contractVersion: CONTRACT_VERSION,
      checkedAt,
      status: 'ready',
      component: { id: COMPONENT_ID, role: COMPONENT_ROLE },
      storage,
      dependencies: {
        aginti: 'not_probed',
        localllm: 'not_probed',
        lazyedge: 'not_probed'
      }
    });
  } catch (error) {
    const code = error instanceof ControlPlaneError ? error.code : 'storage_unavailable';
    return deepFreeze({
      contractVersion: CONTRACT_VERSION,
      checkedAt,
      status: 'unavailable',
      component: { id: COMPONENT_ID, role: COMPONENT_ROLE },
      storage: { ready: false, code },
      dependencies: {
        aginti: 'not_probed',
        localllm: 'not_probed',
        lazyedge: 'not_probed'
      }
    });
  }
}
