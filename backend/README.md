# Leo Backend

Express + PostgreSQL REST API scaffold generated from backend_spec.doc.

## Quick Start
1. Copy `.env.example` to `.env` and update values.
2. Create database and run schema:
   - `psql $env:DATABASE_URL -f .\sql\schema.sql`
3. Install deps: `npm install`
4. Run: `npm run dev`

## Notes
- Auth uses JWT with `Authorization: Bearer <token>`.
- This is a scaffold; permissions logic is stubbed for now.
