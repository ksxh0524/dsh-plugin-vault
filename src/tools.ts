/** tools —— dsh-plugin-vault DSH 工具面（§2.3 五工具落地）。
 *
 * 注册面（cordis apply 一次性 register）：
 * - vault_put_blob：存字节（path/bytesBase64 二选一，base64 解码后 ≤8MB）；
 * - vault_get_blob：取字节（小文件内联 base64，超 8MB 只返路径）；
 * - vault_db_exec：写 SQL（单语句 + 首关键字白名单 + 表全匹配 ns__*）；
 * - vault_db_query：读 SQL（首关键字仅 SELECT/WITH/EXPLAIN + 同前缀检查）；
 * - vault_ns_info：ns 自检（路径 + 表清单 + integrity_check）。
 * 形态照抄 dsh-plugin-wwrs-ffmpeg src/tools.ts：defineTool 全带 output.schema +
 * output.render，timeoutMs 声明正数；ToolRecord 桥接 `as unknown as`（上游类型与运行时
 * 不一致是上游的债，包侧背锅留字据，ADR-007）。
 *
 * SQL 门禁（fail-closed，错一律中文 fail-loud 不回落）：
 * - 单语句：token 级扫分号（串内分号不算），只许末尾一个；
 * - 禁 ATTACH / PRAGMA / VACUUM（token 级，串内不算；读表结构走 vault_ns_info）；
 * - 写工具首关键字白名单：INSERT/UPDATE/DELETE/CREATE TABLE/CREATE INDEX/
 *   DROP TABLE/DROP INDEX（CREATE/DROP 带可选 IF [NOT] EXISTS；禁 OR REPLACE 与 TEMP）；
 * - 读工具首关键字仅 SELECT/WITH/EXPLAIN（EXPLAIN 内层须仍是读词；WITH 语句动词位禁写）；
 * - 表全匹配 ns__*：扫 FROM/JOIN/INTO/UPDATE/TABLE/INDEX 位（含子查询，串内不算），
 *   索引名同口径；禁 schema 限定（`main.t` 形一律拒）；读工具 CTE 名豁免（`名 AS (` 定义位）。
 * ns 校验与后端同源（assertNsName，见 backend.ts）；位置决议 config.vaultDir >
 * env DSH_VAULT_DIR > 工作区中性锚（向上找 .vault/workspace.json，内容合法 JSON 即认），
 * 全 miss 即 fail-loud 点名三条出路，绝不回落机器目录。
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assertNsName, createBackend } from "./backend.ts";
import type { VaultBackendKind } from "./backend.ts";

/** 最小宿主结构类型（只声明本包实际触达的面；不 import 任何 DSH 实例协议包）。 */
export type ToolRecord = {
  name: string;
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

export type HostContext = {
  tools?: {
    register: (tool: ToolRecord) => unknown;
  };
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

/** 工具 execute 的 exec 窄面（结构化声明；cwd 供中性锚探测）。 */
export type ToolExecLike = {
  signal?: AbortSignal;
  agent?: {
    session?: { meta?: { cwd?: string }; header?: { cwd?: string } };
  };
};

export type VaultToolsConfig = {
  /** 库根目录（profile patch 行 config.vaultDir=<绝对路径>；空 = env/中性锚）。 */
  vaultDir?: string;
  /** 后端种别（缺省 local；s3 只有桩，构造即抛 not-implemented）。 */
  backend?: string;
  ctx?: HostContext;
};

/** 注册的五工具名（apply/测试/boot 断言同源）。 */
export const VAULT_TOOL_NAMES = ["vault_put_blob", "vault_get_blob", "vault_db_exec", "vault_db_query", "vault_ns_info"] as const;

/** env 键：库根目录。 */
export const VAULT_DIR_ENV = "DSH_VAULT_DIR";
/** 工作区中性锚（工作区根下相对路径；内容为合法 JSON 即认，不判业务字段）。 */
export const VAULT_ANCHOR_REL = ".vault/workspace.json";
/** blob 内联阈值：解码后 ≤8MB 内联 base64，超限只返路径。 */
export const BLOB_INLINE_LIMIT = 8 * 1024 * 1024;

const BLOB_TIMEOUT_MS = 120_000;
const DB_TIMEOUT_MS = 30_000;

/* ---------------- 位置决议 ---------------- */

/** 本次调用的库根（config.vaultDir > env DSH_VAULT_DIR > 中性锚 walk-up；全 miss 即抛三条出路）。 */
export function resolveVaultDir(cwd: string, opts: { configVaultDir?: string; env?: Record<string, string | undefined> } = {}): string {
  const cfg = String(opts.configVaultDir ?? "").trim();
  if (cfg) return resolve(cfg);
  const env = opts.env ?? process.env;
  const ev = String(env[VAULT_DIR_ENV] ?? "").trim();
  if (ev) return resolve(ev);
  const start = resolve(cwd);
  const tried: string[] = [];
  let dir = start;
  for (;;) {
    const anchor = join(dir, ".vault", "workspace.json");
    tried.push(anchor);
    try {
      JSON.parse(readFileSync(anchor, "utf8"));
      return dir;
    } catch {
      /* 非有效锚，继续向上 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[vault 工作区未找到] 从 ${start} 向上找不到 ${VAULT_ANCHOR_REL}（内容为合法 JSON 即认）。已试：\n${tried.join("\n")}\n出路（三选一）：config.vaultDir=<库根绝对路径> 或 env ${VAULT_DIR_ENV}=<库根绝对路径> 或在工作区根放 ${VAULT_ANCHOR_REL}`,
  );
}

/* ---------------- SQL token 流（门禁唯一地基） ---------------- */

type Token = { t: "word"; v: string } | { t: "name"; v: string } | { t: "str" } | { t: "punct"; v: string };

/** SQL 切 token：串/注释不算数（门禁只看真码）；引号标识符另归 name 位（表位提取用）。 */
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = sql[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i += 1;
            break;
          }
        } else i += 1;
      }
      out.push({ t: "str" });
      continue;
    }
    if (c === '"' || c === "`") {
      const q = c;
      let v = "";
      i += 1;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            v += q;
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          v += sql[i];
          i += 1;
        }
      }
      out.push({ t: "name", v });
      continue;
    }
    if (c === "[") {
      let v = "";
      i += 1;
      while (i < n && sql[i] !== "]") {
        v += sql[i];
        i += 1;
      }
      i += 1;
      out.push({ t: "name", v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let v = "";
      while (i < n && isWord(sql[i] as string)) {
        v += sql[i];
        i += 1;
      }
      out.push({ t: "word", v });
      continue;
    }
    out.push({ t: "punct", v: c });
    i += 1;
  }
  return out;
}

