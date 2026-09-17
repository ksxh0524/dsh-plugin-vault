# vault

Generic storage base (private, not published): the medium owner. One vault is one directory — `.av/store.db` holds the index (SQLite), `.av/blobs/` holds the bytes. Binaries never enter DB rows. This layer knows no `kind`, keeps no references, does no lifecycle — that is `dsh-plugin-asset`'s job.

## Layout

```
plugin-vault/
├── src/
│   ├── index.ts     # re-export surface (design intent in header)
│   ├── schema.ts    # DDL single source + SCHEMA_VERSION gate (fail-loud, no migration)
│   ├── vault.ts     # lazy openVault(vaultDir) (WAL + busy_timeout), close, integrity_check
│   └── blobs.ts     # content-addressed put/get: .av/blobs/<aa>/<sha256>, streaming hash
└── tests/           # node --test, fixtures under os.tmpdir only
```

## Rules

- Pure Node (`node:sqlite` builtin, zero third-party deps); zero IO at module load — `openVault` runs only on call, so boot is never blocked by the DB.
- Content-addressed bytes: same sha256 is stored once; re-put reuses (size mismatch = fail-loud, disk was touched outside the vault).
- Atomic landing: tmp + rename, never half-written files; large files stream (two passes, constant memory).
- Version gate: `meta.schema_version` mismatch throws `version-mismatch` — delete and rebuild or reindex, never auto-migrate (STANDARDS §7).

## Development

```bash
pnpm install
pnpm check   # prettier + tsc --noEmit + node --test
```

Conventional Commits enforced (scopes: `vault` / `schema` / `blobs` / `tests` / `infra` — see `commitlint.config.cjs`).

## Hosting

Private independent repo (not published, not subtree-pushed). Consumers link it (`"dsh-plugin-vault": "link:../plugin-vault"` — never the `workspace:` protocol).
