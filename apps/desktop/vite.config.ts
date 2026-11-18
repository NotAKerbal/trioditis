import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  // Better Auth runs on the Convex deployment's HTTP actions. The app reaches it through its
  // own origin, so its session cookie is first-party; the deployment's SITE_URL is this origin.
  const convexSite = env.VITE_CONVEX_SITE_URL ?? 'http://127.0.0.1:3211'
  const authProxy = { '/api/auth': { target: convexSite, changeOrigin: true } }
  return {
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: { tsconfigPaths: true },
    server: { host: '127.0.0.1', port: Number(env.VITE_PORT ?? 5173), strictPort: true, proxy: authProxy },
    preview: { host: '127.0.0.1', port: Number(env.VITE_PORT ?? 5173), strictPort: true, proxy: authProxy },
  }
})
