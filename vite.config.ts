import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const tokenServerPort = process.env.TOKEN_SERVER_PORT || '8787'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: '단이 HOUSE',
        short_name: '단이HOUSE',
        description: '커플용 홈캠 (LiveKit)',
        theme_color: '#fff0f3',
        background_color: '#fff5f7',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg}'],
      },
    }),
  ],
  server: {
    // :: 로 listen → 브라우저가 localhost → ::1 로 붙을 때도 됨 + 같은 와이파이(아이폰)에서 맥 IP로 접속
    host: '::',
    port: 5173,
    strictPort: true,
    // LAN IP로 열 때 Host 검증 이슈 방지 (로컬 개발용)
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${tokenServerPort}`,
        changeOrigin: true,
      },
    },
  },
})
