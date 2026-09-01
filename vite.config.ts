import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
// vitest/config re-exports vite's defineConfig with the `test` block typed.
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const srcDir = path.resolve(root, "src");

export default defineConfig({
  root,
  plugins: [react()],
  envPrefix: "VITE_",
  envDir: root,
  resolve: {
    alias: {
      "@/app": path.resolve(srcDir, "app"),
      "@/api": path.resolve(srcDir, "api"),
      "@/components": path.resolve(srcDir, "components"),
      "@/pages": path.resolve(srcDir, "pages"),
      "@/types": path.resolve(srcDir, "types"),
    },
  },
  server: { port: 3000 },
  build: { outDir: path.resolve(root, "dist"), emptyOutDir: true },
  test: {
    globals: true,
    environment: "jsdom",
    include: [path.resolve(srcDir, "**/*.{test,spec}.{ts,tsx}")],
    exclude: ["node_modules", "dist"],
  },
});
