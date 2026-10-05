/**
 * Verifica degli strumenti contro le API vere.
 *
 * Non fa parte di `npm test` perché dipende dalla rete e da servizi di terzi: se
 * Open-Meteo è lento o giù, il fallimento non è nostro. Serve a controllare a
 * mano che i dati arrivano davvero nel formato atteso.
 */

import { findPlace, formatOra, getForecast, runTool, describeWeatherCode } from '../src/ai/tools.ts'

const esito = (nome: string, ok: boolean, dettaglio = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${nome}${dettaglio ? ' — ' + dettaglio : ''}`)
  if (!ok) process.exitCode = 1
}

console.log('\n=== API vere ===')

const roma = await findPlace('Roma', undefined, 'it')
esito('geocodifica Roma', roma?.latitude !== undefined, roma ? `${roma.name}, ${roma.region} (${roma.latitude}, ${roma.longitude}) ${roma.timezone}` : 'nessun risultato')

const napoli = await findPlace('Napoli', undefined, 'it')
esito('geocodifica Napoli', napoli !== null, napoli ? `${napoli.name}, ${napoli.region}` : 'nessun risultato')

const inesistente = await findPlace('Zzzzqqx non esiste', undefined, 'it')
esito('luogo inesistente → null', inesistente === null, String(inesistente))

if (roma) {
  const oggi = await getForecast(roma, 'oggi')
  esito('meteo oggi non vuoto', oggi.length > 20, oggi)

  const domani = await getForecast(roma, 'domani')
  esito('meteo domani non vuoto', domani.length > 20, domani)

  esito('nessun numero decimale', !/\d+\.\d/.test(oggi), oggi)
  esito('nessun carattere non latino', !/[一-鿿]/.test(oggi))
}

console.log('\n=== Strumenti via runTool ===')
const ora = await runTool({ id: '1', name: 'ora', arguments: {} })
esito('ora', ora.startsWith('Sono le '), ora)

const oraRoma = await runTool({ id: '2', name: 'ora', arguments: { zona: 'Roma' } })
esito('ora di Roma', oraRoma.startsWith('Sono le '), oraRoma)

const oraTokyo = await runTool({ id: '3', name: 'ora', arguments: { zona: 'Asia/Tokyo' } })
esito('ora di Tokyo', oraTokyo !== oraRoma, `${oraRoma} / ${oraTokyo}`)

const meteo = await runTool({ id: '4', name: 'meteo', arguments: { luogo: 'Roma' } })
esito('meteo Roma', meteo.startsWith('A Roma'), meteo)

const meteoDomani = await runTool({ id: '5', name: 'meteo', arguments: { luogo: 'Milano', quando: 'domani' } })
esito('meteo Milano domani', meteoDomani.startsWith('Domani a Milano'), meteoDomani)

const ignoto = await runTool({ id: '6', name: 'meteo', arguments: { luogo: 'Atlantide' } })
esito('luogo ignoto', ignoto.includes('Non ho trovato'), ignoto)

console.log(`\nWMO 0 → ${describeWeatherCode(0)}`)
console.log(`ora locale: ${formatOra('Europe/Rome')}`)
