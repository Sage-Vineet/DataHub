import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `VITE_API_BASE_URL` is inlined into the bundle at BUILD time, not read at
 * runtime. If it is missing on Vercel the build still succeeds and ships a site
 * whose every API call goes to `http://localhost:8080` — broken for every user,
 * with no error anywhere in the pipeline.
 *
 * So fail the build instead, but only where that silent failure is actually
 * possible: on Vercel (which sets `VERCEL=1`). Local and CI builds are untouched,
 * since there the localhost default is the correct one.
 */
function requireApiBaseUrlOnVercel() {
  return {
    name: 'datahub:require-api-base-url-on-vercel',
    config(_config, { command }) {
      const onVercel = process.env.VERCEL === '1'
      const missing = !process.env.VITE_API_BASE_URL
      if (command === 'build' && onVercel && missing) {
        throw new Error(
          'VITE_API_BASE_URL is not set for this Vercel build.\n' +
            'It is inlined at build time, so without it the deployed SPA would call\n' +
            'http://localhost:8080 and fail for every user.\n' +
            'Set it in Vercel → Project → Settings → Environment Variables to the API\n' +
            'origin (the gateway, which proxies to the legacy backend).',
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), requireApiBaseUrlOnVercel()],
})
