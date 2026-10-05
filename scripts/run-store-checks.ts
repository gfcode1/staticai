/** Esegue le verifiche della Fase 7 (store e persistenza). */

import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  await server.ssrLoadModule('/scripts/verify-store.ts')
} finally {
  await server.close()
}
