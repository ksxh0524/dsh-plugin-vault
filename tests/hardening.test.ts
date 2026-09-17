/** hardening.test.ts —— 并发/坏库/坏盘的负向门（真执行被测行为，不凑绿）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVault } from "../src/vault.ts";
import { putBlob } from "../src/blobs.ts";

describe("并发（同 vault 双句柄）", () => {
  test("A 写 B 读可见；B 关后 A 照常", () => {
    const v = mkdtempSync(join(tmpdir(), "vault-hard-"));
    const a = openVault(v);
    const b = openVault(v);
    try {
      a.db.exec(`INSERT INTO meta (key, value) VALUES ('probe', '1')`);
      const seen = b.db.prepare(`SELECT value FROM meta WHERE key = 'probe'`).get() as { value: string };
      assert.equal(seen.value, "1");
    } finally {
      b.close();
    }
    a.db.exec(`INSERT INTO meta (key, value) VALUES ('probe2', '2')`);
    const seen2 = a.db.prepare(`SELECT value FROM meta WHERE key = 'probe2'`).get() as { value: string };
    assert.equal(seen2.value, "2");
    a.close();
  });
});

describe("坏库 fail-loud", () => {
  test("非 SQLite 文件 open 即抛带路径错", () => {
    const v = mkdtempSync(join(tmpdir(), "vault-hard-"));
    writeFileSync(join(v, "store.db"), "根本不是数据库", "utf8");
    assert.throws(() => openVault(v), /打开失败/);
  });
});

describe("坏盘 fail-loud", () => {
  test("落盘文件被篡改后复存抛字节冲突", async () => {
    const h = openVault(mkdtempSync(join(tmpdir(), "vault-hard-")));
    try {
      const data = Buffer.from("hardening-blob-1");
      const p = await putBlob(h, { bytes: data });
      writeFileSync(p.storedPath, "x");
      await assert.rejects(putBlob(h, { bytes: data }), /字节冲突/);
    } finally {
      h.close();
    }
  });
});
