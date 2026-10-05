import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Project Pages: l'app è servita da /staticai/, non dalla radice.
  base: '/staticai/',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    target: 'es2023',
    rollupOptions: {
      output: {
        // Vite 8 usa Rolldown: `manualChunks` accetta solo la forma funzione,
        // la forma oggetto è stata rimossa.
        manualChunks(id: string) {
          if (id.includes('node_modules/@pixiv/three-vrm')) return 'vrm'
          if (id.includes('node_modules/three')) return 'three'
          return undefined
        },
      },
    },
  },
})