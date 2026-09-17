/** registry.test.ts —— 注册表三级注入 + 登记往返（env 隔离，不碰 ~/.av 真表）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VAULT_REGISTRY_ENV, readRegistry, registerVault, resolveRegistryPath, resolveVault } from "../src/registry.ts";

function tmpReg(): { file: string; env: Record<string, string | undefined> } {
  const file = join(mkdtempSync(join(tmpdir(), "asset-reg-")), "vaults.json");
  return { file, env: { [VAULT_REGISTRY_ENV]: file } };
}

describe("resolveRegistryPath", () => {
  test("config > env > 缺省", () => {
    const { file, env } = tmpReg();
    assert.equal(resolveRegistryPath({ configPath: "/tmp/x.json", env }), resolve("/tmp/x.json"));
    assert.equal(resolveRegistryPath({ env }), resolve(file));
    const dflt = resolveRegistryPath({ env: {} });
    assert.equal(dflt, resolve(homedir(), ".av", "vaults.json"));
  });
});

describe("readRegistry", () => {
  test("缺文件 = 空表", () => {
    const { env } = tmpReg();
    assert.deepEqual(readRegistry({ env }), {});
  });

  test("坏 JSON fail-loud", () => {
    const { file, env } = tmpReg();
    writeFileSync(file, "{broken", "utf8");
    assert.throws(() => readRegistry({ env }), /损坏/);
  });
});

describe("registerVault / resolveVault", () => {
  test("登记往返 + 裸路径直认", () => {
    const { env } = tmpReg();
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    mkdirSync(join(dir, ".av"), { recursive: true });
    registerVault("demo", dir, { env });
    assert.equal(resolveVault("demo", { env }), resolve(dir));
    assert.equal(resolveVault(dir, { env }), resolve(dir));
  });

  test("未登记且路径不存在：fail-loud 列出路", () => {
    const { env } = tmpReg();
    assert.throws(() => resolveVault("ghost", { env }), /三条出路/);
  });

  test("缺 idOrPath 抛", () => {
    const { env } = tmpReg();
    assert.throws(() => resolveVault("  ", { env }), /idOrPath/);
  });
});
