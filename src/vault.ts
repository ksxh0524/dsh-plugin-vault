/** vault —— 库家目录唯一入口：lazy open + 句柄 + 自检（browser 半禁入）。
 *
 * 一个 vault = 一个目录：`<vault>/.av/store.db`（索引）+ `<vault>/.av/blobs/`（字节，
 * 见 blobs.ts）。openVault 的参数是库家目录，不是库文件——上层 registry.resolveVault
 * 的返回值直插即用。本层不知 kind 为何物，不记引用、不做生命周期（那是 dsh-plugin-asset 的事）。
 *
 * 红线（incidents/004 的教训）：
 * - 模块顶层不 open：openVault 只在工具调用时执行，import 期零 IO，boot 永不被 DB 拖死。
 * - 坏库 fail-loud：open 失败抛带路径与原因的中文错，不吞错、不回落别处。
 * - 写排序归调用方：单条语句靠 SQLite 原子性，跨语句顺序由调用方串行（与宿主 kv 契约同口径）。
 *
 * 缺省 `journal_mode=WAL` + `busy_timeout=5000`；网络挂载等 WAL 不可用时调用方可传
 * journalMode: "delete"（见上游 dsh-storage-sqlite 同款口径）。
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureVaultSchema } from "./schema.ts";

export type JournalMode = "wal" | "delete" | "truncate" | "persist";

export type OpenVaultOptions = {
  /** 日志模式，缺省 wal。 */
  journalMode?: JournalMode;
  /** 锁等待毫秒，缺省 5000。 */
  busyTimeoutMs?: number;
  /** 库文件名（缺省 store.db；测试隔离用）。 */
  dbFileName?: string;
};

export type VaultHandle = {
  /** 解析后的库家目录绝对路径。 */
  vaultDir: string;
  /** 解析后的库绝对路径（`<vault>/.av/<dbFileName>`）。 */
  path: string;
  /** 字节家目录（`<vault>/.av/blobs`，blobs.ts 的写点）。 */
  blobsDir: string;
  /** 直连句柄（同步 API；调用方串行写）。 */
  db: DatabaseSync;
  /** 释放句柄（幂等）。 */
  close: () => void;
};

function fail(path: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`vault 打开失败（${path}）：${reason}`);
}

/** 打开 vault（不存在即建，父目录 owner-only）；建表/验版本失败即抛。 */
export function openVault(vaultDir: string, opts: OpenVaultOptions = {}): VaultHandle {
  // 先判空再 resolve：resolve("") 会静默回落 cwd，等于猜路径（D-1 禁止）。
  if (!String(vaultDir || "").trim()) throw new Error("vault openVault 缺 vaultDir（传库家目录绝对路径）");
  const dir = resolve(String(vaultDir).trim());
  const dotav = join(dir, ".av");
  const path = join(dotav, opts.dbFileName ?? "store.db");
  const blobsDir = join(dotav, "blobs");
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(dotav, { recursive: true, mode: 0o700 });
    mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode = ${opts.journalMode ?? "wal"}`);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, opts.busyTimeoutMs ?? 5000)}`);
    db.exec(`PRAGMA foreign_keys = ON`);
    ensureVaultSchema(db);
  } catch (cause) {
    try {
      db?.close();
    } catch {
      /* 关失败不掩盖原错 */
    }
    throw fail(path, cause);
  }
  const opened = db as DatabaseSync;
  let closed = false;
  return {
    vaultDir: dir,
    path,
    blobsDir,
    db: opened,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** 打开内存 vault（索引 :memory: + 临时 blobs 家）：单测与契约套件用，不落盘。
 *  句柄形状与 openVault 一致，同一套契约断言可跑两遍（文件后端 / 内存后端）。 */
export function openMemoryVault(): VaultHandle {
  const dir = mkdtempSync(join(tmpdir(), "vault-mem-"));
  const blobsDir = join(dir, "blobs");
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(":memory:");
    ensureVaultSchema(db);
  } catch (cause) {
    try {
      db?.close();
    } catch {
      /* 关失败不掩盖原错 */
    }
    throw fail(`${dir} (:memory:)`, cause);
  }
  const opened = db as DatabaseSync;
  let closed = false;
  return {
    vaultDir: dir,
    path: ":memory:",
    blobsDir,
    db: opened,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** 自检：PRAGMA integrity_check 必须为 ok，否则抛带路径的错。 */
export function integrityCheck(handle: VaultHandle): void {
  let rows: Array<{ integrity_check: string }>;
  try {
    rows = (handle.db.prepare(`PRAGMA integrity_check`).all() ?? []) as Array<{ integrity_check: string }>;
  } catch (cause) {
    throw fail(handle.path, cause);
  }
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
    throw new Error(`vault 自检失败（${handle.path}）：integrity_check=${JSON.stringify(rows).slice(0, 200)}`);
  }
}