const WRITE_VERBS = new Set(["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "REPLACE", "ALTER", "VACUUM", "ATTACH", "PRAGMA", "REINDEX"]);
const TABLE_POS = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "INDEX"]);

function words(tokens: Token[]): string[] {
  return tokens.filter((x) => x.t === "word").map((x) => x.v.toUpperCase());
}

/** token 流首词（门禁已验非空；调用方保证）。 */
function headOf(tokens: Token[]): string {
  return words(tokens)[0] as string;
}

/** 禁 token（ATTACH/PRAGMA/VACUUM）：串内不算，真码出现即拒。 */
function checkNoForbidden(tokens: Token[], tool: string): void {
  for (const x of tokens) {
    if (x.t !== "word") continue;
    const w = x.v.toUpperCase();
    if (w === "ATTACH") throw new Error(`[${tool}] 禁 ATTACH（禁跨库嫁接；只许操作本 ns 库）`);
    if (w === "PRAGMA") throw new Error(`[${tool}] 禁 PRAGMA（表结构/自检请调 vault_ns_info，不在 SQL 面开洞）`);
    if (w === "VACUUM") throw new Error(`[${tool}] 禁 VACUUM（维护语句不在工具面开放）`);
  }
}

/** 单语句：分号只许末尾一个（串内分号已在 tokenize 剥离）。 */
function checkSingleStatement(tokens: Token[], tool: string): void {
  const idx = tokens.map((x, i) => (x.t === "punct" && x.v === ";" ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return;
  if (idx.length === 1 && idx[0] === tokens.length - 1) return;
  throw new Error(`[${tool}] 只收单语句（禁分号多语句；多步请拆成多次调用）`);
}

/** 表位提取位后一名（word/name 位；IF/NOT/EXISTS 跳过，CREATE/DROP 形用）。 */
function tableAfter(tokens: Token[], at: number): { name: string; next: number } | null {
  let i = at + 1;
  while (i < tokens.length) {
    const x = tokens[i] as Token;
    if (x.t === "word" && (x.v.toUpperCase() === "IF" || x.v.toUpperCase() === "NOT" || x.v.toUpperCase() === "EXISTS")) {
      i += 1;
      continue;
    }
    if (x.t === "word" || x.t === "name") return { name: x.t === "word" ? x.v : (x as { v: string }).v, next: i };
    return null;
  }
  return null;
}

/** 同缀检查：提取名须以 `<ns>__` 开头；禁 schema 限定（`a.b` 形）；读工具 CTE 名豁免。
 *  UPDATE 位只认语句首词（`UPDATE t SET` 靶表）：`ON CONFLICT DO UPDATE SET` 的 UPDATE
 *  是 upsert 子句动词，其后 SET 不是表——首词规则天然放行 upsert 形。 */
function checkTablePrefix(tokens: Token[], ns: string, tool: string, cte: Set<string>): void {
  const prefix = `${ns}__`;
  const firstWord = tokens.find((x) => x.t === "word") as { t: "word"; v: string } | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const x = tokens[i] as Token;
    if (x.t !== "word" || !TABLE_POS.has(x.v.toUpperCase())) continue;
    if (x.v.toUpperCase() === "UPDATE" && x !== firstWord) continue;
    const got = tableAfter(tokens, i);
    if (!got) throw new Error(`[${tool}] ${x.v} 位后缺表名（SQL 不完整）`);
    const dotted = tokens[got.next + 1];
    if (dotted !== undefined && dotted.t === "punct" && dotted.v === ".") {
      throw new Error(`[${tool}] 禁 schema 限定表名 ${JSON.stringify(`${got.name}.*`)}（只收裸表名且须以 ${prefix} 开头）`);
    }
    if (got.name.includes(".")) throw new Error(`[${tool}] 禁 schema 限定表名 ${JSON.stringify(got.name)}（只收裸表名且须以 ${prefix} 开头）`);
    if (cte.has(got.name)) continue;
    if (!got.name.startsWith(prefix)) {
      throw new Error(`[${tool}] 表 ${JSON.stringify(got.name)} 越界：本 ns 只许操作 ${prefix}*（跨 ns 请换 ns 参数）`);
    }
  }
}

/** 读工具动词位禁写：语句动词位（起始/(/,/)/,/; 后且非 AS 别名位）出现写动词即拒。
 *  后随 `(` 的是函数调用位（如 replace(v,'a','b')），SQLite 写语句动词后从不直接跟 `(`——豁免。 */
function checkNoWriteVerbs(tokens: Token[], tool: string): void {
  const sig: Token[] = tokens;
  for (let i = 0; i < sig.length; i += 1) {
    const x = sig[i] as Token;
    if (x.t !== "word" || !WRITE_VERBS.has(x.v.toUpperCase())) continue;
    const prev = i === 0 ? null : (sig[i - 1] as Token);
    const prevOk = prev === null || (prev.t === "punct" && (prev.v === "(" || prev.v === ")" || prev.v === "," || prev.v === ";"));
    if (!prevOk) continue;
    const next = i + 1 < sig.length ? (sig[i + 1] as Token) : null;
    if (next !== null && next.t === "word" && next.v.toUpperCase() === "AS") continue;
    if (next !== null && next.t === "punct" && next.v === "(") continue;
    throw new Error(`[${tool}] 读工具禁写动词 ${x.v}（写请调 vault_db_exec；读面只收 SELECT/WITH/EXPLAIN）`);
  }
}

/** CTE 名收集（`名 AS (` 定义位，读工具表前缀豁免用）。 */
function collectCteNames(tokens: Token[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const a = tokens[i] as Token;
    const b = tokens[i + 1] as Token;
    const c = tokens[i + 2] as Token;
    if ((a.t === "word" || a.t === "name") && b.t === "word" && b.v.toUpperCase() === "AS" && c.t === "punct" && c.v === "(") {
      out.add(a.t === "word" ? a.v : (a as { v: string }).v);
    }
  }
  return out;
}

/** 写工具门：白名单 + 表前缀（返回 token 供执行复用，不二次切分）。 */
function gateExec(ns: string, sql: string): Token[] {
  const tool = "vault_db_exec";
  const tokens = tokenize(sql);
  if (tokens.length === 0) throw new Error(`[${tool}] sql 为空`);
  checkNoForbidden(tokens, tool);
  checkSingleStatement(tokens, tool);
  const w = words(tokens);
  const head = w[0] as string;
  if (head === "CREATE" || head === "DROP") {
    let i = 1;
    if (w[i] === "OR") throw new Error(`[${tool}] 禁 OR REPLACE（只收 CREATE TABLE / CREATE INDEX 裸形）`);
    if (w[i] === "TEMP" || w[i] === "TEMPORARY") throw new Error(`[${tool}] 禁 TEMP 表（临时表绕过 ns 前缀门）`);
    if (w[i] === "IF") {
      if (w[i + 1] !== "NOT" && head === "CREATE") throw new Error(`[${tool}] CREATE 只收 IF NOT EXISTS 形`);
      if (head === "DROP" && w[i + 1] === "NOT") throw new Error(`[${tool}] DROP 只收 IF EXISTS 形（禁 IF NOT EXISTS）`);
      i += head === "CREATE" ? 3 : 2;
    }
    if (w[i] !== "TABLE" && w[i] !== "INDEX") throw new Error(`[${tool}] ${head} 只收 TABLE / INDEX（不收 ${w[i] ?? "空"}）`);
  } else if (head !== "INSERT" && head !== "UPDATE" && head !== "DELETE") {
    throw new Error(
      `[${tool}] 首关键字只收 INSERT/UPDATE/DELETE/CREATE TABLE/CREATE INDEX/DROP TABLE/DROP INDEX（实收 ${w[0] ?? "空"}；读请调 vault_db_query）`,
    );
  }
  checkTablePrefix(tokens, ns, tool, new Set());
  return tokens;
}

/** 读工具门：SELECT/WITH/EXPLAIN + 同前缀检查（返回 token 供执行复用）。 */
function gateQuery(ns: string, sql: string): Token[] {
  const tool = "vault_db_query";
  const tokens = tokenize(sql);
  if (tokens.length === 0) throw new Error(`[${tool}] sql 为空`);
  checkNoForbidden(tokens, tool);
  checkSingleStatement(tokens, tool);
  const w = words(tokens);
  const head = w[0] as string;
  if (head === "EXPLAIN") {
    let i = 1;
    if (w[i] === "QUERY") i += 2;
    const inner = w[i] as string | undefined;
    if (inner !== "SELECT" && inner !== "WITH" && inner !== "EXPLAIN") {
      throw new Error(`[${tool}] EXPLAIN 内层只收 SELECT/WITH/EXPLAIN（禁 EXPLAIN 写语句）`);
    }
  } else if (head !== "SELECT" && head !== "WITH") {
    throw new Error(`[${tool}] 首关键字仅 SELECT/WITH/EXPLAIN（实收 ${w[0] ?? "空"}；写请调 vault_db_exec）`);
  }
  checkNoWriteVerbs(tokens, tool);
  checkTablePrefix(tokens, ns, tool, collectCteNames(tokens));
  return tokens;
}

/* ---------------- params 校验与行清洗 ---------------- */

/** SQL 绑定参数：只收 string/number/null（boolean/对象/数组 fail-loud，防隐式转义错位）。 */
function checkParams(params: unknown, tool: string): Array<string | number | null> {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new Error(`[${tool}] params 须为数组（实收 ${typeof params}）`);
  for (const p of params) {
    if (p === null || typeof p === "string" || typeof p === "number") continue;
    throw new Error(`[${tool}] params 只收 string/number/null（实收 ${Array.isArray(p) ? "array" : typeof p}；二进制请先走 vault_put_blob 存字节）`);
  }
  return params as Array<string | number | null>;
}

/** 无损 JSON 值（与上游 JsonValue 同构；本地声明，不新增包引用）。 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** 查询行清洗：registry 按 output.schema 严格验收——BLOB 列转 base64、大整数超限转字符串，保证无损 JSON。 */
function cleanRows(raw: unknown[]): Array<Record<string, Json>> {
  return raw.map((r) => {
    const row = r as Record<string, unknown>;
    const out: Record<string, Json> = {};
    for (const k of Object.keys(row)) {
      const v: unknown = row[k];
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
      else if (v instanceof Uint8Array) out[k] = Buffer.from(v).toString("base64");
      else if (typeof v === "bigint") out[k] = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
      else throw new Error(`[vault_db_query] 列 ${JSON.stringify(k)} 含不可 JSON 序列化值（${typeof v}；请改查标量列）`);
    }
    return out;
  });
}

/* ---------------- 本次调用后端（lazy：apply 期不建，execute 期现建现用） ---------------- */

function backendFor(exec: unknown, config?: VaultToolsConfig) {
  const like = exec as unknown as ToolExecLike;
  const cwd = String(like?.agent?.session?.meta?.cwd ?? like?.agent?.session?.header?.cwd ?? process.cwd());
  const root = resolveVaultDir(cwd, { configVaultDir: config?.vaultDir });
  const kind = String(config?.backend ?? "local").trim() || "local";
  return createBackend(kind as VaultBackendKind, root);
}

function renderOne(tool: string, text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: `[${tool}] ${text}` }];
}

