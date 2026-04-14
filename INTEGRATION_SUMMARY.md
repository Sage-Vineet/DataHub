Integrated cleanup applied without changing frontend UI, routes, or visual design.

Main changes:
- sanitized the deliverable by removing live `.env` files and generated artifacts
- added `.env.example` at root
- cleaned `backend/.env.example`
- added SQL compatibility layer so existing `?` placeholder queries also work with PostgreSQL / Supabase
- switched backend DB selection to use PostgreSQL / Supabase whenever `DATABASE_URL` exists
- kept SQLite fallback for local development with no database URL
- aligned PostgreSQL schema with runtime expectations:
  - `buyer_groups.description`
  - `bank_transactions.client_id`
  - `reconciliation_transactions.client_id`
- added `supabase/schema.sql` for direct Supabase setup

Files changed:
- README.md
- backend/README.md
- backend/.env.example
- backend/src/db/index.js
- backend/src/db/sqlCompat.js
- backend/sql/schema.sql
- supabase/schema.sql

Files removed from the shared package:
- .env
- backend/.env
- .git
- dist
- structure.txt
- backend/package-lock 2.json
- qb-state json files
- macOS .DS_Store files
