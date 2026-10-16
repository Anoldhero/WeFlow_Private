import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    watch: { ignored: ['**/.pnpm-store/**', '**/.pnpm-cache/**', '**/.cache/**', '**/.backups/**', '**/backups/**', '**/deploy/**', '**/release/**', '**/dist-electron/**', '**/dist-server/**', '**/resources/**', '**/vendor/**', '**/data/**', '**/.generated/**'] },
    proxy: { '/cloud': { target: 'http://127.0.0.1:4310', rewrite: path => path.replace(/^\/cloud/, '') } }
  },
  build: { outDir: 'dist' }
})
