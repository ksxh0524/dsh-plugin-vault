/** schema —— vault 库表结构唯一真源 + 版本门（STANDARDS §7：语义一变必须 bump 版本让存量作废重建）。
 *
 * 本层只拥有 `meta` 表（版本戳记）。调用方自有表（如资产记账表）由调用方自建，
 * 版本键各自独立、各自 fail-loud，互不牵连。
 */
import type { DatabaseSync } from "node:sqlite";

/** 库格式版本：DDL 或语义一变即 +1，并同步加拒收旧版测试。 */
export const SCHEMA_VERSION = 1;

const DDL = [`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`];

/** 建表 + 版本戳记；已存在且版本不符即抛（不迁移）。 */
export function ensureVaultSchema(db: DatabaseSync): void {
  for (const sql of DDL) db.exec(sql);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  if (row === undefined) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
    return;
  }
  if (row.value !== String(SCHEMA_VERSION)) {
    throw new Error(`vault version-mismatch：库版本 ${row.value}，当前引擎 ${SCHEMA_VERSION}——不做自动迁移，请删库重建或走导入器重建索引`);
  }
}
