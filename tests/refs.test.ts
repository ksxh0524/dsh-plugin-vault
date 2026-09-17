/** refs.test.ts —— 登记幂等/引用计数/tombstone（fixture 全在 /tmp）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type StoreHandle } from "../src/store.ts";
import { addRef, getAsset, isTrashed, listAssets, listHolders, refCount, registerAsset, removeRef, restore, tombstone } from "../src/refs.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function open(): StoreHandle {
  return openStore(join(mkdtempSync(join(tmpdir(), "asset-refs-")), "store.db"));
}

describe("registerAsset", () => {
  test("幂等：同 sha 返回同一行，首见 path 为准", () => {
    const h = open();
    try {
      const a = registerAsset(h.db, { kind: "cover", sha256: sha("x"), bytes: 3, path: "/v/a.png" });
      const b = registerAsset(h.db, { kind: "cover", sha256: sha("x"), bytes: 3, path: "/v/b.png" });
      assert.equal(a.id, b.id);
      assert.equal(b.path, "/v/a.png");
    } finally {
      h.close();
    }
  });

  test("缺 kind/坏 sha/负 bytes 抛", () => {
    const h = open();
    try {
      assert.throws(() => registerAsset(h.db, { kind: "", sha256: sha("x"), bytes: 1, path: "/v/a" }), /kind/);
      assert.throws(() => registerAsset(h.db, { kind: "k", sha256: "zz", bytes: 1, path: "/v/a" }), /sha256/);
      assert.throws(() => registerAsset(h.db, { kind: "k", sha256: sha("x"), bytes: -1, path: "/v/a" }), /bytes/);
    } finally {
      h.close();
    }
  });
});

describe("引用与 tombstone", () => {
  test("addRef 幂等 + 计数 + 去引用归零不删行", () => {
    const h = open();
    try {
      const a = registerAsset(h.db, { kind: "clip", sha256: sha("c1"), bytes: 10, path: "/v/c.mp4" });
      addRef(h.db, a.id, "projA");
      addRef(h.db, a.id, "projA");
      addRef(h.db, a.id, "projB");
      assert.equal(refCount(h.db, a.id), 2);
      assert.deepEqual(listHolders(h.db, a.id), ["projA", "projB"]);
      assert.equal(removeRef(h.db, a.id, "projA"), true);
      assert.equal(removeRef(h.db, a.id, "projA"), false);
      assert.equal(refCount(h.db, a.id), 1);
      assert.ok(getAsset(h.db, a.id) !== null);
    } finally {
      h.close();
    }
  });

  test("tombstone 后拒绝引用，restore 后恢复", () => {
    const h = open();
    try {
      const a = registerAsset(h.db, { kind: "cover", sha256: sha("t1"), bytes: 5, path: "/v/t.png" });
      tombstone(h.db, a.id, "下线");
      assert.equal(isTrashed(h.db, a.id), true);
      assert.throws(() => addRef(h.db, a.id, "projA"), /tombstone/);
      assert.ok(getAsset(h.db, a.id) !== null);
      assert.equal(restore(h.db, a.id), true);
      assert.equal(isTrashed(h.db, a.id), false);
      addRef(h.db, a.id, "projA");
      assert.equal(refCount(h.db, a.id), 1);
    } finally {
      h.close();
    }
  });

  test("listAssets 按 kind 过滤", () => {
    const h = open();
    try {
      registerAsset(h.db, { kind: "cover", sha256: sha("k1"), bytes: 1, path: "/v/1" });
      registerAsset(h.db, { kind: "clip", sha256: sha("k2"), bytes: 1, path: "/v/2" });
      assert.equal(listAssets(h.db, "cover").length, 1);
      assert.equal(listAssets(h.db).length, 2);
    } finally {
      h.close();
    }
  });
});
