import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Split the heavy libraries into their own cached chunks so the main app
    // bundle is smaller (faster parse) and 3D/editor/syntax code loads + caches
    // separately from the rest of the app. Keeps repeat loads snappy.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          editor: ['@monaco-editor/react'],
          syntax: ['react-syntax-highlighter'],
          motion: ['gsap'],
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173, // Frontend dev server port
    proxy: {
      '/api': { // Proxy requests starting with /api to the backend
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''), // Remove /api prefix
      },
    },
  },
  // Vitest configuration — unit tests for lib/ helpers and components.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
});


