# asset-store（通用资产库）

跨域通用资产库（私有，不发布）：SQLite 存结构与索引、文件存字节；二进制不进库行，只记指针 + 哈希 + 引用。一 vault 一库（`<vault>/.av/store.db`），删除只记 tombstone。

## 布局

```
asset-store/
├── src/
│   ├── index.ts     # 对外出口（设计意图见文件头）
│   ├── schema.ts    # 表结构唯一真源 + SCHEMA_VERSION 门（fail-loud，不迁移）
│   ├── store.ts     # lazy open（WAL + busy_timeout）、close、integrity_check
│   ├── registry.ts  # vault 注册表：configPath > ASSET_VAULT_REGISTRY > ~/.av/vaults.json
│   └── refs.ts      # 内容寻址登记 + 引用计数 + tombstone/restore
└── tests/           # node --test，fixture 只落 os.tmpdir
```

## 口径

- 纯 Node（`node:sqlite` 内置，零第三方依赖）；模块加载期零 IO——`openStore` 只在调用时执行，boot 永不被 DB 拖死。
- 内容寻址：`assets.id = sha256`，同一份字节跨项目只存一行，引用方在 `refs` 各自记账，不拷贝。
- 只 tombstone 不真删：`tombstone()` 保留库行与字节，无 GC；要清必须带引用计数显式下令。
- 版本门：`meta.schema_version` 不符抛 `version-mismatch`——删库重建或重建索引，绝不自动迁移（STANDARDS §7）。
- 人物/图片生成暂缓：新种别走 `kind` 字符串 + `metadata` JSON 扩展，不改表。

## 开发

```bash
pnpm install
pnpm check   # prettier + tsc --noEmit + node --test
```

Conventional Commits 强制（scope：`store` / `schema` / `registry` / `refs` / `tests` / `infra`，见 `commitlint.config.cjs`）。

## 托管

私有独立仓（不发布、不 subtree 推送）。消费方 link 引用（`"asset-store": "link:../asset-store"`——禁用 `workspace:` 协议）。
