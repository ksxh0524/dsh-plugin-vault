/** backend —— vault 存储后端接缝：Backend 接口 + LocalBackend + S3Backend 桩。
 *
 * 一句话：后端只认本包逻辑（blobs.ts 字节 + vault.ts 开库语义），位置只认调用方给定的
 * vault 根目录。本层是 cordis 工具面（tools.ts）与库逻辑之间的唯一接缝——工具面禁直连
 * vault.ts/blobs.ts，一律经 Backend 走。
 *
 * 布局（§2.2 冻结口径）：
 * - 一 ns 一库：`<vaultDir>/ns/<ns>/store.db`（各 ns 版本门独立，见 schema.ts）；
 * - blobs 全局内容寻址共享：`<vaultDir>/blobs/<aa>/<sha256>`（跨 ns 同 sha 只存一份）；
 * - 无注册表：ns 即目录名，不另建映射表；SCHEMA_VERSION 不 bump。
 *
 * 开库语义与 vault.ts openVault 同源（WAL + busy_timeout + foreign_keys + ensureVaultSchema，
 * 坏库 fail-loud 带路径；唯一差别：ns 库目录下不建 blobs 家目录——字节家全局只有一个）。
 * 同步义务：改 vault.ts 开库语义（pragma/版本门/错误形）时，必须同步改这里的 openDb。
 *
 * 红线：模块顶层零 IO（构造 LocalBackend 只 resolve 路径，openDb 在工具调用时执行）；
 * ns 校验 `^[a-z0-9-]{1,32}$`，非法 fail-loud 中文错，不回落不猜测。
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getBlobPath, putBlob } from "./blobs.ts";
import { ensureVaultSchema } from "./schema.ts";
import type { BlobPointer, BlobSource } from "./blobs.ts";
import type { VaultHandle } from "./vault.ts";

/** 后端种别：local 真实现；s3 只有桩（构造即抛，见 S3Backend）。 */
export type VaultBackendKind = "local" | "s3";

/** ns 库句柄（openDb 现开现关，调用方 try/finally 关）。 */
export type VaultDb = {
  /** ns 名（校验后原文）。 */
  ns: string;
  /** 库绝对路径（`<vaultDir>/ns/<ns>/store.db`）。 */
  path: string;
  /** 直连句柄（同步 API；调用方串行写，与 vault.ts 同口径）。 */
  db: DatabaseSync;
  /** 释放句柄（幂等）。 */
  close: () => void;
};

/** 后端接口：put/get 字节 + openDb(ns)。实现只此两家（LocalBackend / S3Backend 桩）。 */
export interface Backend {
  readonly kind: VaultBackendKind;
  /** 存字节（幂等，语义与 blobs.ts putBlob 一致）。 */
  putBlob: (source: BlobSource) => Promise<BlobPointer>;
  /** 按 sha 取落盘路径（不存在即抛，语义与 blobs.ts getBlobPath 一致）。 */
  getBlobPath: (sha256: string) => string;
  /** 开 ns 库（不存在即建；坏库 fail-loud）。调用方负责 close。 */
  openDb: (ns: string) => VaultDb;
}

/** ns 名断言（与工具面同源，单点：改正则只改这里）。 */
export function assertNsName(ns: unknown): asserts ns is string {
  const name = typeof ns === "string" ? ns : "";
  if (!/^[a-z0-9-]{1,32}$/.test(name)) {
    throw new Error(`vault ns 非法：${JSON.stringify(ns) ?? "缺席"}（只收 ^[a-z0-9-]{1,32}$，如 "ledger"、"script-v2"）`);
  }
}

/** 空根目录 fail-loud（resolve("") 会静默回落 cwd，等于猜路径——禁止）。 */
function resolveRoot(vaultDir: string): string {
  if (!String(vaultDir || "").trim())
    throw new Error("vault 缺 vaultDir（传库根目录绝对路径，或配 env DSH_VAULT_DIR，或在工作区放 .vault/workspace.json 中性锚）");
  return resolve(String(vaultDir).trim());
}

