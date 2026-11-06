import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs: the build works from any path (GitHub Pages, IPFS, a subfolder).
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["@anon-rpc/browser-harness"] },
});
