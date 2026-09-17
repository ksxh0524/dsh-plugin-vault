/** refs —— 资产登记 + 引用计数 + tombstone（删只记账，不删字节）。
 *
 * 口径：
 * - registerAsset 幂等：同 sha256 重复登记返回同一行（首见 path 为准，不覆盖）；
 *   kind/metadata 为空即抛（调用方必须声明资产种别，禁裸存）。
 * - 引用是存在性语义：addRef/removeRef 幂等；refCount 归 0 不自动删（无 GC），
 *   删除必须显式 tombstone（记 trash 表 + reason），字节与库行一律保留。
 * - 资产出了 trash 即只读黑名单：tombstoned id 拒绝 addRef（先 restore 才可再引用）。
 */
import type { DatabaseSync } from "node:sqlite";

export type AssetRow = {
  id: string;
  kind: string;
  sha256: string;
  bytes: number;
  path: string;
  metadata: string;
  created_at: string;
};

export type AssetInput = {
  kind: string;
  sha256: string;
  bytes: number;
  path: string;
  metadata?: Record<string, unknown>;
};

function clean(p: unknown): string {
  return String(p ?? "").trim();
}

function isTombstoned(db: DatabaseSync, id: string): boolean {
  const row = db.prepare(`SELECT asset_id FROM trash WHERE asset_id = ?`).get(id) as { asset_id: string } | undefined;
  return row !== undefined;
}

/** 登记资产（幂等，同 sha256 返回首行）；kind/sha256/path 缺一即抛。 */
export function registerAsset(db: DatabaseSync, input: AssetInput): AssetRow {
  const kind = clean(input.kind);
  const sha256 = clean(input.sha256).toLowerCase();
  const path = clean(input.path);
  const bytes = input.bytes;
  if (!kind) throw new Error("asset-store registerAsset 缺 kind（调用方必须声明资产种别）");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("asset-store registerAsset 须传 sha256（64 位 hex，内容寻址主键）");
  if (!path) throw new Error("asset-store registerAsset 缺 path（字节落盘位置，只记指针）");
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error("asset-store registerAsset 的 bytes 须为非负整数");
  const existed = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(sha256) as AssetRow | undefined;
  if (existed) return existed;
  const now = new Date().toISOString();
  const metadata = JSON.stringify(input.metadata ?? {});
  db.prepare(`INSERT INTO assets (id, kind, sha256, bytes, path, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    sha256,
    kind,
    sha256,
    bytes,
    path,
    metadata,
    now,
  );
  return { id: sha256, kind, sha256, bytes, path, metadata, created_at: now };
}

/** 取资产行（无则 null，不抛）。 */
export function getAsset(db: DatabaseSync, id: string): AssetRow | null {
  const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(clean(id)) as AssetRow | undefined;
  return row ?? null;
}

/** 按 kind 列资产（kind 为空即抛；tombstoned 不过滤，由调用方按需查 trash）。 */
export function listAssets(db: DatabaseSync, kind?: string): AssetRow[] {
  if (kind === undefined) return (db.prepare(`SELECT * FROM assets ORDER BY created_at`).all() ?? []) as AssetRow[];
  const k = clean(kind);
  if (!k) throw new Error("asset-store listAssets 的 kind 为空（查全部请不传参）");
  return (db.prepare(`SELECT * FROM assets WHERE kind = ? ORDER BY created_at`).all(k) ?? []) as AssetRow[];
}

/** 加引用（幂等；tombstoned 拒绝）。 */
export function addRef(db: DatabaseSync, assetId: string, holder: string): void {
  const id = clean(assetId);
  const h = clean(holder);
  if (!id) throw new Error("asset-store addRef 缺 assetId");
  if (!h) throw new Error("asset-store addRef 缺 holder（谁引用谁负责声明）");
  if (!getAsset(db, id)) throw new Error(`asset-store addRef 无此资产（${id.slice(0, 12)}…）：先 registerAsset`);
  if (isTombstoned(db, id)) throw new Error(`asset-store addRef 被拒：资产已 tombstone（${id.slice(0, 12)}…），先 restore`);
  db.prepare(`INSERT OR IGNORE INTO refs (asset_id, holder) VALUES (?, ?)`).run(id, h);
}

/** 去引用（幂等，不存在即 false；归零不删资产）。 */
export function removeRef(db: DatabaseSync, assetId: string, holder: string): boolean {
  const info = db.prepare(`DELETE FROM refs WHERE asset_id = ? AND holder = ?`).run(clean(assetId), clean(holder));
  return Number(info.changes ?? 0) > 0;
}

/** 引用计数。 */
export function refCount(db: DatabaseSync, assetId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM refs WHERE asset_id = ?`).get(clean(assetId)) as { n: number };
  return row.n;
}

/** 列引用方。 */
export function listHolders(db: DatabaseSync, assetId: string): string[] {
  const rows = (db.prepare(`SELECT holder FROM refs WHERE asset_id = ? ORDER BY holder`).all(clean(assetId)) ?? []) as Array<{
    holder: string;
  }>;
  return rows.map((r) => r.holder);
}

/** 删除键：只记 trash（tombstone），资产行与字节一律保留；重复记幂等。 */
export function tombstone(db: DatabaseSync, assetId: string, reason = ""): void {
  const id = clean(assetId);
  if (!getAsset(db, id)) throw new Error(`asset-store tombstone 无此资产（${id.slice(0, 12)}…）`);
  db.prepare(`INSERT OR IGNORE INTO trash (asset_id, reason, trashed_at) VALUES (?, ?, ?)`).run(
    id,
    String(reason ?? "").slice(0, 500),
    new Date().toISOString(),
  );
}

/** 恢复引用资格（删 tombstone 行；资产行本来就没动过）。 */
export function restore(db: DatabaseSync, assetId: string): boolean {
  const info = db.prepare(`DELETE FROM trash WHERE asset_id = ?`).run(clean(assetId));
  return Number(info.changes ?? 0) > 0;
}

/** 是否已 tombstone。 */
export function isTrashed(db: DatabaseSync, assetId: string): boolean {
  return isTombstoned(db, clean(assetId));
}
