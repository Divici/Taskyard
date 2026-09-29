import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const sharedAlias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        // The shell-menu helper runs in its own Electron utility process (native menus).
        input: {
          index: resolve('src/main/index.ts'),
          'shell-menu-helper': resolve('src/main/shell-menu/helper.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // A sandboxed preload can only require('electron') and a few polyfilled builtins, so every
      // dependency must be bundled into one self-contained CommonJS file.
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs' } }
    }
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer'), ...sharedAlias }
    },
    plugins: [react(), tailwindcss()]
  }
})
