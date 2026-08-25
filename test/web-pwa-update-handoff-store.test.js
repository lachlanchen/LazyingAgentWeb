import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserUpdateHandoffStore,
  updateHandoffStorageKeysToDelete,
} from "../src/web/pwa-update-handoff-store.js";

const SOURCE_RELEASE = `release-${"a".repeat(64)}`;
const TARGET_RELEASE = `release-${"b".repeat(64)}`;

function storedRecord(index, createdAt) {
  const handoffId = index.toString(16).padStart(64, "0");
  return {
    key: `/\u0000${handoffId}`,
    value: {
      schemaVersion: "1",
      scope: "/",
      handoffId,
      sourceRelease: SOURCE_RELEASE,
      targetRelease: TARGET_RELEASE,
      createdAt,
      expiresAt: createdAt + 5 * 60 * 1_000,
      iv: new Uint8Array(12),
      ciphertext: new Uint8Array(17),
    },
  };
}

function indexedDbHarness() {
  const records = new Map();
  const database = {
    objectStoreNames: { contains: (name) => name === "handoffs" },
    close() {},
    transaction(name) {
      assert.equal(name, "handoffs");
      let pending = 0;
      let completeScheduled = false;
      let finished = false;
      const transaction = {
        error: null,
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => transaction.onabort?.());
        },
      };
      const maybeComplete = () => {
        if (finished || pending !== 0 || completeScheduled) return;
        completeScheduled = true;
        queueMicrotask(() => {
          completeScheduled = false;
          if (finished || pending !== 0) return;
          finished = true;
          transaction.oncomplete?.();
        });
      };
      const request = (operation) => {
        pending += 1;
        queueMicrotask(() => {
          operation();
          pending -= 1;
          maybeComplete();
        });
      };
      const store = {
        put(value, key) {
          request(() => records.set(key, structuredClone(value)));
        },
        delete(key) {
          request(() => records.delete(key));
        },
        get(key) {
          const result = {};
          request(() => {
            result.result = records.has(key) ? structuredClone(records.get(key)) : undefined;
            result.onsuccess?.();
          });
          return result;
        },
        openCursor() {
          const result = {};
          pending += 1;
          queueMicrotask(() => {
            const entries = [...records.entries()];
            let index = 0;
            const advance = () => {
              if (index >= entries.length) {
                result.result = null;
                result.onsuccess?.();
                pending -= 1;
                maybeComplete();
                return;
              }
              const [key, value] = entries[index++];
              result.result = {
                key,
                value: structuredClone(value),
                continue() { queueMicrotask(advance); },
              };
              result.onsuccess?.();
            };
            advance();
          });
          return result;
        },
      };
      transaction.objectStore = (storeName) => {
        assert.equal(storeName, "handoffs");
        return store;
      };
      return transaction;
    },
  };
  return {
    records,
    indexedDB: {
      open(name, version) {
        assert.equal(name, "lazying-agent-web-update-handoff");
        assert.equal(version, 1);
        const result = {};
        queueMicrotask(() => {
          result.result = database;
          result.onsuccess?.();
        });
        return result;
      },
    },
  };
}

test("encrypted update handoff cleanup rejects malformed and expired rows and caps orphan count", () => {
  const entries = [
    storedRecord(1, 1_000),
    storedRecord(2, 2_000),
    storedRecord(3, 3_000),
    storedRecord(4, 4_000),
    storedRecord(5, 5_000),
    storedRecord(6, 6_000),
    { key: "/\u0000foreign", value: { draft: "plaintext must fail closed" } },
  ];
  entries[0].value.expiresAt = 1_001;
  entries[5].value.schemaVersion = "2";
  assert.deepEqual(
    new Set(updateHandoffStorageKeysToDelete(entries, { instant: 7_000 })),
    new Set([entries[0].key, entries[1].key, entries[6].key]),
  );
});

test("encrypted update handoff cleanup never deletes the in-flight protected row", () => {
  const entries = [storedRecord(1, 1_000), storedRecord(2, 2_000)];
  entries[1].value.ciphertext = new Uint8Array(16 * 1024 * 1024 + 160 * 1024 + 21);
  assert.deepEqual(
    updateHandoffStorageKeysToDelete(entries, { instant: 2_000, protectedKey: entries[1].key }),
    [],
  );
});

test("the production IndexedDB store preserves the v2 envelope carrying a mode-aware v3 payload", async () => {
  const harness = indexedDbHarness();
  const now = 10_000;
  const store = createBrowserUpdateHandoffStore({
    indexedDB: harness.indexedDB,
    now: () => now,
  });
  const entry = storedRecord(7, now);
  entry.value.schemaVersion = "2";
  entry.value.ciphertext = Uint8Array.from({ length: 64 }, (_, index) => index);
  await store.save(entry.value);
  assert.equal(harness.records.size, 1);
  const restored = await store.take(entry.value.scope, entry.value.handoffId);
  assert.deepEqual(restored, entry.value);
  assert.equal(harness.records.size, 0);

  await assert.rejects(
    store.save({ ...entry.value, schemaVersion: "3" }),
    /encrypted update handoff is invalid/u,
    "the unchanged outer envelope stays readable by v0.1.27 tabs instead of introducing schema 3 cross-tab pruning",
  );
});
