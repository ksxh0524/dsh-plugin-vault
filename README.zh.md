# vault（通用存储底座）

跨域通用存储底座（私有，不发布）：介质拥有者。一 vault 一目录（`.av/store.db` 存索引、`.av/blobs/` 存字节）；二进制不进库行。本层不知 kind 为何物，不记引用、不做生命周期——那是 `dsh-plugin-asset` 的事。

## 布局

```
plugin-vault/
├── src/
│   ├── index.ts     # 对外出口（设计意图见文件头）
│   ├── schema.ts    # 表结构唯一真源 + SCHEMA_VERSION 门（fail-loud，不迁移）
│   ├── vault.ts     # lazy openVault(vaultDir)（WAL + busy_timeout）、close、integrity_check
│   └── blobs.ts     # 内容寻址存取：.av/blobs/<aa>/<sha256>，流式哈希
└── tests/           # node --test，fixture 只落 os.tmpdir
```

## 口径

- 纯 Node（`node:sqlite` 内置，零第三方依赖）；模块加载期零 IO——`openVault` 只在调用时执行，boot 永不被 DB 拖死。
- 字节内容寻址：同 sha256 只存一份；复存复用（字节数不一致 = 盘被库外动过，fail-loud）。
- 原子落盘：tmp + rename，不留半截文件；大文件流式过盘（两遍、内存恒定）。
- 版本门：`meta.schema_version` 不符抛 `version-mismatch`——删库重建或重建索引，绝不自动迁移（STANDARDS §7）。

## 开发

```bash
pnpm install
pnpm check   # prettier + tsc --noEmit + node --test
```

Conventional Commits 强制（scope：`vault` / `schema` / `blobs` / `tests` / `infra`，见 `commitlint.config.cjs`）。

## 托管

私有独立仓（不发布、不 subtree 推送）。消费方 link 引用（`"dsh-plugin-vault": "link:../plugin-vault"`——禁用 `workspace:` 协议）。
