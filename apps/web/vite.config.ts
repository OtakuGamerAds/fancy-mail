import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.FANCY_MAIL_SERVER_PORT ?? "47822";
const serverUrl = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5190,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: serverUrl, changeOrigin: false },
      "/mcp": { target: serverUrl, changeOrigin: false },
      "/ws": { target: serverUrl, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
    chunkSizeWarningLimit: 2000,
  },
});
