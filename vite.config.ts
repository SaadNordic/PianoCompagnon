import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE : chemin de publication web. CAPACITOR=1 : version embarquée dans l'APK (sans service worker).
const base = process.env.BASE ?? '/';
const native = process.env.CAPACITOR === '1';

export default defineConfig({
  base,
  build: { chunkSizeWarningLimit: 3000 },
  plugins: [
    VitePWA({
      disable: native,
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: { maximumFileSizeToCacheInBytes: 8 * 1024 * 1024, globPatterns: ['**/*.{js,css,html,svg,png,xml}'] },
      manifest: {
        name: 'My Music Inst',
        short_name: 'My Music',
        description: 'Lis ta partition, joue sur ton instrument : la partition avance quand tu joues juste.',
        lang: 'fr',
        display: 'fullscreen',
        orientation: 'any',
        background_color: '#14161c',
        theme_color: '#14161c',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      }
    })
  ]
});