/* ---------------- 五工具 ---------------- */

const PUT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sha256: { type: "string", description: "内容寻址主键（64 位 hex）" },
    bytes: { type: "integer", description: "字节数" },
    storedPath: { type: "string", description: "落盘绝对路径" },
  },
} as const;

const GET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sha256: { type: "string", description: "内容寻址主键（64 位 hex）" },
    bytes: { type: "integer", description: "字节数" },
    storedPath: { type: "string", description: "落盘绝对路径" },
    bytesBase64: {
      oneOf: [{ type: "string" }, { type: "null" }],
      description: "小文件内联 base64；超 8MB 阈值返 null（只给路径，调用方自行读盘）",
    },
  },
} as const;

const EXEC_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    changes: { type: "integer", description: "影响行数（驱动返回口径；DDL 不保证为 0）" },
    lastInsertRowid: {
      oneOf: [{ type: "number" }, { type: "null" }],
      description: "最后插入行 id（仅 INSERT 且 changes>0 时有值，否则 null）",
    },
  },
} as const;

const QUERY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    columns: { type: "array", items: { type: "string" }, description: "列名（无行时为空数组）" },
    rows: { type: "array", items: { type: "json" }, description: "行数组（BLOB 列已转 base64，大整数超限转字符串）" },
  },
} as const;

