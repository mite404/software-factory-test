import { defineConfig } from "vite";

// Status, events and ticket evidence use the same API proxy.
export default defineConfig({
  // the SPEC-01 kit under web/spec imports its own files as "@/..."
  resolve: { alias: { "@": new URL("./spec", import.meta.url).pathname } },
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
