const HANDOFF_ID = /^[a-f0-9]{64}$/u;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,23}-[a-f0-9]{64}$/u;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_RECORDS = 4;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 160 * 1024 + 20;

function storedEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "ciphertext,createdAt,expiresAt,handoffId,iv,schemaVersion,scope,sourceRelease,targetRelease"
      || value.schemaVersion !== "1" || typeof value.scope !== "string" || value.scope.length < 1 || value.scope.length > 160
      || !HANDOFF_ID.test(value.handoffId) || !RELEASE_ID.test(value.sourceRelease) || !RELEASE_ID.test(value.targetRelease)
      || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || value.expiresAt !== value.createdAt + MAX_AGE_MS
      || !(value.iv instanceof Uint8Array) || value.iv.byteLength !== 12
      || !(value.ciphertext instanceof Uint8Array) || value.ciphertext.byteLength < 17
      || value.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) return null;
  return value;
}

export function updateHandoffStorageKeysToDelete(entries, {
  instant,
  protectedKey = null,
  maximumRecords = MAX_RECORDS,
} = {}) {
  if (!Array.isArray(entries) || !Number.isSafeInteger(instant) || instant < 0
      || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 16) {
    throw new TypeError("update handoff cleanup input is invalid");
  }
  const retained = [];
  const deleted = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.key !== "string") continue;
    const record = storedEnvelope(entry.value);
    const expectedKey = record === null ? null : `${record.scope}\u0000${record.handoffId}`;
    if (record === null || entry.key !== expectedKey || record.expiresAt < instant) {
      if (entry.key !== protectedKey) deleted.add(entry.key);
      continue;
    }
    retained.push({ key: entry.key, createdAt: record.createdAt });
  }
  retained.sort((left, right) => right.createdAt - left.createdAt || left.key.localeCompare(right.key));
  for (const entry of retained.slice(maximumRecords)) {
    if (entry.key !== protectedKey) deleted.add(entry.key);
  }
  return Object.freeze([...deleted]);
}

export function createBrowserUpdateHandoffStore({
  indexedDB = globalThis.indexedDB,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) {
    throw new TypeError("update handoff storage timeout is invalid");
  }
  if (typeof now !== "function") throw new TypeError("update handoff storage clock is invalid");
  const openDatabase = () => new Promise((resolve, reject) => {
    if (!indexedDB || typeof indexedDB.open !== "function") {
      reject(new TypeError("browser update handoff storage is unavailable"));
      return;
    }
    let settled = false;
    let request;
    const finish = (operation, value) => {
      if (settled) {
        if (operation === resolve) value?.close?.();
        return;
      }
      settled = true;
      clearTimeoutImpl?.(timer);
      operation(value);
    };
    const timer = setTimeoutImpl?.(
      () => finish(reject, new TypeError("browser update handoff storage timed out")),
      timeoutMs,
    );
    try { request = indexedDB.open("lazying-agent-web-update-handoff", 1); }
    catch (error) { finish(reject, error); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("handoffs")) database.createObjectStore("handoffs");
    };
    request.onerror = () => finish(reject, request.error ?? new TypeError("browser update handoff storage failed"));
    request.onblocked = () => finish(reject, new TypeError("browser update handoff storage is blocked"));
    request.onsuccess = () => finish(resolve, request.result);
  });
  const transact = async (mode, operation) => {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let result;
        let transaction;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeoutImpl?.(timer);
          callback(value);
        };
        const timer = setTimeoutImpl?.(() => {
          try { transaction?.abort(); } catch { /* A timed-out transaction is already unusable. */ }
          finish(reject, new TypeError("browser update handoff transaction timed out"));
        }, timeoutMs);
        try {
          transaction = database.transaction("handoffs", mode);
          result = operation(transaction.objectStore("handoffs"), transaction);
        } catch (error) { finish(reject, error); return; }
        transaction.oncomplete = () => finish(resolve, typeof result === "function" ? result() : result);
        transaction.onerror = () => finish(
          reject,
          transaction.error ?? new TypeError("browser update handoff transaction failed"),
        );
        transaction.onabort = () => finish(
          reject,
          transaction.error ?? new TypeError("browser update handoff transaction aborted"),
        );
      });
    } finally { database.close(); }
  };
  const storageKey = (scope, handoffId) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 160 || !HANDOFF_ID.test(handoffId)) {
      throw new TypeError("update handoff storage key is invalid");
    }
    return `${scope}\u0000${handoffId}`;
  };
  const prune = (store, protectedKey = null) => {
    const entries = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        entries.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
        return;
      }
      const instant = Number(now());
      for (const key of updateHandoffStorageKeysToDelete(entries, { instant, protectedKey })) store.delete(key);
    };
  };
  return Object.freeze({
    async save(record) {
      const instant = Number(now());
      const envelope = storedEnvelope(record);
      if (envelope === null || !Number.isSafeInteger(instant) || instant < 0
          || envelope.createdAt > instant + 30_000 || envelope.expiresAt < instant) {
        throw new TypeError("encrypted update handoff is invalid");
      }
      const key = storageKey(record?.scope, record?.handoffId);
      await transact("readwrite", (store) => {
        store.put(record, key);
        prune(store, key);
      });
    },
    async take(scope, handoffId) {
      const key = storageKey(scope, handoffId);
      let value;
      await transact("readwrite", (store, transaction) => {
        const request = store.get(key);
        request.onsuccess = () => {
          value = request.result;
          store.delete(key);
          prune(store);
        };
        request.onerror = () => transaction.abort();
      });
      return value ?? null;
    },
    async discard(scope, handoffId) {
      const key = storageKey(scope, handoffId);
      await transact("readwrite", (store) => { store.delete(key); });
    },
  });
}
