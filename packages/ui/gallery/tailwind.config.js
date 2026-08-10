import uiPreset from "../tailwind-preset.js";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [uiPreset],
  content: ["./index.html", "./**/*.{ts,tsx}", "../src/**/*.{ts,tsx}"],
};
