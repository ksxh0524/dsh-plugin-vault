/** schema —— 库表结构唯一真源 + 版本门（STANDARDS §7：语义一变必须 bump 版本让存量作废重建）。
 *
 * 红线：
 * - 二进制永不进库行：assets 表只记指针（path）+ 哈希（sha256）+ 字节数（bytes），
 *   mp4/png/封面/人物图的字节永远落盘。SQLite 的 value 侧只存小 JSON 文本。
 * - 版本 fail-loud 不迁移：打开时 meta.schema_version 与 SCHEMA_VERSION 不符即抛
 *   `version-mismatch`（读旧库不猜、不升），调用方删库重建或走导入器。
 * - id 即内容寻址：assets.id = sha256，同一份字节跨项目/跨 kind 只存一行，
 *   引用方各自在 refs 表记账（holder），不拷贝。
 */
import type { DatabaseSync } from "node:sqlite";

/** 库格式版本：DDL 或语义一变即 +1，并同步加拒收旧版测试。 */
export const SCHEMA_VERSION = 1;

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    path TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets (kind)`,
  `CREATE TABLE IF NOT EXISTS refs (
    asset_id TEXT NOT NULL,
    holder TEXT NOT NULL,
    PRIMARY KEY (asset_id, holder)
  )`,
  `CREATE TABLE IF NOT EXISTS trash (
    asset_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    trashed_at TEXT NOT NULL
  )`,
];

/** 建表 + 版本戳记；已存在且版本不符即抛（不迁移）。 */
export function ensureSchema(db: DatabaseSync): void {
  for (const sql of DDL) db.exec(sql);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  if (row === undefined) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
    return;
  }
  if (row.value !== String(SCHEMA_VERSION)) {
    throw new Error(`asset-store version-mismatch：库版本 ${row.value}，当前引擎 ${SCHEMA_VERSION}——不做自动迁移，请删库重建或走导入器重建索引`);
  }
}
