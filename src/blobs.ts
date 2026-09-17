/** blobs —— 字节拥有者：内容寻址落盘 + 按址取回（本层不知 kind、不记引用）。
 *
 * 布局：`<库目录>/blobs/<sha256 前 2 位>/<sha256>`（库目录调用方给定，本层只收 blobsDir）。同 sha 幂等——已存在且字节数
 * 一致即复用不重写；已存在但字节数不一致 = 盘被库外写入动过，fail-loud（不静默覆盖）。
 * 大文件不整载内存：path 源先流式算哈希、再 copyFileSync，两遍过盘、内存恒定。
 * 落盘原子：写 tmp + rename，中途崩溃不留半截文件。
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VaultHandle } from "./vault.ts";

export type BlobPointer = {
  /** 内容寻址主键（64 位 hex）。 */
  sha256: string;
  /** 字节数。 */
  bytes: number;
  /** 落盘绝对路径（只记指针，二进制永不进库行）。 */
  storedPath: string;
};

export type BlobSource = { path: string } | { bytes: Uint8Array };

function clean(p: unknown): string {
  return String(p ?? "").trim();
}

/** sha256 → 落盘路径（纯计算，不碰盘；sha 非法即抛）。 */
export function blobPathFor(blobsDir: string, sha256: string): string {
  const sha = clean(sha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`vault 非法 sha256（须 64 位 hex）：${clean(sha256).slice(0, 32)}…`);
  return join(blobsDir, sha.slice(0, 2), sha);
}

function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
  });
}

function stageTemp(): string {
  return join(tmpdir(), `vault-blob-${process.pid}-${Date.now().toString(36)}`);
}

/** 同 sha 落盘目标已存在：字节数一致即复用，不一致 = 盘被外人动过，抛。 */
function reuseIfPresent(dest: string, sha256: string, bytes: number): BlobPointer | null {
  if (!existsSync(dest)) return null;
  const onDisk = statSync(dest).size;
  if (onDisk !== bytes) {
    throw new Error(`vault 字节冲突（${dest}）：盘上 ${onDisk} 字节 ≠ 本次 ${bytes} 字节——盘被库外写入动过，请手工核查`);
  }
  return { sha256, bytes, storedPath: dest };
}

/** 存字节（幂等）：path 源流式哈希 + 整文件拷贝；bytes 源直接哈希落盘。 */
export async function putBlob(handle: VaultHandle, source: BlobSource): Promise<BlobPointer> {
  if ("path" in source) {
    const src = clean(source.path);
    if (!src) throw new Error("vault putBlob 缺 path（传源文件绝对路径，或改传 { bytes }）");
    let st: { size: number };
    try {
      st = statSync(src);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`vault putBlob 源文件不可读（${src}）：${reason}`);
    }
    const { sha256, bytes } = await hashFile(src).catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`vault putBlob 哈希失败（${src}）：${reason}`);
    });
    if (bytes !== st.size) throw new Error(`vault putBlob 源文件在读时被改动（${src}）：前后字节数不一致`);
    const dest = blobPathFor(handle.blobsDir, sha256);
    const reused = reuseIfPresent(dest, sha256, bytes);
    if (reused) return reused;
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = stageTemp();
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
    return { sha256, bytes, storedPath: dest };
  }
  const bytes = source.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("vault putBlob 的 bytes 须为非空 Uint8Array（空源请传 { path }）");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dest = blobPathFor(handle.blobsDir, sha256);
  const reused = reuseIfPresent(dest, sha256, bytes.length);
  if (reused) return reused;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = stageTemp();
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, dest);
  return { sha256, bytes: bytes.length, storedPath: dest };
}

/** 按 sha 取落盘路径：不存在即抛（带期望位置）；只给路径，不读字节。 */
export function getBlobPath(handle: VaultHandle, sha256: string): string {
  const dest = blobPathFor(handle.blobsDir, sha256);
  if (!existsSync(dest)) throw new Error(`vault 取字节无此 sha（${clean(sha256).slice(0, 12)}…）：先 putBlob（期望位置 ${dest}）`);
  return dest;
}
