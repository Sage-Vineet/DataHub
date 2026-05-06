# DataHub Backend

Express API for DataHub.

## Runtime modes

- **PostgreSQL / Supabase mode**: enabled whenever `DATABASE_URL` is present.
- **SQLite fallback mode**: used only when `DATABASE_URL` is not set.

This lets you keep the current application behavior while moving toward Supabase.

## Setup

1. Copy `.env.example` to `.env`
2. Install dependencies
   ```bash
   npm install
   ```
3. Create tables
   - PostgreSQL / Supabase: run `sql/schema.sql` or `../supabase/schema.sql`
   - SQLite fallback: schema is auto-created from `sqlite-schema.sql`
4. Start the API
   ```bash
   npm run dev
   ```

## Important

The database compatibility layer now normalizes SQL placeholders so existing controllers keep working in both SQLite and PostgreSQL/Supabase without changing UI logic.
