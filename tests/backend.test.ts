/** backend.test.ts —— 后端接缝：LocalBackend 真过（布局/ns隔离/字节共享）+ S3 桩断言（fixture 全在 /tmp）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend, S3Backend, assertNsName, createBackend } from "../src/backend.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "vault-backend-"));
}

describe("assertNsName", () => {
  test("合法 ns 放行；非法 fail-loud 中文错", () => {
    assertNsName("ledger");
    assertNsName("script-v2");
    assertNsName("a");
    for (const bad of ["", "A", "a_b", "a/b", "a.b", "a b", "x".repeat(33), undefined, null, 7]) {
      assert.throws(() => assertNsName(bad), /ns 非法/, JSON.stringify(bad));
    }
  });
});

describe("LocalBackend 布局", () => {
  test("一 ns 一库：ns/a 与 ns/b 各自 store.db；blobs 全局共享", async () => {
    const b = new LocalBackend(tmpRoot());
    assert.equal(b.kind, "local");
    const da = b.openDb("aaa");
    const db = b.openDb("bbb");
    try {
      assert.ok(da.path.endsWith(join("ns", "aaa", "store.db")), da.path);
      assert.ok(db.path.endsWith(join("ns", "bbb", "store.db")), db.path);
      assert.notEqual(da.path, db.path);
      // 字节跨 ns 共享：同字节只落一份（全局 blobs 家）。
      const p = await b.putBlob({ bytes: Buffer.from("shared-bytes") });
      assert.ok(p.storedPath.startsWith(b.blobsDir), p.storedPath);
      assert.equal(b.getBlobPath(p.sha256), p.storedPath);
    } finally {
      da.close();
      db.close();
      da.close(); // close 幂等
    }
  });

  test("ns 数据隔离：a 写 b 不可见", () => {
    const b = new LocalBackend(tmpRoot());
    const da = b.openDb("aaa");
    try {
      da.db.exec(`CREATE TABLE aaa__t (v TEXT)`);
      da.db.exec(`INSERT INTO aaa__t (v) VALUES ('1')`);
    } finally {
      da.close();
    }
    const db = b.openDb("bbb");
    try {
      assert.throws(() => db.db.prepare(`SELECT * FROM aaa__t`).all(), /no such table/);
    } finally {
      db.close();
    }
  });

  test("空 vaultDir 抛；非法 ns 抛；坏库 fail-loud 带 ns", () => {
    assert.throws(() => new LocalBackend("  "), /vaultDir/);
    const b = new LocalBackend(tmpRoot());
    assert.throws(() => b.openDb("Bad!"), /ns 非法/);
    const root = tmpRoot();
    const bad = new LocalBackend(root);
    mkdirSync(join(root, "ns"), { recursive: true });
    writeFileSync(join(root, "ns", "zzz"), "not-a-dir");
    assert.throws(() => bad.openDb("zzz"), /打开 ns 库失败/);
  });

  test("ns 库自带版本戳（与库底座同门，不 bump）", () => {
    const b = new LocalBackend(tmpRoot());
    const h = b.openDb("ver");
    try {
      const row = h.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      assert.equal(row.value, "1");
      assert.ok(existsSync(h.path));
    } finally {
      h.close();
    }
  });
});

describe("S3Backend 桩", () => {
  test("构造即抛 not-implemented + 出路（不回落 local）", () => {
    assert.throws(() => new S3Backend(), /未实现/);
    assert.throws(() => new S3Backend(), /local/);
    assert.throws(() => createBackend("s3", tmpRoot()), /未实现/);
  });

  test("createBackend：local 真建；未知种别 fail-loud", () => {
    assert.equal(createBackend("local", tmpRoot()).kind, "local");
    assert.throws(() => createBackend("gcs" as never, tmpRoot()), /backend 非法/);
  });
});
