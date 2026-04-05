import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const tokenServerPort = process.env.TOKEN_SERVER_PORT || '8787'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Pet Cam',
        short_name: 'PetCam',
        description: '커플용 홈캠 (LiveKit)',
        theme_color: '#fff0f3',
        background_color: '#fff5f7',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg}'],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${tokenServerPort}`,
        changeOrigin: true,
      },
    },
  },
})
