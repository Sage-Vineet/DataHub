# DataHub V1

This is a single application with two runtime parts:

- `src/` + Vite = frontend
- `backend/` + Express = backend API

## Run locally

### 1) Frontend env
Create `.env` from `.env.example`:

```env
VITE_API_BASE_URL=http://localhost:4000
```

### 2) Backend env
Create `backend/.env` from `backend/.env.example`.

- If `DATABASE_URL` is set, the backend uses PostgreSQL/Supabase.
- If `DATABASE_URL` is empty, the backend falls back to local SQLite for development.

### 3) Install
```bash
npm install
cd backend && npm install
```

### 4) Start both
```bash
npm run dev
```

## Notes

- QuickBooks credentials and AWS credentials must stay only in `backend/.env`.
- The integrated version keeps the current UI and route structure unchanged.
- `supabase/schema.sql` is provided so you can create the same tables inside Supabase.
