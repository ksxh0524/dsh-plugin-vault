/** tools-blob.test.ts —— blob 双工具：经真 apply 接线捕获注册工具，exec 用最小桩；
 *  断言幂等/冲突/缺失/超限只返路径 + 注册面五工具齐（fixture 全在 /tmp）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/cordis.ts";
import { BLOB_INLINE_LIMIT, VAULT_DIR_ENV, resolveVaultDir, type ToolRecord } from "../src/tools.ts";

const BARE_EXEC = {};

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "vault-tools-blob-"));
}

/** 经真 apply 接线捕获注册工具（不断言 DSH 实例，只取注册面）。 */
function registeredTools(vaultDir: string): ToolRecord[] {
  const tools: ToolRecord[] = [];
  apply(
    {
      tools: {
        register: (t: ToolRecord) => {
          tools.push(t);
          return t;
        },
      },
    },
    { vaultDir, backend: "local" },
  );
  return tools;
}

function byName(tools: ToolRecord[], name: string): ToolRecord {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `应注册工具 ${name}`);
  return t;
}

describe("注册面", () => {
  test("apply 注册五工具，一个不少", () => {
    const names = registeredTools(tmpRoot())
      .map((t) => t.name)
      .sort();
    assert.deepEqual(names, ["vault_db_exec", "vault_db_query", "vault_get_blob", "vault_ns_info", "vault_put_blob"]);
  });
});

describe("vault_put_blob / vault_get_blob", () => {
  test("bytes 源往返：小文件内联 base64", async () => {
    const tools = registeredTools(tmpRoot());
    const put = byName(tools, "vault_put_blob");
    const get = byName(tools, "vault_get_blob");
    const data = Buffer.from("blob-roundtrip");
    const p = (await put.execute({ bytesBase64: data.toString("base64") }, BARE_EXEC)) as { sha256: string; bytes: number; storedPath: string };
    assert.equal(p.sha256.length, 64);
    assert.equal(p.bytes, data.length);
    const g = (await get.execute({ sha256: p.sha256 }, BARE_EXEC)) as { sha256: string; bytes: number; storedPath: string; bytesBase64: string | null };
    assert.equal(g.bytesBase64, data.toString("base64"));
    assert.equal(g.storedPath, p.storedPath);
  });

  test("幂等：同字节复存同一路径", async () => {
    const tools = registeredTools(tmpRoot());
    const put = byName(tools, "vault_put_blob");
    const arg = { bytesBase64: Buffer.from("dedup-bytes").toString("base64") };
    const a = (await put.execute(arg, BARE_EXEC)) as { storedPath: string };
    const b = (await put.execute(arg, BARE_EXEC)) as { storedPath: string };
    assert.equal(a.storedPath, b.storedPath);
  });

  test("冲突：盘被库外改动后复存抛字节冲突", async () => {
    const tools = registeredTools(tmpRoot());
    const put = byName(tools, "vault_put_blob");
    const data = Buffer.from("conflict-12b!");
    const p = (await put.execute({ bytesBase64: data.toString("base64") }, BARE_EXEC)) as { storedPath: string };
    writeFileSync(p.storedPath, "tampered!!");
    await assert.rejects(put.execute({ bytesBase64: data.toString("base64") }, BARE_EXEC), /字节冲突/);
  });

  test("缺失：未存 sha 抛；非法 sha 抛", async () => {
    const tools = registeredTools(tmpRoot());
    const get = byName(tools, "vault_get_blob");
    await assert.rejects(get.execute({ sha256: "0".repeat(64) }, BARE_EXEC), /取字节失败/);
    await assert.rejects(get.execute({ sha256: "xyz" }, BARE_EXEC), /sha256 非法/);
  });

  test("path/bytesBase64 二选一：双空拒、双给拒、相对路径拒", async () => {
    const tools = registeredTools(tmpRoot());
    const put = byName(tools, "vault_put_blob");
    await assert.rejects(put.execute({}, BARE_EXEC), /二选一/);
    await assert.rejects(put.execute({ path: "/tmp/x", bytesBase64: "eA==" }, BARE_EXEC), /二选一/);
    await assert.rejects(put.execute({ path: "rel/in.bin" }, BARE_EXEC), /绝对路径/);
    await assert.rejects(put.execute({ path: join(tmpRoot(), "nope.bin") }, BARE_EXEC), /存字节失败/);
  });

  test("非法 base64 拒；空字节拒", async () => {
    const tools = registeredTools(tmpRoot());
    const put = byName(tools, "vault_put_blob");
    await assert.rejects(put.execute({ bytesBase64: "!!!" }, BARE_EXEC), /非法 base64/);
    await assert.rejects(put.execute({ bytesBase64: "" }, BARE_EXEC), /二选一/);
  });

  test("超 8MB：put 拒（给出路 path 源）；get 只返路径不内联", async () => {
    const root = tmpRoot();
    const tools = registeredTools(root);
    const put = byName(tools, "vault_put_blob");
    const get = byName(tools, "vault_get_blob");
    const big = Buffer.alloc(BLOB_INLINE_LIMIT + 1, 7);
    await assert.rejects(put.execute({ bytesBase64: big.toString("base64") }, BARE_EXEC), /超过 8MB 上限/);
    const src = join(root, "big.bin");
    writeFileSync(src, big);
    const p = (await put.execute({ path: src }, BARE_EXEC)) as { sha256: string; bytes: number; storedPath: string };
    assert.equal(p.bytes, BLOB_INLINE_LIMIT + 1);
    const g = (await get.execute({ sha256: p.sha256 }, BARE_EXEC)) as { bytesBase64: string | null; storedPath: string; bytes: number };
    assert.equal(g.bytesBase64, null);
    assert.equal(g.storedPath, p.storedPath);
    assert.equal(g.bytes, BLOB_INLINE_LIMIT + 1);
  });
});

describe("resolveVaultDir", () => {
  test("config > env > 中性锚；全 miss fail-loud 点名三条出路", () => {
    const root = tmpRoot();
    assert.equal(resolveVaultDir("/tmp", { configVaultDir: root }), root);
    assert.equal(resolveVaultDir("/tmp", { env: { [VAULT_DIR_ENV]: root } }), root);
    const ws = mkdtempSync(join(tmpdir(), "vault-anchor-"));
    const nested = join(ws, "a", "b");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(ws, ".vault"), { recursive: true });
    writeFileSync(join(ws, ".vault", "workspace.json"), JSON.stringify({ v: 1 }));
    assert.equal(resolveVaultDir(nested, { env: {} }), ws);
    assert.throws(() => resolveVaultDir(tmpRoot(), { env: {} }), /config\.vaultDir/);
  });
});