const NS_INFO_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ns: { type: "string", description: "ns 名原文" },
    path: { type: "string", description: "ns 库绝对路径" },
    tables: { type: "array", items: { type: "string" }, description: "表清单（sqlite 内表与 vault 内部 meta 表除外）" },
    integrity: { type: "string", const: "ok", description: "integrity_check 结论（非 ok 即抛，不落值）" },
  },
} as const;

function makePutBlobTool(config?: VaultToolsConfig): ToolRecord {
  return defineTool({
    name: "vault_put_blob",
    description:
      "Store bytes into the vault content-addressed blob home (idempotent by sha256). Params: path/bytesBase64（二选一必填；path 须本机绝对路径，bytesBase64 解码后≤8MB）. Returns {sha256,bytes,storedPath}.",
    parameters: {
      path: { type: "string", description: "源文件本机绝对路径（与 bytesBase64 二选一）" },
      bytesBase64: { type: "string", description: "字节 base64（与 path 二选一；解码后≤8MB）" },
    },
    output: {
      schema: PUT_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => {
        const v = value as { sha256?: string; bytes?: number; storedPath?: string };
        return renderOne("vault_put_blob", `sha=${String(v?.sha256).slice(0, 12)}… bytes=${String(v?.bytes)} path=${v?.storedPath ?? ""}`);
      },
    },
    timeoutMs: BLOB_TIMEOUT_MS,
    async execute(args, exec) {
      const tool = "vault_put_blob";
      const fromPath = String(args.path ?? "").trim();
      const fromB64 = String(args.bytesBase64 ?? "").trim();
      if ((fromPath === "") === (fromB64 === "")) {
        throw new Error(`[${tool}] path 与 bytesBase64 二选一必填（只给一个：大文件给 path，小字节给 base64）`);
      }
      const backend = backendFor(exec, config);
      if (fromPath !== "") {
        if (!isAbsolute(fromPath)) throw new Error(`[${tool}] path 须本机绝对路径（实收 ${JSON.stringify(fromPath)}）`);
        try {
          return await backend.putBlob({ path: fromPath });
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`[${tool}] 存字节失败（path=${fromPath}）：${reason}`);
        }
      }
      const compact = fromB64.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
        throw new Error(`[${tool}] bytesBase64 非法 base64（字符集/长度错；原文前 32 字符：${fromB64.slice(0, 32)}…）`);
      }
      const bytes = Buffer.from(compact, "base64");
      if (bytes.length === 0) throw new Error(`[${tool}] bytesBase64 解码为空（请传非空字节）`);
      if (bytes.length > BLOB_INLINE_LIMIT) {
        throw new Error(`[${tool}] base64 解码后 ${bytes.length} 字节，超过 8MB 上限（大文件请改传 path 源，由服务端流式入库）`);
      }
      try {
        return await backend.putBlob({ bytes });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`[${tool}] 存字节失败：${reason}`);
      }
    },
  }) as unknown as ToolRecord;
}

