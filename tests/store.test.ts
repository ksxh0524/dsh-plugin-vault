/** store.test.ts —— SQLite 引擎：建库/版本门/自检/空参（fixture 全在 /tmp，不碰老树）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, integrityCheck } from "../src/store.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "asset-store-")), ".av", "store.db");
}

describe("openStore", () => {
  test("新库建表并 stamped 版本", () => {
    const h = openStore(tmpDb());
    try {
      const row = h.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      assert.equal(row.value, String(SCHEMA_VERSION));
    } finally {
      h.close();
    }
  });

  test("重复 open 同库幂等", () => {
    const p = tmpDb();
    const a = openStore(p);
    a.close();
    const b = openStore(p);
    try {
      const row = b.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      assert.equal(row.value, String(SCHEMA_VERSION));
    } finally {
      b.close();
    }
  });

  test("版本不符抛 version-mismatch（不迁移）", () => {
    const p = tmpDb();
    openStore(p).close();
    const raw = new DatabaseSync(p);
    try {
      raw.exec(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`);
    } finally {
      raw.close();
    }
    assert.throws(() => openStore(p), /version-mismatch/);
  });

  test("空 dbPath 抛", () => {
    assert.throws(() => openStore("  "), /dbPath/);
  });

  test("close 幂等", () => {
    const h = openStore(tmpDb());
    h.close();
    h.close();
  });
});

describe("integrityCheck", () => {
  test("健康库为 ok", () => {
    const h = openStore(tmpDb());
    try {
      integrityCheck(h);
    } finally {
      h.close();
    }
  });
});
