import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Production build hardening.
 *
 * Everything bundled here is public — never put a secret in a VITE_* variable.
 * The controls below are about not shipping more than necessary.
 */
export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production'

  return {
    plugins: [react()],

    build: {
      // Source maps expose original source, comments, internal file paths and
      // any TODO naming an internal system. Off in production.
      //
      // If you need production stack traces, use 'hidden': maps are generated
      // for upload to an error tracker but NOT referenced by a
      // sourceMappingURL comment, so browsers never fetch them.
      sourcemap: !isProduction,

      minify: isProduction ? 'esbuild' : false,

      chunkSizeWarningLimit: 1200,

      rollupOptions: {
        output: {
          // Content-hashed filenames let assets be cached immutably while
          // guaranteeing a new deploy is never served from a stale cache.
          entryFileNames: 'assets/[name].[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: 'assets/[name].[hash].[ext]',
        },
      },
    },

    esbuild: {
      // Strip console and debugger from production output. Beyond bundle size,
      // this removes debug logging that routinely contains tokens, user records
      // and internal identifiers — readable by anyone with devtools open.
      drop: isProduction ? ['console', 'debugger'] : [],
      legalComments: isProduction ? 'none' : 'inline',
    },

    define: {
      // Guarantees React's production build so dev warnings tree-shake out. A
      // debug build in production leaks component names and props via DevTools.
      'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
      __DEV__: JSON.stringify(!isProduction),
    },

    server: {
      // Loopback only. `host: true` exposes your working tree — including any
      // VITE_* values inlined into the bundle — to everyone on the local
      // network, café and conference Wi-Fi included.
      host: '127.0.0.1',
      // Stops the dev server's file-serving endpoint being used to read
      // arbitrary files from the developer's machine.
      fs: { strict: true, allow: ['.'] },
    },

    preview: {
      host: '127.0.0.1',
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    },
  }
})
