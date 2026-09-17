# asset-store

Generic cross-domain asset library (private, not published): SQLite holds structure and index, files hold bytes. Binaries never enter DB rows — only pointer + hash + references. One vault one database (`<vault>/.av/store.db`); deletion is tombstone-only.

## Layout

```
asset-store/
├── src/
│   ├── index.ts     # re-export surface (design intent in header)
│   ├── schema.ts    # DDL single source + SCHEMA_VERSION gate (fail-loud, no migration)
│   ├── store.ts     # lazy open (WAL + busy_timeout), close, integrity_check
│   ├── registry.ts  # vault registry: configPath > ASSET_VAULT_REGISTRY > ~/.av/vaults.json
│   └── refs.ts      # content-addressed register + refcount + tombstone/restore
└── tests/           # node --test, fixtures under os.tmpdir only
```

## Rules

- Pure Node (`node:sqlite` builtin, zero third-party deps); zero IO at module load — `openStore` runs only on call, so boot is never blocked by the DB.
- Content-addressed: `assets.id = sha256`; same bytes across projects share one row, holders记账 in `refs`, no copies.
- Tombstone-only deletes: `tombstone()` keeps the row and the bytes; no GC unless explicitly ordered with refcount evidence.
- Version gate: `meta.schema_version` mismatch throws `version-mismatch` — delete and rebuild or reindex, never auto-migrate (STANDARDS §7).
- Person/image-generation kinds are deferred: new kinds extend via the `kind` string + `metadata` JSON, no table changes.

## Development

```bash
pnpm install
pnpm check   # prettier + tsc --noEmit + node --test
```

Conventional Commits enforced (scopes: `store` / `schema` / `registry` / `refs` / `tests` / `infra` — see `commitlint.config.cjs`).

## Hosting

Private independent repo (not published, not subtree-pushed). Consumers link it (`"asset-store": "link:../asset-store"` — never the `workspace:` protocol).
