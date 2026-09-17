/** contract.test.ts —— 后端契约：同一套断言跑文件后端与内存后端两遍（抄宿主 conformance 思路）。
 *  后端可换（sqlite 现有、S3 占位）而不改调用方，靠的就是这套契约钉住行为。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryVault, openVault, integrityCheck, type VaultHandle } from "../src/vault.ts";
import { getBlobPath, putBlob } from "../src/blobs.ts";

/** 契约断言：任一后端打开的句柄都必须满足。只assert行为，不碰后端私事。 */
async function runVaultContract(open: () => VaultHandle): Promise<void> {
  const h = open();
  try {
    integrityCheck(h);
    const data = Buffer.from("contract-bytes");
    const p = await putBlob(h, { bytes: data });
    assert.equal(typeof p.sha256, "string");
    assert.equal(p.sha256.length, 64);
    assert.equal(p.bytes, data.length);
    assert.equal(getBlobPath(h, p.sha256), p.storedPath);
    const again = await putBlob(h, { bytes: data });
    assert.equal(again.storedPath, p.storedPath);
    assert.throws(() => getBlobPath(h, "0".repeat(64)), /先 putBlob/);
    h.close();
    h.close(); // close 幂等也是契约
  } finally {
    try {
      h.close();
    } catch {
      /* 已关即过 */
    }
  }
}

describe("后端契约", () => {
  test("文件后端满足契约", async () => {
    await runVaultContract(() => openVault(mkdtempSync(join(tmpdir(), "vault-contract-"))));
  });

  test("内存后端满足同一契约", async () => {
    await runVaultContract(() => openMemoryVault());
  });
});
