## 1. Decide the bootstrap source

- [ ] 1.1 Choose the source of truth for a fresh dev database: Drizzle migrations,
      a sanitized production snapshot, or an explicitly-maintained seed schema
- [ ] 1.2 Record the decision and its rationale in this change's `design.md`

## 2. Implement

- [ ] 2.1 Rewrite `devenv.nix`'s `load-schema` to use the chosen source
- [ ] 2.2 Verify from empty: a fresh database reaches a usable state in one command
- [ ] 2.3 Add a vitest check that the bootstrap path stays runnable, so this cannot
      silently rot the way `schema.sql` did