function makeGetBlobTool(config?: VaultToolsConfig): ToolRecord {
  return defineTool({
    name: "vault_get_blob",
    description:
      "Fetch a blob by sha256. Params: sha256（64 位 hex）. Small files inline base64, over-8MB returns only storedPath (bytesBase64=null). Returns {sha256,bytes,storedPath,bytesBase64}.",
    parameters: {
      sha256: { type: "string", required: true, description: "内容寻址主键（64 位 hex）" },
    },
    output: {
      schema: GET_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => {
        const v = value as { sha256?: string; bytes?: number; storedPath?: string; bytesBase64?: string | null };
        const mode = v?.bytesBase64 === null ? "路径（超 8MB 未内联）" : "内联";
        return renderOne("vault_get_blob", `sha=${String(v?.sha256).slice(0, 12)}… bytes=${String(v?.bytes)} ${mode} path=${v?.storedPath ?? ""}`);
      },
    },
    timeoutMs: BLOB_TIMEOUT_MS,
    async execute(args, exec) {
      const tool = "vault_get_blob";
      const sha = String(args.sha256 ?? "").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(sha))
        throw new Error(`[${tool}] sha256 非法（须 64 位 hex，实收 ${JSON.stringify(String(args.sha256 ?? "").slice(0, 32))}…）`);
      const backend = backendFor(exec, config);
      let storedPath: string;
      try {
        storedPath = backend.getBlobPath(sha.toLowerCase());
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`[${tool}] 取字节失败：${reason}`);
      }
      let size: number;
      try {
        size = statSync(storedPath).size;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`[${tool}] 落盘文件不可读（${storedPath}）：${reason}`);
      }
      if (size > BLOB_INLINE_LIMIT) {
        return { sha256: sha.toLowerCase(), bytes: size, storedPath, bytesBase64: null };
      }
      const bytesBase64 = readFileSync(storedPath).toString("base64");
      return { sha256: sha.toLowerCase(), bytes: size, storedPath, bytesBase64 };
    },
  }) as unknown as ToolRecord;
}

