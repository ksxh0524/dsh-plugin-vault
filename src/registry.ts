/** registry —— vault 注册表（“哪里启动都能用”靠它，不靠中央库）。
 *
 * 三级注入（D-1 同款写法，加一个 tier 而已）：
 *   ① configPath（调用方显式传）→ ② env ASSET_VAULT_REGISTRY → ③ 缺省 ~/.av/vaults.json。
 * 注册表缺文件 = 空表（不报错）；open 未登记 id 且路径不存在 = fail-loud 并列出路。
 * 读写原子落盘（tmp+rename），坏文件 fail-loud（不静默重建，避免吞掉已有登记）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 注册表位置的环境变量注入位。 */
export const VAULT_REGISTRY_ENV = "ASSET_VAULT_REGISTRY";
/** 注册表文件名（相对家目录）：全局 id → 库家目录映射。 */
export const VAULT_REGISTRY_FILE = join(".av", "vaults.json");

export type RegistryOptions = {
  /** 调用方显式路径（最高优先级）。 */
  configPath?: string;
  /** 环境变量表（缺省 process.env；测试传自有对象做隔离）。 */
  env?: Record<string, string | undefined>;
  /** 环境变量名（缺省 ASSET_VAULT_REGISTRY）。 */
  envVar?: string;
};

function clean(p: unknown): string {
  return String(p ?? "").trim();
}

/** 注册表文件路径：config > env > ~/.av/vaults.json（只定位置，不读内容）。 */
export function resolveRegistryPath(opts: RegistryOptions = {}): string {
  const cfg = clean(opts.configPath);
  if (cfg) return resolve(cfg);
  const env = opts.env ?? process.env;
  const fromEnv = clean(env[opts.envVar ?? VAULT_REGISTRY_ENV]);
  if (fromEnv) return resolve(fromEnv);
  return resolve(homedir(), VAULT_REGISTRY_FILE);
}

export type VaultRegistry = Record<string, string>;

/** 读注册表：缺文件 = 空表；坏 JSON = fail-loud（带路径）。 */
export function readRegistry(opts: RegistryOptions = {}): VaultRegistry {
  const file = resolveRegistryPath(opts);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`asset-store 注册表损坏（${file}）：${reason}——请手工修复或删除后重登记`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`asset-store 注册表形状非法（${file}）：顶层须为 {id: path} 对象`);
  }
  const out: VaultRegistry = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** 原子写注册表（tmp+rename；父目录 owner-only）。 */
export function writeRegistry(reg: VaultRegistry, opts: RegistryOptions = {}): string {
  const file = resolveRegistryPath(opts);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(process.env.TMPDIR ?? tmpdir(), `vaults-${process.pid}-${Date.now().toString(36)}.json`);
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** 登记 id → 库家目录（覆盖同名旧值，返回注册表文件路径）。 */
export function registerVault(id: string, vaultDir: string, opts: RegistryOptions = {}): string {
  const key = clean(id);
  const dir = resolve(clean(vaultDir));
  if (!key) throw new Error("asset-store registerVault 缺 id");
  if (!clean(vaultDir)) throw new Error("asset-store registerVault 缺 vaultDir");
  const reg = readRegistry(opts);
  reg[key] = dir;
  return writeRegistry(reg, opts);
}

/** id 或路径 → 库家目录：注册表命中优先；裸路径存在即认；否则 fail-loud 列出路。 */
export function resolveVault(idOrPath: string, opts: RegistryOptions = {}): string {
  const raw = clean(idOrPath);
  if (!raw) throw new Error("asset-store resolveVault 缺 idOrPath（传 vault id 或库家目录路径）");
  const reg = readRegistry(opts);
  if (reg[raw]) return resolve(reg[raw]);
  const asPath = resolve(raw);
  if (existsSync(asPath)) return asPath;
  const known = Object.keys(reg);
  throw new Error(
    [
      `asset-store 未定位 vault（${raw}）`,
      known.length ? `已登记：${known.slice(0, 10).join("、")}${known.length > 10 ? "…" : ""}` : "注册表为空",
      `三条出路：传已登记 id / 传存在的库家目录路径 / 先 registerVault 登记（注册表：${resolveRegistryPath(opts)}）。`,
    ].join("\n"),
  );
}
