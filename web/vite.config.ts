import { readFileSync } from 'node:fs'
import { Agent } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
// Read only the local TLS material on the Node side. Private account config is
// never read by Vite, and none of these Buffers are imported by application code.
const cert = readFileSync(new URL('../.tools/certs/localhost.pem', import.meta.url))
const key = readFileSync(new URL('../.tools/certs/localhost.key', import.meta.url))
const agent = new Agent({ ca: cert, rejectUnauthorized: true })
const proxy = {
  '/api': { target: 'https://127.0.0.1:5443', changeOrigin: true, secure: true, agent },
  '/health': { target: 'https://127.0.0.1:5443', changeOrigin: true, secure: true, agent },
}
function privateFilesGuard(): Plugin {
  const guard = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
      let path: string
      try { path = decodeURIComponent((request.url ?? '/').split('?')[0]!).replaceAll('\\', '/') } catch { response.statusCode = 400; response.end(); return }
      if (/(^|\/)\.tools(?:\/|$)|(^|\/)\.env(?:[./]|$)|\.(?:pem|key|pfx|p12)(?:\/|$)/i.test(path)) { response.statusCode = 403; response.end('Access denied'); return }
      next()
  }
  return { name: 'vibe-private-files', configureServer(server) { server.middlewares.use(guard) }, configurePreviewServer(server) { server.middlewares.use(guard) } }
}
export default defineConfig({
  root: webRoot,
  plugins: [privateFilesGuard()],
  server: {
    host: 'localhost', port: 5173, strictPort: true, https: { cert, key }, proxy,
    fs: { strict: true, allow: [webRoot], deny: ['**/.tools/**', '**/.env', '**/.env.*', '**/*.{pem,key,pfx,p12}', '**/.git/**', '**/.codex/**'] },
  },
  preview: { host: 'localhost', port: 4173, strictPort: true, https: { cert, key }, proxy },
})
