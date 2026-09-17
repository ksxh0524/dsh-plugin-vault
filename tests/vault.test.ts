/** vault.test.ts —— 库目录：建库/版本门/自检/空参（fixture 全在 /tmp，不碰老树）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openVault, integrityCheck } from "../src/vault.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "vault-"));
}

describe("openVault", () => {
  test("新库建 store.db 并 stamped 版本（目录即调用方所传）", () => {
    const h = openVault(tmpVault());
    try {
      assert.ok(h.path.endsWith(join("store.db")));
      const row = h.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      assert.equal(row.value, String(SCHEMA_VERSION));
    } finally {
      h.close();
    }
  });

  test("重复 open 同 vault 幂等", () => {
    const v = tmpVault();
    const a = openVault(v);
    a.close();
    const b = openVault(v);
    try {
      const row = b.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      assert.equal(row.value, String(SCHEMA_VERSION));
    } finally {
      b.close();
    }
  });

  test("版本不符抛 version-mismatch（不迁移）", () => {
    const v = tmpVault();
    const h = openVault(v);
    const p = h.path;
    h.close();
    const raw = new DatabaseSync(p);
    try {
      raw.exec(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`);
    } finally {
      raw.close();
    }
    assert.throws(() => openVault(v), /version-mismatch/);
  });

  test("空 vaultDir 抛", () => {
    assert.throws(() => openVault("  "), /vaultDir/);
  });

  test("close 幂等", () => {
    const h = openVault(tmpVault());
    h.close();
    h.close();
  });
});

describe("integrityCheck", () => {
  test("健康库为 ok", () => {
    const h = openVault(tmpVault());
    try {
      integrityCheck(h);
    } finally {
      h.close();
    }
  });
});
