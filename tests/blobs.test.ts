/** blobs.test.ts —— 字节拥有者：存/取/幂等/冲突 fail-loud（fixture 全在 /tmp）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVault } from "../src/vault.ts";
import { putBlob, getBlobPath, blobPathFor } from "../src/blobs.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "vault-blob-"));
}

describe("putBlob", () => {
  test("bytes 源存取往返：指针字段齐 + 路径在 blobs 家目录下", async () => {
    const h = openVault(tmpVault());
    try {
      const data = Buffer.from("hello-vault-bytes");
      const p = await putBlob(h, { bytes: data });
      assert.equal(p.sha256, sha(data));
      assert.equal(p.bytes, data.length);
      assert.ok(p.storedPath.startsWith(h.blobsDir));
      assert.equal(getBlobPath(h, p.sha256), p.storedPath);
    } finally {
      h.close();
    }
  });

  test("同 sha 幂等：复用同一文件，不重写", async () => {
    const h = openVault(tmpVault());
    try {
      const data = Buffer.from("dedup-me");
      const a = await putBlob(h, { bytes: data });
      const b = await putBlob(h, { bytes: data });
      assert.equal(a.storedPath, b.storedPath);
      assert.equal(a.sha256, b.sha256);
    } finally {
      h.close();
    }
  });

  test("path 源：流式哈希与 bytes 源同 sha", async () => {
    const dir = tmpVault();
    const h = openVault(dir);
    try {
      const data = Buffer.from("file-source-bytes");
      const src = join(dir, "in.bin");
      writeFileSync(src, data);
      const p = await putBlob(h, { path: src });
      assert.equal(p.sha256, sha(data));
      assert.equal(p.bytes, data.length);
    } finally {
      h.close();
    }
  });

  test("空 path 抛；空 bytes 抛；源文件缺席抛带路径错", async () => {
    const h = openVault(tmpVault());
    try {
      await assert.rejects(putBlob(h, { path: "  " }), /缺 path/);
      await assert.rejects(putBlob(h, { bytes: new Uint8Array(0) }), /非空/);
      await assert.rejects(putBlob(h, { path: join(tmpVault(), "nope.bin") }), /源文件不可读/);
    } finally {
      h.close();
    }
  });

  test("同 sha 字节数不一致 = 盘被外人动过，抛", async () => {
    const h = openVault(tmpVault());
    try {
      const data = Buffer.from("twelve-bytes!");
      const p = await putBlob(h, { bytes: data });
      writeFileSync(p.storedPath, "tampered!!"); // 同路径、不同字节数
      await assert.rejects(putBlob(h, { bytes: data }), /字节冲突/);
    } finally {
      h.close();
    }
  });
});

describe("getBlobPath", () => {
  test("未存 sha 抛（带期望位置）；非法 sha 抛", () => {
    const h = openVault(tmpVault());
    try {
      assert.throws(() => getBlobPath(h, sha("never-stored")), /先 putBlob/);
      assert.throws(() => getBlobPath(h, "xyz"), /非法 sha256/);
      assert.throws(() => blobPathFor(h.blobsDir, ""), /非法 sha256/);
    } finally {
      h.close();
    }
  });
});
