import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    mode === 'development' ? inspectAttr() : null,
    react(),
  ],
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // React 运行时（含 react/jsx-runtime、scheduler）统一归入 react chunk，
          // 避免 jsx-runtime 被并入 motion chunk 而把 framer-motion 拖进首屏。
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) {
            return 'motion';
          }
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) {
            return 'charts';
          }
          if (id.includes('highlight.js')) return 'markdown';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('@tauri-apps')) return 'tauri';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
