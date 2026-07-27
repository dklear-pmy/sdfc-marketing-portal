import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre spawns its worker via `new Worker(new URL(...))`; Vite's dep
  // pre-bundling breaks that resolution in dev, so leave it unbundled.
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8123",
    },
  },
})
