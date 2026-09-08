import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Served under /app/ behind the site's rewrite, so every asset URL the build
  // emits has to carry that prefix.
  base: "/app/",
  server: {
    // shared/tokens.css lives one level above this app's root.
    fs: { allow: [".."] },
  },
  plugins: [react()],
})
