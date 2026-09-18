# dsh-plugin-vault

Generic storage-layer plugin (private, not published): one namespace = one SQLite library (`<vaultDir>/ns/<ns>/store.db`), one global content-addressed byte home (`<vaultDir>/blobs/<aa>/<sha256>`). Binaries never enter DB rows. Five tools serve namespaces; the package-root library surface (`src/index.ts`) is frozen for old callers until the migration wave cuts them over — new code goes through the `Backend` seam (`src/backend.ts`).

## Overview

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

## Install

Private independent repo (not published, not subtree-pushed). Consumers link it (`"dsh-plugin-vault": "link:../plugin-vault"` — never the `workspace:` protocol). The plugin shell loads via the `./cordis` subpath so the frozen package root keeps serving old bare imports:

```yaml
# profile bundles entry (package name) + patch insert (subpath to the shell):
bundles: ["dsh-plugin-vault"]
# cordis.patch.yml insert:
- id: dsh-plugin-vault
  name: dsh-plugin-vault/cordis
```

```bash
pnpm install
pnpm check   # prettier + tsc --noEmit + node --test
```

Conventional Commits enforced (scopes: `vault` / `schema` / `blobs` / `backend` / `tools` / `cordis` / `tests` / `infra` — see `commitlint.config.cjs`).

## Tools

| Tool           | Params                                                       | Returns                                                                   |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| vault_put_blob | `path` / `bytesBase64` (exactly one; base64 decodes ≤8MB)    | `{ sha256, bytes, storedPath }`                                           |
| vault_get_blob | `sha256` (64 hex)                                            | `{ sha256, bytes, storedPath, bytesBase64 }` (`null` over 8MB: path only) |
| vault_db_exec  | `ns`, `sql` (single write), `params?` (string/number/null[]) | `{ changes, lastInsertRowid }` (rowid only for effective INSERTs)         |
| vault_db_query | `ns`, `sql` (single read), `params?`                         | `{ columns, rows }` (BLOB columns as base64)                              |
| vault_ns_info  | `ns`                                                         | `{ ns, path, tables, integrity }`                                         |

`vault_db_exec` accepts first keywords `INSERT` / `UPDATE` / `DELETE` / `CREATE TABLE` / `CREATE INDEX` / `DROP TABLE` / `DROP INDEX` only; `vault_db_query` accepts `SELECT` / `WITH` / `EXPLAIN` only (an `EXPLAIN`ed write is rejected, writes inside `WITH` are rejected). Semicolon chaining, `ATTACH`, `PRAGMA`, and `VACUUM` are rejected on both faces. Domain errors are Chinese fail-loud with a way out and never fall back (wrong JSON types are rejected in English by the platform argument check, like every tool).

## Configuration

Two keys only (`cordis.patch.yml`):

```yaml
config:
  vaultDir: "" # store root (absolute path); empty = env DSH_VAULT_DIR > neutral anchor
  backend: "local" # only local is implemented; "s3" throws not-implemented with a way out
```

Resolution order for the store root: `config.vaultDir` > env `DSH_VAULT_DIR` > neutral anchor (walk up from the calling session cwd for `.vault/workspace.json`; valid JSON counts). A total miss fails loud naming all three ways out — never a machine directory. Namespace names must match `^[a-z0-9-]{1,32}$`.

## Namespaces and limits

- One namespace = one library: `<vaultDir>/ns/<ns>/store.db` (WAL + `busy_timeout`, per-ns schema gate). No registry table; `SCHEMA_VERSION` is not bumped by the plugin layer.
- Bytes are global and content-addressed: `<vaultDir>/blobs/<aa>/<sha256>`, shared across namespaces (same sha stored once; size mismatch = fail-loud, the disk was touched outside the vault).
- Every table/index touched by SQL must be `<ns>__*` (`FROM` / `JOIN` / `INTO` / `UPDATE` / `TABLE` / `INDEX` positions, subqueries included; string literals don't count). Schema-qualified names (`main.t`) are rejected, as are `TEMP` tables and index names without the prefix. Read-side `WITH` query CTE names are exempt. Hyphenated namespaces (e.g. `script-v2`) need quoted table names (`"script-v2__t"`): a bare `script-v2__t` parses as subtraction and fails closed.
- Limits: single statement per call (one trailing semicolon tolerated); `params` accepts only string/number/null; `bytesBase64` payloads decode to ≤8MB (larger files go through the `path` source, which streams); reads over 8MB return the path only; `BLOB` columns come back base64-encoded.

## Verify

```bash
pnpm check                          # gate: prettier + tsc + full node --test
node --test tests/tools-db.test.ts  # ns isolation + prefix-escape negative matrix
node --test tests/tools-blob.test.ts # blob idempotency / conflict / over-limit
node --test tests/backend.test.ts    # LocalBackend truth + S3 stub assertions
```

Boot gate before installing into any profile: follow `docs/runbooks/plugin-gate.md` on a test preset (never port 3080) — the shell registers five tools and does zero IO at load, so boot is never blocked by the DB. `npm publish` is run by the user only.