function makeDbExecTool(config?: VaultToolsConfig): ToolRecord {
  return defineTool({
    name: "vault_db_exec",
    description:
      "Write SQL in one ns (single statement; first keyword INSERT/UPDATE/DELETE/CREATE TABLE/CREATE INDEX/DROP TABLE/DROP INDEX; every table/index must be <ns>__*; no semicolon-chaining/ATTACH/PRAGMA/VACUUM). Params: ns/sql/params?(string|number|null[]). Returns {changes,lastInsertRowid}.",
    parameters: {
      ns: { type: "string", required: true, description: "命名空间（^[a-z0-9-]{1,32}$，表须 <ns>__*）" },
      sql: { type: "string", required: true, description: "单条写 SQL（表全匹配 <ns>__*）" },
      params: { type: "array", description: "绑定参数（只收 string/number/null 数组）" },
    },
    output: {
      schema: EXEC_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => {
        const v = value as { changes?: number; lastInsertRowid?: number | null };
        return renderOne("vault_db_exec", `changes=${String(v?.changes)} lastInsertRowid=${String(v?.lastInsertRowid)}`);
      },
    },
    timeoutMs: DB_TIMEOUT_MS,
    async execute(args, exec) {
      const tool = "vault_db_exec";
      const ns = String(args.ns ?? "");
      assertNsName(ns);
      const sql = String(args.sql ?? "");
      if (!sql.trim()) throw new Error(`[${tool}] sql 为空`);
      const head = headOf(gateExec(ns, sql));
      const binds = checkParams(args.params, tool);
      const backend = backendFor(exec, config);
      const handle = backend.openDb(ns);
      try {
        let info: { changes: unknown; lastInsertRowid: unknown };
        try {
          info = handle.db.prepare(sql).run(...binds) as unknown as { changes: unknown; lastInsertRowid: unknown };
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`[${tool}] 执行失败（ns=${ns}）：${reason}`);
        }
        const changes = typeof info.changes === "bigint" ? Number(info.changes) : (info.changes as number);
        // lastInsertRowid 是连接级水位（会泄漏建库 meta 行的旧值）：仅 INSERT 且 changes>0 时返回值，
        // 0（DDL / WITHOUT ROWID 表）与非 INSERT 一律归一为 null。
        const rowid = info.lastInsertRowid;
        const numRowid =
          typeof rowid === "bigint" ? (rowid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rowid) : null) : typeof rowid === "number" ? rowid : null;
        const lastInsertRowid = head === "INSERT" && changes > 0 ? (numRowid === 0 ? null : numRowid) : null;
        return { changes, lastInsertRowid };
      } finally {
        handle.close();
      }
    },
  }) as unknown as ToolRecord;
}

