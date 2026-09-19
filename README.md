# dsh-plugin-vault

Generic storage-layer plugin (private, not published): one namespace = one SQLite library (`<vaultDir>/ns/<ns>/store.db`), one global content-addressed byte home (`<vaultDir>/blobs/<aa>/<sha256>`). Binaries never enter DB rows. Five tools serve namespaces; the package-root library surface (`src/index.ts`) is frozen for old callers — new code goes through the `Backend` seam (`src/backend.ts`).

```
plugin-vault/
├── src/
│   ├── index.ts     # FROZEN library surface (design intent in header; new code must not reference it)
│   ├── schema.ts    # DDL single source + SCHEMA_VERSION gate (fail-loud, no migration)
│   ├── vault.ts     # lazy openVault(vaultDir) (WAL + busy_timeout), close, integrity_check
│   ├── blobs.ts     # content-addressed put/get: blobs/<aa>/<sha256>, streaming hash
│   ├── backend.ts   # Backend seam: LocalBackend (one DB per ns) + S3Backend stub
│   ├── tools.ts     # five tool definitions + token-level SQL gate
│   └── cordis.ts    # plugin shell: { name, inject, apply } (zero IO at load)
├── cordis.patch.yml # bundle layer: id dsh-plugin-vault, config vaultDir + backend only
└── tests/           # node --test, fixtures under os.tmpdir only
```

## Tools & Services

| Tool           | Params                                                       | Returns                                                                   |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| vault_put_blob | `path` / `bytesBase64` (exactly one; base64 decodes ≤8MB)    | `{ sha256, bytes, storedPath }`                                           |
| vault_get_blob | `sha256` (64 hex)                                            | `{ sha256, bytes, storedPath, bytesBase64 }` (`null` over 8MB: path only) |
| vault_db_exec  | `ns`, `sql` (single write), `params?` (string/number/null[]) | `{ changes, lastInsertRowid }` (rowid only for effective INSERTs)         |
| vault_db_query | `ns`, `sql` (single read), `params?`                         | `{ columns, rows }` (BLOB columns as base64)                              |
| vault_ns_info  | `ns`                                                         | `{ ns, path, tables, integrity }`                                         |

## Contract

No Remote — tools only.

| Item        | Rule                                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL gate    | `vault_db_exec` accepts first keywords `INSERT` / `UPDATE` / `DELETE` / `CREATE TABLE` / `CREATE INDEX` / `DROP TABLE` / `DROP INDEX` only; `vault_db_query` accepts `SELECT` / `WITH` / `EXPLAIN` only (an `EXPLAIN`ed write is rejected, writes inside `WITH` are rejected)                  |
| Prefix gate | Every table/index touched by SQL must be `<ns>__*` (`FROM` / `JOIN` / `INTO` / `UPDATE` / `TABLE` / `INDEX` positions, subqueries included; string literals don't count); schema-qualified names, `TEMP` tables and unprefixed index names are rejected; read-side `WITH` CTE names are exempt |
| Hygiene     | Single statement per call (one trailing semicolon tolerated); `ATTACH`, `PRAGMA` and `VACUUM` rejected on both faces; domain errors are Chinese fail-loud with a way out and never fall back                                                                                                   |

## Config

| key        | Description                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vaultDir` | Store root (absolute path); empty = env `DSH_VAULT_DIR` > neutral anchor (walk up from the calling session cwd for `.vault/workspace.json`; valid JSON counts). A total miss fails loud — never a machine directory |
| `backend`  | `"local"` only; `"s3"` throws not-implemented with a way out                                                                                                                                                        |

Namespace names must match `^[a-z0-9-]{1,32}$`; hyphenated namespaces (e.g. `script-v2`) need quoted table names (`"script-v2__t"` — a bare one parses as subtraction and fails closed).

## Install

Private independent repo (not published). Consumers link it — never the `workspace:` protocol:

```sh
# profile package.json dependencies:
"dsh-plugin-vault": "link:../plugin-vault"
```

Bundle row: id `dsh-plugin-vault`, name `dsh-plugin-vault/cordis` (subpath to the shell — the frozen package root keeps serving old bare imports). Host restart is user-owned.

## Verify

```sh
node --test tests/*.test.ts    # server logic first (ns isolation, blob limits, backend truth)
pnpm check                      # prettier + tsc + full tests (no check:browser — no browser half)
```

Boot gate before installing into any profile: follow `docs/runbooks/plugin-gate.md` on a test preset (never port 3080) — the shell registers five tools and does zero IO at load, so boot is never blocked by the DB.

## Browser half

No browser half — no `lib/`, no `dsh.client` entry in `package.json`; server tools only.

## Known limits

- Single statement per call; `params` accepts only string/number/null.
- Bytes are global and content-addressed (`<vaultDir>/blobs/<aa>/<sha256>`, shared across namespaces); size mismatch = fail-loud.
- `bytesBase64` payloads decode to ≤8MB (larger files go through the `path` source, which streams); reads over 8MB return the path only.
- Only `local` backend is implemented; `SCHEMA_VERSION` is not bumped by the plugin layer (no migration).
