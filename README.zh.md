# dsh-plugin-vault（通用存储层插件）

通用存储层插件（私有，不发布）：一 ns 一 SQLite 库（`<vaultDir>/ns/<ns>/store.db`），全局内容寻址字节家（`<vaultDir>/blobs/<aa>/<sha256>`）；二进制不进库行。五工具服务各 ns；包根库面（`src/index.ts`）为老调用方冻结（迁移波再断），新代码一律走 `Backend` 接缝（`src/backend.ts`）。

```
plugin-vault/
├── src/
│   ├── index.ts     # 冻结库面（设计意图见文件头；新代码禁引用）
│   ├── schema.ts    # 表结构唯一真源 + SCHEMA_VERSION 门（fail-loud，不迁移）
│   ├── vault.ts     # lazy openVault(vaultDir)（WAL + busy_timeout）、close、integrity_check
│   ├── blobs.ts     # 内容寻址存取：blobs/<aa>/<sha256>，流式哈希
│   ├── backend.ts   # 后端接缝：LocalBackend（一 ns 一库）+ S3Backend 桩
│   ├── tools.ts     # 五工具定义 + token 级 SQL 门禁
│   └── cordis.ts    # 插件壳：{ name, inject, apply }（加载期零 IO）
├── cordis.patch.yml # bundle 层：id dsh-plugin-vault，config 仅 vaultDir + backend 两键
└── tests/           # node --test，fixture 只落 os.tmpdir
```

## 工具与服务

| 工具           | 参数                                                        | 返回                                                                     |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| vault_put_blob | `path` / `bytesBase64`（二选一必填；base64 解码后≤8MB）     | `{ sha256, bytes, storedPath }`                                          |
| vault_get_blob | `sha256`（64 位 hex）                                       | `{ sha256, bytes, storedPath, bytesBase64 }`（超 8MB 返 null，只给路径） |
| vault_db_exec  | `ns`、`sql`（单条写）、`params?`（string/number/null 数组） | `{ changes, lastInsertRowid }`（仅有效 INSERT 有行 id）                  |
| vault_db_query | `ns`、`sql`（单条读）、`params?`                            | `{ columns, rows }`（BLOB 列转 base64）                                  |
| vault_ns_info  | `ns`                                                        | `{ ns, path, tables, integrity }`                                        |

## Contract

无 Remote——只有工具。

| 条目     | 规则                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL 门禁 | `vault_db_exec` 首关键字只收 `INSERT` / `UPDATE` / `DELETE` / `CREATE TABLE` / `CREATE INDEX` / `DROP TABLE` / `DROP INDEX`；`vault_db_query` 仅 `SELECT` / `WITH` / `EXPLAIN`（`EXPLAIN` 套写拒、`WITH` 内写拒） |
| 前缀门禁 | SQL 触及的表/索引须全匹配 `<ns>__*`（`FROM` / `JOIN` / `INTO` / `UPDATE` / `TABLE` / `INDEX` 位，含子查询；串内不算）；schema 限定（`main.t` 形）拒，`TEMP` 表拒，无前缀索引名拒；读面 `WITH` 的 CTE 定义名豁免   |
| 卫生     | 每次调用只收单语句（末尾一个分号容忍）；分号多语句、`ATTACH`、`PRAGMA`、`VACUUM` 两面全禁；语义错一律中文 fail-loud 并给出路，不回落                                                                              |

## Config

| key        | 说明                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vaultDir` | 库根目录（绝对路径）；空 = env `DSH_VAULT_DIR` > 中性锚（从调用会话 cwd 向上找 `.vault/workspace.json`，内容合法 JSON 即认）。全 miss 即 fail-loud——绝不回落机器目录 |
| `backend`  | 仅 `"local"` 真实现；`"s3"` 抛 not-implemented + 出路                                                                                                                |

ns 名须 `^[a-z0-9-]{1,32}$`；ns 含 `-`（如 `script-v2`）时表名须引号包裹（`"script-v2__t"`）：裸写会被 parse 成减号而 fail-closed。

## Install

私有独立仓（不发布）。消费方 link 引用——禁用 `workspace:` 协议：

```sh
# profile package.json dependencies：
"dsh-plugin-vault": "link:../plugin-vault"
```

Bundle 行：id `dsh-plugin-vault`，name `dsh-plugin-vault/cordis`（子路径壳——冻结的包根继续服务老调用方的裸 import）。宿主重启只归用户。

## 验证

```sh
node --test tests/*.test.ts    # 先跑服务端逻辑（ns 隔离、blob 上限、后端真过）
pnpm check                      # prettier + tsc + 全量测试（无 check:browser——无浏览器半）
```

装进任何 profile 前先过 boot 闸：按 `docs/runbooks/plugin-gate.md` 在测试预设上验（绝不动 3080）——壳只注册五工具、加载期零 IO，boot 永不被 DB 拖死。

## Browser half

无浏览器半——无 `lib/`，`package.json` 无 `dsh.client` 项；只有服务端工具。

## 已知边界

- 每次调用只收单语句；`params` 只收 string/number/null。
- 字节全局内容寻址（`<vaultDir>/blobs/<aa>/<sha256>`，跨 ns 同 sha 只存一份）；字节数不一致 = 盘被库外动过，fail-loud。
- `bytesBase64` 解码后≤8MB（大文件走 `path` 源流式入库）；超 8MB 的读只返路径。
- 仅 `local` 后端真实现；插件层不 bump `SCHEMA_VERSION`（不迁移）。