function makeDbQueryTool(config?: VaultToolsConfig): ToolRecord {
  return defineTool({
    name: "vault_db_query",
    description:
      "Read SQL in one ns (single statement; first keyword only SELECT/WITH/EXPLAIN; every table must be <ns>__*; CTE names exempt; no writes/ATTACH/PRAGMA/VACUUM). Params: ns/sql/params?(string|number|null[]). Returns {columns,rows}.",
    parameters: {
      ns: { type: "string", required: true, description: "命名空间（^[a-z0-9-]{1,32}$，表须 <ns>__*）" },
      sql: { type: "string", required: true, description: "单条读 SQL（表全匹配 <ns>__*）" },
      params: { type: "array", description: "绑定参数（只收 string/number/null 数组）" },
    },
    output: {
      schema: QUERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => {
        const v = value as { rows?: unknown[] };
        return renderOne("vault_db_query", `rows=${String(v?.rows?.length ?? 0)}`);
      },
    },
    timeoutMs: DB_TIMEOUT_MS,
    async execute(args, exec) {
      const tool = "vault_db_query";
      const ns = String(args.ns ?? "");
      assertNsName(ns);
      const sql = String(args.sql ?? "");
      if (!sql.trim()) throw new Error(`[${tool}] sql 为空`);
      gateQuery(ns, sql);
      const binds = checkParams(args.params, tool);
      const backend = backendFor(exec, config);
      const handle = backend.openDb(ns);
      try {
        let raw: unknown[];
        try {
          raw = (handle.db.prepare(sql).all(...binds) ?? []) as unknown[];
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`[${tool}] 查询失败（ns=${ns}）：${reason}`);
        }
        const rows = cleanRows(raw);
        const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
        return { columns, rows };
      } finally {
        handle.close();
      }
    },
  }) as unknown as ToolRecord;
}

