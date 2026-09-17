/** asset-store —— 通用资产库（跨域中立件；私有，不发 npm）。
 *
 * 一句话：SQLite 存结构与索引、文件存字节；二进制不进库行，只记指针+哈希+引用。
 * 一库一 vault（<vault>/.av/store.db），删只记 tombstone；“哪里启动都能用”靠
 * registry 的 id→vault 映射，不靠中央库。人物/图片生成以后只占 kind 扩展位。
 *
 * 红线：纯 node（含 node:sqlite，不引第三方）；模块顶层零 IO（open 只在调用时）；
 * 路径全注入（vaultPath/configPath > env > 缺省），缺席 fail-loud。
 */
export * as schema from "./schema.ts";
export * as store from "./store.ts";
export * as registry from "./registry.ts";
export * as refs from "./refs.ts";
export { SCHEMA_VERSION, ensureSchema } from "./schema.ts";
export { openStore, integrityCheck, type StoreHandle, type OpenStoreOptions, type JournalMode } from "./store.ts";
export {
  VAULT_REGISTRY_ENV,
  VAULT_REGISTRY_FILE,
  resolveRegistryPath,
  readRegistry,
  writeRegistry,
  registerVault,
  resolveVault,
  type RegistryOptions,
  type VaultRegistry,
} from "./registry.ts";
export {
  registerAsset,
  getAsset,
  listAssets,
  addRef,
  removeRef,
  refCount,
  listHolders,
  tombstone,
  restore,
  isTrashed,
  type AssetRow,
  type AssetInput,
} from "./refs.ts";
