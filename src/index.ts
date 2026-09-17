/** vault —— 通用存储底座（跨域中立件；私有，不发 npm）。
 *
 * 一句话：介质拥有者。一 vault 一目录（调用方给定：`<库目录>/store.db` 存索引、
 * `<库目录>/blobs/` 存字节）；二进制不进库行，只记指针+哈希。
 * 本层不知 kind 为何物，不记引用、不做生命周期——那是 dsh-plugin-asset 的事。
 *
 * 红线：纯 node（含 node:sqlite，不引第三方）；模块顶层零 IO（open 只在调用时）；
 * 路径全注入（vaultDir 必传），缺席 fail-loud。
 */
export * as schema from "./schema.ts";
export * as vault from "./vault.ts";
export * as blobs from "./blobs.ts";
export { SCHEMA_VERSION, ensureVaultSchema } from "./schema.ts";
export { openVault, openMemoryVault, integrityCheck, type VaultHandle, type OpenVaultOptions, type JournalMode } from "./vault.ts";
export { putBlob, getBlobPath, blobPathFor, type BlobPointer, type BlobSource } from "./blobs.ts";
