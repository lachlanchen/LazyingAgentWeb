import assert from "node:assert/strict";
import test from "node:test";

import { updateHandoffStorageKeysToDelete } from "../src/web/pwa-update-handoff-store.js";

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
  assert.deepEqual(
    new Set(updateHandoffStorageKeysToDelete(entries, { instant: 7_000 })),
    new Set([entries[0].key, entries[1].key, entries[6].key]),
  );
});

test("encrypted update handoff cleanup never deletes the in-flight protected row", () => {
  const entries = [storedRecord(1, 1_000), storedRecord(2, 2_000)];
  entries[1].value.ciphertext = new Uint8Array(4 * 1024 * 1024 + 160 * 1024 + 21);
  assert.deepEqual(
    updateHandoffStorageKeysToDelete(entries, { instant: 2_000, protectedKey: entries[1].key }),
    [],
  );
});
