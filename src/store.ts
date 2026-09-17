/** store —— SQLite 引擎唯一入口（lazy open，调用方持有句柄，browser 半禁入）。
 *
 * 红线（incidents/004 的教训）：
 * - 模块顶层不 open：openStore 只在工具调用时执行，import 期零 IO，boot 永不被 DB 拖死。
 * - 坏库 fail-loud：open 失败抛带路径与原因的中文错，不吞错、不回落别处。
 * - 写排序归调用方：单条语句靠 SQLite 原子性，跨语句顺序由调用方串行（与宿主 kv 契约同口径）。
 *
 * 缺省 `journal_mode=WAL` + `busy_timeout=5000`；网络挂载等 WAL 不可用时调用方可传
 * journalMode: "delete"（见上游 dsh-storage-sqlite 同款口径）。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "./schema.ts";

export type JournalMode = "wal" | "delete" | "truncate" | "persist";

export type OpenStoreOptions = {
  /** 日志模式，缺省 wal。 */
  journalMode?: JournalMode;
  /** 锁等待毫秒，缺省 5000。 */
  busyTimeoutMs?: number;
};

export type StoreHandle = {
  /** 解析后的库绝对路径。 */
  path: string;
  /** 直连句柄（同步 API；调用方串行写）。 */
  db: DatabaseSync;
  /** 释放句柄（幂等）。 */
  close: () => void;
};

function fail(path: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`asset-store 打开失败（${path}）：${reason}`);
}

/** 打开（不存在即建，父目录 owner-only）；建表/验版本失败即抛。 */
export function openStore(dbPath: string, opts: OpenStoreOptions = {}): StoreHandle {
  // 先判空再 resolve：resolve("") 会静默回落 cwd，等于猜路径（D-1 禁止）。
  if (!String(dbPath || "").trim()) throw new Error("asset-store openStore 缺 dbPath（传 <vault>/.av/store.db 之类绝对路径）");
  const path = resolve(String(dbPath).trim());
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode = ${opts.journalMode ?? "wal"}`);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, opts.busyTimeoutMs ?? 5000)}`);
    db.exec(`PRAGMA foreign_keys = ON`);
    ensureSchema(db);
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
    path,
    db: opened,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** 自检：PRAGMA integrity_check 必须为 ok，否则抛带路径的错。 */
export function integrityCheck(handle: StoreHandle): void {
  let rows: Array<{ integrity_check: string }>;
  try {
    rows = (handle.db.prepare(`PRAGMA integrity_check`).all() ?? []) as Array<{ integrity_check: string }>;
  } catch (cause) {
    throw fail(handle.path, cause);
  }
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
    throw new Error(`asset-store 自检失败（${handle.path}）：integrity_check=${JSON.stringify(rows).slice(0, 200)}`);
  }
}
