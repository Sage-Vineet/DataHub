import uiPreset from "@datahub/ui/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  // Design tokens now come from the shared @datahub/ui preset (single source),
  // so the app and the component library render identically.
  presets: [uiPreset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Scan @datahub/ui component source so their Tailwind classes are generated.
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
};
