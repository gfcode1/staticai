/**
 * Esegue le verifiche di Fase 3.
 *
 * Stessa impostazione di `run-speech-checks.ts`: i moduli usano import senza
 * estensione, quindi li carichiamo attraverso il risolutore di Vite.
 */

import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  await server.ssrLoadModule('/scripts/verify-listening.ts')
} finally {
  await server.close()
}
