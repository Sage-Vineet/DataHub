import base from "@datahub/config/eslint";

/** UI package: shared base + allow the React automatic-runtime (no React import). */
export default [
  ...base,
  {
    rules: {
      // Radix + cva patterns re-export types/consts; keep noise low.
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
];
