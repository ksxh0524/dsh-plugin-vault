/** hardening.test.ts —— 并发/坏库/坏注册表的负向门（真执行被测行为，不凑绿）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { addRef, refCount, registerAsset, tombstone } from "../src/refs.ts";
import { readRegistry, resolveVault, VAULT_REGISTRY_ENV } from "../src/registry.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("并发（同库双句柄）", () => {
  test("A 写 B 读可见；B 关后 A 照常", () => {
    const p = join(mkdtempSync(join(tmpdir(), "asset-hard-")), "store.db");
    const a = openStore(p);
    const b = openStore(p);
    try {
      const row = registerAsset(a.db, { kind: "cover", sha256: sha("conc"), bytes: 4, path: "/v/c.png" });
      addRef(a.db, row.id, "projA");
      const seen = b.db.prepare(`SELECT id FROM assets WHERE id = ?`).get(row.id) as { id: string } | undefined;
      assert.equal(seen?.id, row.id);
      assert.equal(refCount(b.db, row.id), 1);
    } finally {
      b.close();
    }
    const row2 = registerAsset(a.db, { kind: "cover", sha256: sha("conc2"), bytes: 1, path: "/v/d.png" });
    assert.ok(row2.id.length === 64);
    a.close();
  });
});

describe("坏库 fail-loud", () => {
  test("非 SQLite 文件 open 即抛带路径错", () => {
    const f = join(mkdtempSync(join(tmpdir(), "asset-hard-")), "store.db");
    writeFileSync(f, "根本不是数据库", "utf8");
    assert.throws(() => openStore(f), /打开失败/);
  });
});

describe("坏注册表 fail-loud", () => {
  test("顶层数组形状非法抛", () => {
    const f = join(mkdtempSync(join(tmpdir(), "asset-hard-")), "vaults.json");
    writeFileSync(f, `["x"]`, "utf8");
    assert.throws(() => readRegistry({ env: { [VAULT_REGISTRY_ENV]: f } }), /形状非法/);
  });

  test("tombstone 幂等：重复记不抛", () => {
    const h = openStore(join(mkdtempSync(join(tmpdir(), "asset-hard-")), "store.db"));
    try {
      const row = registerAsset(h.db, { kind: "clip", sha256: sha("t2"), bytes: 2, path: "/v/e.mp4" });
      tombstone(h.db, row.id, "r1");
      tombstone(h.db, row.id, "r2");
      const iso = join(mkdtempSync(join(tmpdir(), "asset-hard-")), "vaults.json");
      assert.throws(() => resolveVault("nope-never", { env: { [VAULT_REGISTRY_ENV]: iso } }), /asset-store 未定位 vault/);
    } finally {
      h.close();
    }
  });
});
