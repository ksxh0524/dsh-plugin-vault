/** tools-db.test.ts —— db 双工具 + ns_info：经真 apply 接线，ns 隔离正向 + 前缀逃逸负向矩阵
 *  （裸表名/ATTACH/多语句/DROP sqlite_master 全红，读工具拒写、写工具拒读；fixture 全在 /tmp）。 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/cordis.ts";
import type { ToolRecord } from "../src/tools.ts";

const BARE_EXEC = {};

function tools(): { exec: ToolRecord; query: ToolRecord; info: ToolRecord } {
  const list: ToolRecord[] = [];
  apply(
    {
      tools: {
        register: (t: ToolRecord) => {
          list.push(t);
          return t;
        },
      },
    },
    { vaultDir: mkdtempSync(join(tmpdir(), "vault-tools-db-")), backend: "local" },
  );
  const byName = (n: string): ToolRecord => {
    const t = list.find((x) => x.name === n);
    assert.ok(t, `应注册工具 ${n}`);
    return t;
  };
  return { exec: byName("vault_db_exec"), query: byName("vault_db_query"), info: byName("vault_ns_info") };
}

describe("正向：写读往返 + ns 隔离", () => {
  test("建表/插入/查询/自检同一 ns 内闭环", async () => {
    const { exec, query, info } = tools();
    const ddl = (await exec.execute({ ns: "red", sql: "CREATE TABLE red__t (id INTEGER PRIMARY KEY, v TEXT)" }, BARE_EXEC)) as {
      changes: number;
      lastInsertRowid: null;
    };
    assert.equal(typeof ddl.changes, "number");
    assert.equal(ddl.lastInsertRowid, null);
    const ins = (await exec.execute({ ns: "red", sql: "INSERT INTO red__t (v) VALUES (?), (?)", params: ["a", "b"] }, BARE_EXEC)) as {
      changes: number;
      lastInsertRowid: number;
    };
    assert.equal(ins.changes, 2);
    assert.equal(typeof ins.lastInsertRowid, "number");
    const got = (await query.execute({ ns: "red", sql: "SELECT v FROM red__t ORDER BY id", params: [] }, BARE_EXEC)) as {
      columns: string[];
      rows: Array<{ v: string }>;
    };
    assert.deepEqual(got.columns, ["v"]);
    assert.deepEqual(
      got.rows.map((r) => r.v),
      ["a", "b"],
    );
    const i = (await info.execute({ ns: "red" }, BARE_EXEC)) as { ns: string; path: string; tables: string[]; integrity: string };
    assert.equal(i.ns, "red");
    assert.ok(i.path.endsWith(join("ns", "red", "store.db")));
    assert.deepEqual(i.tables, ["red__t"]);
    assert.equal(i.integrity, "ok");
  });

  test("ns 隔离：red 写 blue 不可见（查即无此表，自检空表）", async () => {
    const { exec, query, info } = tools();
    await exec.execute({ ns: "red", sql: "CREATE TABLE red__t (v TEXT)" }, BARE_EXEC);
    await assert.rejects(query.execute({ ns: "blue", sql: "SELECT * FROM red__t" }, BARE_EXEC), /只许操作 blue__/);
    await assert.rejects(query.execute({ ns: "blue", sql: "SELECT * FROM blue__t" }, BARE_EXEC), /no such table/);
    const i = (await info.execute({ ns: "blue" }, BARE_EXEC)) as { tables: string[] };
    assert.deepEqual(i.tables, []);
  });

  test("upsert 形放行（ON CONFLICT DO UPDATE 的 UPDATE 非动词位）", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "up", sql: "CREATE TABLE up__k (k TEXT PRIMARY KEY, v TEXT)" }, BARE_EXEC);
    await exec.execute({ ns: "up", sql: "INSERT INTO up__k (k, v) VALUES ('a', '1')" }, BARE_EXEC);
    await exec.execute({ ns: "up", sql: "INSERT INTO up__k (k, v) VALUES ('a', '2') ON CONFLICT(k) DO UPDATE SET v = excluded.v" }, BARE_EXEC);
    const got = (await query.execute({ ns: "up", sql: "SELECT v FROM up__k WHERE k = ?", params: ["a"] }, BARE_EXEC)) as { rows: Array<{ v: string }> };
    assert.equal(got.rows[0]?.v, "2");
  });

  test("CTE 读放行（定义名豁免）；EXPLAIN 读放行；末尾单分号容忍", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "ct", sql: "CREATE TABLE ct__t (v TEXT)" }, BARE_EXEC);
    await exec.execute({ ns: "ct", sql: "INSERT INTO ct__t (v) VALUES ('x')" }, BARE_EXEC);
    const cte = (await query.execute({ ns: "ct", sql: "WITH c AS (SELECT v FROM ct__t) SELECT v FROM c" }, BARE_EXEC)) as { rows: unknown[] };
    assert.equal(cte.rows.length, 1);
    const ex = (await query.execute({ ns: "ct", sql: "EXPLAIN SELECT v FROM ct__t" }, BARE_EXEC)) as { rows: unknown[] };
    assert.ok(ex.rows.length > 0);
    const semi = (await query.execute({ ns: "ct", sql: "SELECT v FROM ct__t;" }, BARE_EXEC)) as { rows: unknown[] };
    assert.equal(semi.rows.length, 1);
  });

  test("串内关键字不误伤（值含 ATTACH/分号照写入读）", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "str", sql: "CREATE TABLE str__t (v TEXT)" }, BARE_EXEC);
    await exec.execute({ ns: "str", sql: "INSERT INTO str__t (v) VALUES ('ATTACH; DROP TABLE str__t')" }, BARE_EXEC);
    const got = (await query.execute({ ns: "str", sql: "SELECT v FROM str__t WHERE v LIKE '%ATTACH%'" }, BARE_EXEC)) as { rows: unknown[] };
    assert.equal(got.rows.length, 1);
  });

  test("索引名前缀同口径：裸索引名拒，ns__ 索引名放行", async () => {
    const { exec } = tools();
    await exec.execute({ ns: "ix", sql: "CREATE TABLE ix__t (v TEXT)" }, BARE_EXEC);
    await assert.rejects(exec.execute({ ns: "ix", sql: "CREATE INDEX idx_v ON ix__t (v)" }, BARE_EXEC), /只许操作 ix__/);
    await exec.execute({ ns: "ix", sql: "CREATE INDEX ix__idx_v ON ix__t (v)" }, BARE_EXEC);
  });
});

describe("负向矩阵：前缀逃逸全红", () => {
  test("裸表名：六形全红（INSERT/UPDATE/DELETE/SELECT/DROP/CREATE）", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "n", sql: "CREATE TABLE n__t (v TEXT)" }, BARE_EXEC);
    await assert.rejects(exec.execute({ ns: "n", sql: "INSERT INTO t (v) VALUES (1)" }, BARE_EXEC), /越界/);
    await assert.rejects(exec.execute({ ns: "n", sql: "UPDATE t SET v = 1" }, BARE_EXEC), /越界/);
    await assert.rejects(exec.execute({ ns: "n", sql: "DELETE FROM t" }, BARE_EXEC), /越界/);
    await assert.rejects(exec.execute({ ns: "n", sql: "DROP TABLE t" }, BARE_EXEC), /越界/);
    await assert.rejects(exec.execute({ ns: "n", sql: "CREATE TABLE t (v TEXT)" }, BARE_EXEC), /越界/);
    await assert.rejects(query.execute({ ns: "n", sql: "SELECT * FROM t" }, BARE_EXEC), /越界/);
  });

  test("跨 ns 表名红（n 库碰 m__ 表）", async () => {
    const { exec, query } = tools();
    await assert.rejects(exec.execute({ ns: "n", sql: "INSERT INTO m__t (v) VALUES (1)" }, BARE_EXEC), /只许操作 n__/);
    await assert.rejects(query.execute({ ns: "n", sql: "SELECT * FROM n__a JOIN m__b ON 1 = 1" }, BARE_EXEC), /只许操作 n__/);
  });

  test("ATTACH 红（读写两面）", async () => {
    const { exec, query } = tools();
    await assert.rejects(exec.execute({ ns: "n", sql: "ATTACH DATABASE '/tmp/x.db' AS x" }, BARE_EXEC), /ATTACH/);
    await assert.rejects(query.execute({ ns: "n", sql: "ATTACH DATABASE '/tmp/x.db' AS x" }, BARE_EXEC), /ATTACH/);
  });

  test("多语句红（读写两面）", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "n", sql: "CREATE TABLE n__t (v TEXT)" }, BARE_EXEC);
    await assert.rejects(exec.execute({ ns: "n", sql: "INSERT INTO n__t (v) VALUES ('a'); DELETE FROM n__t" }, BARE_EXEC), /单语句/);
    await assert.rejects(query.execute({ ns: "n", sql: "SELECT * FROM n__t; SELECT 1" }, BARE_EXEC), /单语句/);
  });

  test("DROP sqlite_master 与读 sqlite_master 全红", async () => {
    const { exec, query } = tools();
    await assert.rejects(exec.execute({ ns: "n", sql: "DROP TABLE sqlite_master" }, BARE_EXEC), /越界/);
    await assert.rejects(query.execute({ ns: "n", sql: "SELECT * FROM sqlite_master" }, BARE_EXEC), /越界/);
  });

  test("PRAGMA/VACUUM 红（读写两面；表结构走 vault_ns_info）", async () => {
    const { exec, query } = tools();
    await assert.rejects(exec.execute({ ns: "n", sql: "PRAGMA journal_mode = WAL" }, BARE_EXEC), /PRAGMA/);
    await assert.rejects(query.execute({ ns: "n", sql: "PRAGMA table_info(n__t)" }, BARE_EXEC), /PRAGMA/);
    await assert.rejects(exec.execute({ ns: "n", sql: "VACUUM" }, BARE_EXEC), /VACUUM/);
  });

  test("schema 限定红（main.n__t 形）", async () => {
    const { exec, query } = tools();
    await assert.rejects(query.execute({ ns: "n", sql: "SELECT * FROM main.n__t" }, BARE_EXEC), /schema 限定/);
    await assert.rejects(exec.execute({ ns: "n", sql: "DROP TABLE main.n__t" }, BARE_EXEC), /schema 限定/);
  });

  test("TEMP 表红；OR REPLACE 红", async () => {
    const { exec } = tools();
    await assert.rejects(exec.execute({ ns: "n", sql: "CREATE TEMP TABLE n__t (v TEXT)" }, BARE_EXEC), /TEMP/);
    await assert.rejects(exec.execute({ ns: "n", sql: "CREATE OR REPLACE TABLE n__t (v TEXT)" }, BARE_EXEC), /OR REPLACE/);
  });
});

describe("读写分离：写工具拒读，读工具拒写", () => {
  test("vault_db_exec 拒 SELECT/WITH/EXPLAIN", async () => {
    const { exec } = tools();
    await exec.execute({ ns: "s", sql: "CREATE TABLE s__t (v TEXT)" }, BARE_EXEC);
    await assert.rejects(exec.execute({ ns: "s", sql: "SELECT * FROM s__t" }, BARE_EXEC), /首关键字/);
    await assert.rejects(exec.execute({ ns: "s", sql: "WITH c AS (SELECT 1) SELECT * FROM c" }, BARE_EXEC), /首关键字/);
    await assert.rejects(exec.execute({ ns: "s", sql: "EXPLAIN SELECT * FROM s__t" }, BARE_EXEC), /首关键字/);
  });

  test("vault_db_query 拒 INSERT/UPDATE/DELETE/CREATE/DROP（含 WITH 套写与 EXPLAIN 套写）", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "s", sql: "CREATE TABLE s__t (v TEXT)" }, BARE_EXEC);
    await assert.rejects(query.execute({ ns: "s", sql: "INSERT INTO s__t (v) VALUES (1)" }, BARE_EXEC), /首关键字/);
    await assert.rejects(query.execute({ ns: "s", sql: "UPDATE s__t SET v = 1" }, BARE_EXEC), /首关键字/);
    await assert.rejects(query.execute({ ns: "s", sql: "DELETE FROM s__t" }, BARE_EXEC), /首关键字/);
    await assert.rejects(query.execute({ ns: "s", sql: "DROP TABLE s__t" }, BARE_EXEC), /首关键字|禁写动词/);
    await assert.rejects(query.execute({ ns: "s", sql: "CREATE TABLE s__x (v TEXT)" }, BARE_EXEC), /首关键字|禁写动词/);
    await assert.rejects(query.execute({ ns: "s", sql: "WITH c AS (SELECT 1) DELETE FROM s__t" }, BARE_EXEC), /禁写动词/);
    await assert.rejects(query.execute({ ns: "s", sql: "EXPLAIN DELETE FROM s__t" }, BARE_EXEC), /EXPLAIN 内层/);
  });
});

describe("参数与 ns 校验", () => {
  test("非法 ns 全红（三工具）", async () => {
    const { exec, query, info } = tools();
    for (const bad of ["Bad!", "", "a_b", "x".repeat(33)]) {
      await assert.rejects(exec.execute({ ns: bad, sql: "SELECT 1" }, BARE_EXEC), /ns 非法/, `exec ${bad}`);
      await assert.rejects(query.execute({ ns: bad, sql: "SELECT 1" }, BARE_EXEC), /ns 非法/, `query ${bad}`);
      await assert.rejects(info.execute({ ns: bad }, BARE_EXEC), /ns 非法/, `info ${bad}`);
    }
  });

  test("空 sql 红；params 非数组/异形元素红", async () => {
    const { exec, query } = tools();
    await assert.rejects(exec.execute({ ns: "p", sql: "  " }, BARE_EXEC), /sql 为空/);
    await assert.rejects(query.execute({ ns: "p", sql: "" }, BARE_EXEC), /sql 为空/);
    await assert.rejects(exec.execute({ ns: "p", sql: "INSERT INTO p__t (k) VALUES (?)", params: "x" }, BARE_EXEC), /must be an array/);
    await assert.rejects(exec.execute({ ns: "p", sql: "INSERT INTO p__t (k) VALUES (?)", params: [true] }, BARE_EXEC), /只收 string\/number\/null/);
    await assert.rejects(query.execute({ ns: "p", sql: "SELECT * FROM p__t WHERE k = ?", params: [{ a: 1 }] }, BARE_EXEC), /只收 string\/number\/null/);
  });

  test("params 绑定真生效（? 占位多行）", async () => {
    const { exec, query } = tools();
    await exec.execute({ ns: "p", sql: "CREATE TABLE p__t (k TEXT, n INTEGER)" }, BARE_EXEC);
    await exec.execute({ ns: "p", sql: "INSERT INTO p__t (k, n) VALUES (?, ?)", params: ["x", 41] }, BARE_EXEC);
    const got = (await query.execute({ ns: "p", sql: "SELECT n FROM p__t WHERE k = ?", params: ["x"] }, BARE_EXEC)) as { rows: Array<{ n: number }> };
    assert.equal(got.rows[0]?.n, 41);
  });
});
