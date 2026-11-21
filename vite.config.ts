import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE : chemin de publication (ex. "/PianoCompagnon/" sur GitHub Pages).
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  build: { chunkSizeWarningLimit: 3000 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: { maximumFileSizeToCacheInBytes: 8 * 1024 * 1024, globPatterns: ['**/*.{js,css,html,svg,png,xml}'] },
      manifest: {
        name: 'Piano Compagnon',
        short_name: 'Piano',
        description: 'Lis ta partition, joue sur ton piano MIDI : la partition avance quand tu joues juste.',
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