/** LocalBackend：文件系统后端（唯一真实现）。构造只记路径，零 IO。 */
export class LocalBackend implements Backend {
  readonly kind: VaultBackendKind = "local";
  /** 库根绝对路径（下挂 `ns/<ns>/store.db` + 全局 `blobs/`）。 */
  readonly rootDir: string;
  /** 全局字节家目录（`<root>/blobs`，跨 ns 内容寻址共享）。 */
  readonly blobsDir: string;

  constructor(vaultDir: string) {
    this.rootDir = resolveRoot(vaultDir);
    this.blobsDir = join(this.rootDir, "blobs");
  }

  /** 字节写点：委托 blobs.ts putBlob（同一函数、零漂移）；只读 handle.blobsDir，db 槽位永不触达。 */
  async putBlob(source: BlobSource): Promise<BlobPointer> {
    return putBlob(blobOnlyHandle(this.blobsDir), source);
  }

  /** 字节读点：委托 blobs.ts getBlobPath（同一函数、零漂移）。 */
  getBlobPath(sha256: string): string {
    return getBlobPath(blobOnlyHandle(this.blobsDir), sha256);
  }

  /** 开 ns 库（语义与 vault.ts openVault 同源，见文件头同步义务；ns 目录下不建 blobs 家）。 */
  openDb(ns: string): VaultDb {
    assertNsName(ns);
    const dir = join(this.rootDir, "ns", ns);
    const path = join(dir, "store.db");
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      db = new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode = wal`);
      db.exec(`PRAGMA busy_timeout = 5000`);
      db.exec(`PRAGMA foreign_keys = ON`);
      ensureVaultSchema(db);
    } catch (cause) {
      try {
        db?.close();
      } catch {
        /* 关失败不掩盖原错 */
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`vault 打开 ns 库失败（ns=${ns}，${path}）：${reason}`);
    }
    const opened = db as DatabaseSync;
    let closed = false;
    return {
      ns,
      path,
      db: opened,
      close: () => {
        if (closed) return;
        closed = true;
        opened.close();
      },
    };
  }
}

/** S3Backend 桩：构造即抛 not-implemented + 出路（§2.2：占位不断言、不回落 local）。 */
export class S3Backend implements Backend {
  readonly kind: VaultBackendKind = "s3";

  constructor(_opts?: { endpoint?: string; bucket?: string }) {
    throw new Error(
      'vault S3 后端未实现（backend="s3"）：当前仅 local 可用——改回 backend:"local"（profile patch 行 config.backend，缺省即 local），或按 src/backend.ts Backend 接口实现 S3Backend 后替换本桩',
    );
  }

  putBlob(_source: BlobSource): Promise<BlobPointer> {
    throw new Error("vault S3 后端未实现（构造期已抛，不应到达 putBlob）");
  }

  getBlobPath(_sha256: string): string {
    throw new Error("vault S3 后端未实现（构造期已抛，不应到达 getBlobPath）");
  }

  openDb(_ns: string): VaultDb {
    throw new Error("vault S3 后端未实现（构造期已抛，不应到达 openDb）");
  }
}

/** 按种别建后端（未知种别 fail-loud，不猜测）。 */
export function createBackend(kind: VaultBackendKind, vaultDir: string): Backend {
  if (kind === "local") return new LocalBackend(vaultDir);
  if (kind === "s3") return new S3Backend();
  throw new Error(`vault backend 非法：${JSON.stringify(kind) ?? "缺席"}（只收 "local"|"s3"，缺省 "local"）`);
}

/** 只带 blobsDir 的合成句柄：putBlob/getBlobPath 只读该字段（见 blobs.ts 头注），db 槽位填永不触达的空位。
 *  用途：全局字节家没有自己的 store.db，不为它建库——误调 db 方法即 TypeError 现形，不静默。 */
function blobOnlyHandle(blobsDir: string): VaultHandle {
  return { vaultDir: blobsDir, path: "", blobsDir, db: undefined as unknown as DatabaseSync, close: () => {} };
}