function makeNsInfoTool(config?: VaultToolsConfig): ToolRecord {
  return defineTool({
    name: "vault_ns_info",
    description: "Inspect one ns (db path + table list + integrity_check). Params: ns. Returns {ns,path,tables,integrity}.",
    parameters: {
      ns: { type: "string", required: true, description: "命名空间（^[a-z0-9-]{1,32}$）" },
    },
    output: {
      schema: NS_INFO_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => {
        const v = value as { ns?: string; path?: string; tables?: string[]; integrity?: string };
        return renderOne("vault_ns_info", `ns=${v?.ns ?? ""} tables=[${(v?.tables ?? []).join(",")}] integrity=${v?.integrity ?? ""}`);
      },
    },
    timeoutMs: DB_TIMEOUT_MS,
    async execute(args, exec) {
      const tool = "vault_ns_info";
      const ns = String(args.ns ?? "");
      assertNsName(ns);
      const backend = backendFor(exec, config);
      const handle = backend.openDb(ns);
      try {
        let tables: string[];
        try {
          const rows = (handle.db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'meta' ORDER BY name`)
            .all() ?? []) as Array<{
            name: string;
          }>;
          tables = rows.map((r) => r.name);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`[${tool}] 列举表失败（ns=${ns}）：${reason}`);
        }
        let integrity: Array<{ integrity_check: string }>;
        try {
          integrity = (handle.db.prepare(`PRAGMA integrity_check`).all() ?? []) as Array<{ integrity_check: string }>;
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`[${tool}] 自检失败（ns=${ns}，${handle.path}）：${reason}`);
        }
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
          throw new Error(`[${tool}] 自检失败（ns=${ns}，${handle.path}）：integrity_check=${JSON.stringify(integrity).slice(0, 200)}`);
        }
        return { ns, path: handle.path, tables, integrity: "ok" as const };
      } finally {
        handle.close();
      }
    },
  }) as unknown as ToolRecord;
}

/** 注册面工厂（cordis apply 消费；tests 直调验合同形状）。 */
export function createVaultTools(config?: VaultToolsConfig): ToolRecord[] {
  return [makePutBlobTool(config), makeGetBlobTool(config), makeDbExecTool(config), makeDbQueryTool(config), makeNsInfoTool(config)];
}
