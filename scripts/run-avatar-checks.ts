/** Esegue le verifiche del selettore di avatar. */

import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  await server.ssrLoadModule('/scripts/verify-avatar.ts')
} finally {
  await server.close()
}
