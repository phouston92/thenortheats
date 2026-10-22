import { defineConfig } from "vite";
export default defineConfig({
  server: {
    proxy: { "/api": process.env.API_ORIGIN || "http://127.0.0.1:3001" },
  },
});
