/**
 * Esegue le verifiche di Fase 2.
 *
 * I moduli dell'app usano import senza estensione, come vuole Vite. Node non sa
 * risolverli da solo, quindi li carichiamo attraverso la pipeline SSR di Vite:
 * è lo stesso risolutore che usa l'app in sviluppo, quindi il test esercita il
 * codice reale e non una sua ricostruzione.
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
  await server.ssrLoadModule('/scripts/verify-speech.ts')
} finally {
  await server.close()
}
