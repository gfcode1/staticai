/**
 * Verifica degli strumenti di Fase 5 (ora e meteo).
 *
 * Le API esterne non sono riproducibili, ma quasi tutta la logica qui è pura e
 * si verifica senza rete: il formato dell'ora, la traduzione dei codici WMO, la
 * scelta fra risultati omonimi. Le chiamate di rete si verificano a parte con
 * `fetch` finto, per il caso in cui il servizio risponda male — che è il caso in
 * cui un modello comincia a inventare.
 */

import {
  describeToolCall,
  describeWeatherCode,
  findPlace,
  formatOra,
  getForecast,
  runTool,
  TOOLS,
} from '/src/ai/tools.ts'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, a === b ? '' : `atteso ${b}, ottenuto ${a}`)
}

/* ------------------------------------------------------------------ ora */

console.log('\n=== Formato dell\'ora, leggibile ad alta voce ===')

const quando = new Date('2026-10-08T14:35:00Z')
const oraRoma = formatOra('Europe/Rome', quando)
console.log(`        es. ${oraRoma}`)
check('dice che ore sono', oraRoma.startsWith('Sono le '), oraRoma)
check('non dice mai le 24', !/\ble 24\b/.test(formatOra('Europe/Rome', new Date('2026-10-08T22:30:00Z'))))
check('mezzanotte non diventa 24', /^Sono le 00/.test(formatOra('Europe/Rome', new Date('2026-10-07T22:30:00Z'))), formatOra('Europe/Rome', new Date('2026-10-07T22:30:00Z')))
check('nome del giorno in italiano', /\b(luned|marted|mercoled|gioved|venerd|sabato|domenica)/.test(oraRoma), oraRoma)
check('nome del mese in italiano', /\b(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/.test(oraRoma), oraRoma)
check('nessun separatore ISO residuo', !/\d{4}-\d{2}-\d{2}/.test(oraRoma), oraRoma)
check('zona sconosciuta non crasha', typeof formatOra('Non/Unzona', quando) === 'string')

// Due zone diverse, stessa istante: l'ora deve differire.
const Tokyo = formatOra('Asia/Tokyo', quando)
check('fusi diversi danno ore diverse', Tokyo !== oraRoma, `Roma=${oraRoma} Tokyo=${Tokyo}`)

/* ------------------------------------------------------------ codici WMO */

console.log('\n=== Codici meteo in italiano ===')

const attesi = {
  0: 'sereno',
  2: 'parzialmente nuvoloso',
  3: 'nuvoloso',
  45: 'nebbia',
  61: 'pioggia leggera',
  65: 'pioggia forte',
  71: 'neve leggera',
  95: 'temporale',
  99: 'temporale con grandine forte',
}
for (const [code, testo] of Object.entries(attesi)) {
  eq(`WMO ${code}`, describeWeatherCode(Number(code)), testo)
}
eq('codice assente', describeWeatherCode(undefined), 'condizioni non note')
eq('codice sconosciuto', describeWeatherCode(1234), 'condizioni non note (codice 1234)')
eq('NaN gestito', describeWeatherCode(Number.NaN), 'condizioni non note')
check('nessun codice WMO resta senza traduzione', Object.keys(attesi).every((c) => !describeWeatherCode(Number(c)).includes('codice')))

/* -------------------------------------------------------- definizioni */

console.log('\n=== Le dichiarazioni degli strumenti ===')

eq('gli strumenti dichiarati', TOOLS.map((t) => t.name), ['ora', 'meteo', 'ricorda', 'dimentica'])
for (const tool of TOOLS) {
  check(`${tool.name}: nome conforme`, /^[a-z_]{1,64}$/.test(tool.name))
  check(`${tool.name}: descrizione presente`, tool.description.length > 20)
  check(`${tool.name}: schema oggetto`, tool.parameters.type === 'object')
}
eq('il meteo richiede il luogo', TOOLS.find((t) => t.name === 'meteo').parameters.required, ['luogo'])
eq('l\'ora non richiede parametri', TOOLS.find((t) => t.name === 'ora').parameters.required, [])
check('il meteo limita quando a due valori', JSON.stringify(TOOLS.find((t) => t.name === 'meteo').parameters.properties.quando.enum) === JSON.stringify(['oggi', 'domani']))
check('nessuna descrizione contiene caratteri non latini', !TOOLS.some((t) => /[一-鿿]/.test(t.description + JSON.stringify(t.parameters))))

/* ------------------------------------------------------------ rete finta */

console.log('\n=== Comportamento quando la rete non collabora ===')

const realeFetch = globalThis.fetch

function mockFetch(rotte: Record<string, unknown>, stato = 200) {
  globalThis.fetch = (async (url: string) => {
    for (const [frammento, risposta] of Object.entries(rotte)) {
      if (url.includes(frammento)) {
        if (risposta instanceof Error) throw risposta
        return new Response(JSON.stringify(risposta), { status: stato })
      }
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

const Roma = {
  name: 'Roma',
  region: 'Lazio',
  country: 'Italia',
  latitude: 41.9,
  longitude: 12.5,
  timezone: 'Europe/Rome',
}

// Luogo inesistente: l'errore deve essere una frase, non un'eccezione.
mockFetch({ search: { results: [] } })
eq('luogo inesistente → frase comprensibile', await runTool({ id: '1', name: 'meteo', arguments: { luogo: 'Atlantide' } }, 'it'), 'Non ho trovato "Atlantide". Prova con il nome della città.')

// Luogo senza nome: l'errore deve chiedere, non indovinare.
eq('luogo vuoto → chiede di ripetere', await runTool({ id: '2', name: 'meteo', arguments: {} }, 'it'), "Devo sapere il luogo: chiedi all'utente di ripetere.")

const previsioni = {
  current: {
    temperature_2m: 19.6,
    apparent_temperature: 18.1,
    relative_humidity_2m: 87,
    weather_code: 3,
    wind_speed_10m: 4,
  },
  daily: {
    weather_code: [3, 61],
    temperature_2m_max: [22.1, 19.4],
    temperature_2m_min: [14.2, 12.8],
  },
}

mockFetch({ search: { results: [Roma] }, forecast: previsioni })
const meteo = await runTool({ id: '3', name: 'meteo', arguments: { luogo: 'Roma' } }, 'it')
check('meteo con dati completi', /A Roma.*adesso.*gradi/.test(meteo), meteo)
console.log(`        es. ${meteo}`)

// Previsione di domani.
const domani = await runTool({ id: '4', name: 'meteo', arguments: { luogo: 'Roma', quando: 'domani' } }, 'it')
check('previsione di domani', /^Domani a Roma/.test(domani), domani)
console.log(`        es. ${domani}`)

// Chiamata fallita: deve tornare una frase, non far esplodere il turno.
mockFetch({ search: { results: [Roma] }, forecast: new TypeError('connessione persa') })
const guasto = await runTool({ id: '5', name: 'meteo', arguments: { luogo: 'Roma' } }, 'it')
check('rete caduta → frase, non errore', typeof guasto === 'string' && guasto.length > 0, guasto)
console.log(`        es. ${guasto}`)

// Dati meteo incompleti: non inventare.
mockFetch({ search: { results: [Roma] }, forecast: { current: {} } })
const incompleto = await runTool({ id: '6', name: 'meteo', arguments: { luogo: 'Roma' } }, 'it')
check('dati mancanti → lo dice', /Non ho i dati attuali/.test(incompleto), incompleto)

// Strumento sconosciuto.
eq('strumento sconosciuto', await runTool({ id: '7', name: 'telepatia', arguments: {} }, 'it'), 'Strumento sconosciuto: telepatia.')

// Uno strumento che solleva un'eccezione non deve portare via il turno: `runTool`
// non gira per i strumenti di memoria (ha il suo percorso), ma il ciclo degli
// strumenti deve restare vivo anche se qualcosa va storto.
const romaPerMeteo = { id: '9', name: 'meteo', arguments: { luogo: 'Roma' } }
mockFetch({ search: { results: [Roma] }, forecast: new Error('esploso') })
const sopravvive = await runTool(romaPerMeteo, 'it')
check('un errore di rete non rompe lo strumento', typeof sopravvive === 'string' && sopravvive.length > 10, sopravvive)

/* --------------------------------------------- indicatore di attività */

console.log('\n=== Cosa sta facendo lo strumento ===')

const attivita: [string, Record<string, unknown>, RegExp][] = [
  ['ora', {}, /controllando l'ora$/],
  ['ora', { zona: 'Roma' }, /controllando l'ora a Roma$/],
  ['meteo', { luogo: 'Roma' }, /meteo a Roma adesso$/],
  ['meteo', { luogo: 'Milano', quando: 'domani' }, /meteo a Milano domani$/],
  ['ricorda', { fatto: 'vive a Milano' }, /registrando un ricordo$/],
  ['dimentica', { cosa: 'Milano' }, /dimenticando qualcosa$/],
]
for (const [name, args, atteso] of attivita) {
  const testo = describeToolCall({ id: '1', name: name as never, arguments: args })
  check(`attività di ${name}${Object.keys(args).length ? ' con argomenti' : ''}`, atteso.test(testo), testo)
  check(`attività di ${name}: una riga sola`, !testo.includes('\n'), testo)
  check(`attività di ${name}: niente parametri grezzi`, !/\{|\}|\"undefined\"/.test(testo), testo)
}

eq('strumento sconosciuto', describeToolCall({ id: '1', name: 'teletrasporto', arguments: {} }), 'sta usando teletrasporto')
eq('argomento non stringa', describeToolCall({ id: '1', name: 'meteo', arguments: { luogo: 42 } }), 'sta controllando il meteo')

/* ------------------------------------------------- disambiguazione luoghi */

console.log('\n=== Due città con lo stesso nome ===')

mockFetch({
  search: {
    results: [
      { name: 'Roma', admin1: 'Lazio', country: 'Italia', latitude: 41.9, longitude: 12.5, timezone: 'Europe/Rome' },
      { name: 'Roma', admin1: 'Botosani', country: 'Romania', latitude: 47.8, longitude: 26.6, timezone: 'Europe/Bucharest' },
    ],
  },
})
const scelto = await findPlace('Roma', undefined, 'it')
eq('la città del Paese dell\'utente ha la precedenza', scelto?.country, 'Italia')

// Risultati malformati: nessun crash.
mockFetch({ search: { results: [{ name: 'X' }] } })
const malformato = await findPlace('X')
check('risultato senza coordinate non crasha', malformato === null || typeof malformato.latitude === 'number')

// Il campo si chiama `admin1` nell'API reale: se il mapping è sbagliato la
// regione resta vuota e la frase non dice dove si trova.
mockFetch({ search: { results: [{ name: 'Roma', admin1: 'Lazio', country: 'Italia', latitude: 41.9, longitude: 12.5, timezone: 'Europe/Rome' }] } })
const conRegione = await findPlace('Roma', undefined, 'it')
eq('admin1 diventa la regione', conRegione?.region, 'Lazio')

globalThis.fetch = realeFetch

/* ------------------------------------------- risultato parlabile */

console.log('\n=== Il risultato è parlabile ===')

mockFetch({
  search: { results: [Roma] },
  forecast: {
    current: {
      temperature_2m: 19.6,
      apparent_temperature: 18.1,
      relative_humidity_2m: 87,
      weather_code: 3,
      wind_speed_10m: 21.4,
    },
    daily: { weather_code: [3, 61], temperature_2m_max: [22.1, 19.4], temperature_2m_min: [14.2, 12.8] },
  },
})
const parlato = await runTool({ id: '8', name: 'meteo', arguments: { luogo: 'Roma' } }, 'it')
console.log(`        ${parlato}`)
check('nessun numero secco leggibile male', !/\d+\.\d/.test(parlato), parlato)
check('gradi arrotondati', !parlato.includes('19.6'), parlato)
check('il vento forte viene citato', parlato.includes('21'), parlato)
check('frase intera, con punto', parlato.trim().endsWith('.') || parlato.trim().endsWith('chilometri orari.'), parlato)
check('nessun carattere non latino', !/[一-鿿]/.test(parlato), parlato)

globalThis.fetch = realeFetch

console.log('\n=== riepilogo ===')
console.log(`${passed} verifiche superate, ${failed} fallite`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('TUTTE LE VERIFICHE SUPERATE')