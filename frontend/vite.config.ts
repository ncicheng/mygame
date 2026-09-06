import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages 项目页部署在子路径下，用相对 base 保证资源路径正确
  base: './',
  server: {
    proxy: {
      // 开发时前端 /api 代理到本地后端
      '/api': {
        target: process.env.BACKEND_URL ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});