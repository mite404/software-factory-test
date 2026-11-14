import { defineConfig } from "vite";

// The page only reads /api/status from the read-only dashboard service (factory/dashboard.ts).
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": process.env.FACTORY_API ?? "http://127.0.0.1:4310",
    },
  },
});
