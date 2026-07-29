import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        changeOrigin: false,
        target: "http://127.0.0.1:3001",
      },
    },
  },
});
