import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Lightweight component gallery. Run with: pnpm --filter @datahub/ui gallery
export default defineConfig({
  root: "gallery",
  plugins: [react()],
});
