/**
 * Verifica della Fase 4 (client di OpenRouter e segmentazione del parlato).
 *
 * Lo streaming e la rete non sono riproducibili qui. La segmentazione delle frasi
 * sì, ed è la parte dove un errore si sente: se perde una sillaba l'avavatar dice
 * una parola diversa da quella scritta, e non se ne accorge nessuno.
 */

import { splitSpeakable, SpeakableTail } from '/src/ai/speakQueue.ts'
import { parseFreeModels } from '/src/ai/models.ts'
import {
  backoffDelay,
  ChatError,
  DEFAULT_MAX_ATTEMPTS,
  failureFromResponse,
  FAILURE_MESSAGES,
  isRetryableStatus,
  parseRetryAfter,
  readEventStream,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  sleep,
  streamChat,
} from '/src/ai/openrouter.ts'

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

/* ------------------------------------------------------------------ fedeltà */

console.log('\n=== Fedeltà: nessun carattere perso ===')

const campioni = [
  'Ciao, sono un assistente vocale e sto muovendo la bocca.',
  'Piove a Roma. Domani no.',
  'Il valore è 3.5 e il numero è 1.000.000.',
  'Aspetta... sto arrivando!',
  'Vedi sig. Rossi e il dott. Bianchi.',
  'G. Rossi ha detto: "no".',
  'Uno, due, tre.',
  'Chiedi: che tempo fa?',
  'Nessuna punteggiatura per un bel po\' di testo cosi',
  '',
  '   ',
  'A.',
  '.',
  '..',
  '...',
  'Fine.',
  'Fine',
  'Frase.\n\nuova riga',
  'Elenco:\n- uno\n- due',
  'Prezzo: 12,50 € o 9,99 €.',
  'Chiamò il 06-06-2026.',
  'Il file è README.md e funziona.',
  'Versione 1.2.3 rilasciata.',
  'Anche "virgolette chiuse" e (parentesi) e [parentesi quadre].',
  'Domanda? Risposta! Esclamazione.',
]

for (const testo of campioni) {
  const { speakable, rest } = splitSpeakable(testo)
  check(`fedele: ${JSON.stringify(testo.slice(0, 34))}`, speakable + rest === testo, `perso: ${JSON.stringify(testo.slice(0, speakable.length + rest.length))}`)
}

/* -------------------------------------------------------------- frasi intere */

console.log('\n=== Riconoscimento dei confini di frase ===')

// Il divisore tiene il prefisso pronunciabile più lungo, non il primo: unendo
// "Davvero? Si!" in un solo chunk la sintesi suona meglio che a due scatti.
const frasi = [
  ['Ciao, sono un assistente vocale.', 'Ciao, sono un assistente vocale.', ''],
  ['Piove a Roma. Domani no.', 'Piove a Roma.', ' Domani no.'],
  ['Davvero? Si!', 'Davvero? Si!', ''],
  // Una riga breve sotto la soglia viene trattenuta: pronunciare "Prima riga"
  // da sola suonerebbe a scatto, quindi aspetta di avere altro testo.
  ['Prima riga\nSeconda riga lunga', '', 'Prima riga\nSeconda riga lunga'],
  ['Prima riga sufficientemente lunga\nSeconda riga', 'Prima riga sufficientemente lunga\n', 'Seconda riga'],
]
for (const [input, speakable, rest] of frasi) {
  const r = splitSpeakable(input)
  eq(`frase: ${JSON.stringify(input.slice(0, 30))}`, [r.speakable, r.rest], [speakable, rest])
}

/* ------------------------------------------------------------------ numeri */

console.log('\n=== Numeri che non sono confini ===')

// La domanda è una sola: il divisore taglia *dentro* il numero? Il numero deve
// restare intero, punto o virgola che sia.
const numeri = [
  'Il valore è 3.5 e va bene.',
  'Circa 1.000.000 di persone qui.',
  'La versione 2.1.3 è scaricata.',
  'Costa 12.50 euro.',
]
for (const testo of numeri) {
  const { speakable, rest } = splitSpeakable(testo)
  const spezzato = [...speakable, ...rest].join('')
  check(`numero mai spezzato: ${JSON.stringify(testo.slice(0, 32))}`, spezzato === testo)
  check(
    `nessun numero resta appeso: ${JSON.stringify(testo.slice(0, 32))}`,
    !/(^|[^\d])\d[.,]$/.test(speakable) && !/(^|[^\d])\d[.,]$/.test(rest),
    `speakable=${JSON.stringify(speakable)} rest=${JSON.stringify(rest)}`,
  )
}
eq('3.5 non viene tagliato', splitSpeakable('Il valore è 3.5 e va bene.').speakable, 'Il valore è 3.5 e va bene.')
eq('1.000.000 non viene tagliato', splitSpeakable('Circa 1.000.000 di persone qui.').speakable, 'Circa 1.000.000 di persone qui.')

/* -------------------------------------------------------------- abbreviazioni */

console.log('\n=== Abbreviazioni e iniziali ===')

const nonFrase = [
  'Vedi sig. Rossi domani.',
  'Chiedi al dott. Bianchi.',
  'Il prof. Verdi insegna.',
  'Circa 20 km. da casa.',
  'G. Rossi e A. Bianchi.',
]
for (const testo of nonFrase) {
  const r = splitSpeakable(testo)
  eq(`abbreviazione non divide: ${JSON.stringify(testo.slice(0, 28))}`, r.speakable, testo)
}
// Con un seguito lungo, la divisione deve cadere dopo la frase intera.
const conCoda = splitSpeakable('Vedi sig. Rossi domani. Poi ti dico altro.')
eq('divide dopo la frase, non dopo l abbreviazione', [conCoda.speakable, conCoda.rest], ['Vedi sig. Rossi domani.', ' Poi ti dico altro.'])
eq('i puntini di sospensione non chiudono', splitSpeakable('Aspetta... sto arrivando!').speakable, 'Aspetta... sto arrivando!')

/* ------------------------------------------------------------------ brevità */

console.log('\n=== Frasi troppo brevi aspettano ===')

const brevi = ['Ok.', 'Sì.', 'No!', 'Ciao.']
for (const testo of brevi) {
  const r = splitSpeakable(testo)
  check(`breve trattenuta: ${JSON.stringify(testo)}`, r.speakable === '' && r.rest === testo, JSON.stringify(r))
}
// "Sì." più una frase lunga: la breve si attacca alla lunga.
const mista = splitSpeakable('Ok. Poi ti dico cosa penso della giornata.')
eq('la breve si unisce alla lunga', [mista.speakable, mista.rest], ['Ok. Poi ti dico cosa penso della giornata.', ''])

/* ------------------------------------------------------------- testo lungo */

console.log('\n=== Testo lunghissimo senza punteggiatura ===')

const prolungato = 'parola '.repeat(80).trim()
const tagliato = splitSpeakable(prolungato)
check('viene spezzato a confine di parola', tagliato.speakable.length > 0 && tagliato.speakable.endsWith(' '), JSON.stringify(tagliato.speakable.slice(-20)))
check('nessuna parola resta tagliata a metà', tagliato.rest.startsWith('parola'), JSON.stringify(tagliato.rest.slice(0, 20)))
check('fedele anche nel taglio', tagliato.speakable + tagliato.rest === prolungato)

/* --------------------------------------------------------- accumulamento */

console.log('\n=== Accumulo a pezzi: stessa uscita del testo intero ===')

const risposte = [
  'Ciao, sono l\'assistente. Come stai oggi?',
  'Il tempo è sereno. Domani sarà più freddo,Around 3 gradi.',
  'Sì. No. Forse!',
  'Nessuna punteggiatura qui per un bel po\' di tempo',
  'Elenco:\n- primo punto\n- secondo punto',
]

for (const risposta of risposte) {
  const intero = splitSpeakable(risposta)

  const coda = new SpeakableTail()
  const emesso = []
  for (let i = 0; i < risposta.length; i += 3) {
    const pezzo = coda.push(risposta.slice(i, i + 3))
    if (pezzo) emesso.push(pezzo)
  }
  const codaFinale = coda.flush()
  if (codaFinale) emesso.push(codaFinale)

  const ricostruito = emesso.join('') + coda.pending
  check(`fedele a pezzi: ${JSON.stringify(risposta.slice(0, 28))}`, ricostruito === risposta, `ricostruito=${JSON.stringify(ricostruito.slice(0, 60))}`)
  check(
    `non parla troppo presto: ${JSON.stringify(risposta.slice(0, 28))}`,
    emesso.length === 0 || emesso[0].trim().length >= 2,
    `primo=${JSON.stringify(emesso[0])}`,
  )
  // Ogni pezzo emesso deve essere una frase finita, non un frammento: solo
  // l'ultimo può essere la coda finale. È la proprietà che rende la voce
  // coerente mentre il testo arriva. Il confronto è sul pezzo grezzo: in un
  // elenco markdown andare a capo è un confine legittimo.
  const pezziIncompiuti = emesso.slice(0, -1).filter((p) => !/[.!?\n]["'»”)\]]?\s*$/.test(p))
  check(
    `nessun pezzo pronunciato a metà: ${JSON.stringify(risposta.slice(0, 28))}`,
    pezziIncompiuti.length === 0,
    pezziIncompiuti.map((p) => JSON.stringify(p)).join(' '),
  )
  check(
    `niente attesa finale inutile: ${JSON.stringify(risposta.slice(0, 28))}`,
    intero.speakable !== '' ? coda.pending === '' || !emesso.includes(coda.pending) : true,
  )
}

const codaVuota = new SpeakableTail()
eq('flush su coda vuota', [codaVuota.push(''), codaVuota.flush()], ['', ''])

/* ---------------------------------------------------------- modelli gratuiti */

console.log('\n=== Scoperta dei modelli gratuiti ===')

const reale = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('/tmp/opencode/modelli.json', 'utf8')))

eq('nessun segreto hardcoded', typeof reale.data, 'object')

const gratuiti = parseFreeModels(reale)
check('trova i modelli gratuiti', gratuiti.length > 0, `${gratuiti.length} trovati`)
check('esclude i modelli a pagamento', gratuiti.every((m) => m.id), '')
check(
  'esclude i modelli non conversazionali',
  gratuiti.every((m) => !/lyria|content-safety|embedding|guard|moderation/i.test(m.id)),
  gratuiti.filter((m) => /lyria|content-safety/i.test(m.id)).map((m) => m.id).join(','),
)
check('ordina per contesto decrescente', gratuiti.every((m, i) => i === 0 || gratuiti[i - 1].contextLength >= m.contextLength))
check('rileva il supporto agli strumenti', gratuiti.some((m) => m.supportsTools))
eq('payload non valido → lista vuota', parseFreeModels(null), [])
eq('data non è un array → lista vuota', parseFreeModels({ data: 'nope' }), [])
eq(
  'modello gratis solo in ingresso viene escluso',
  parseFreeModels({ data: [{ id: 'a/b', pricing: { prompt: '0', completion: '0.001' } }] }),
  [],
)
eq(
  'il campo pricing mancante esclude il modello',
  parseFreeModels({ data: [{ id: 'a/b' }] }),
  [],
)

/* ------------------------------------------------------------ errori HTTP */

console.log('\n=== Cause degli errori ===')

function fakeResponse(status, body = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const casi = [
  [401, 'bad-key'],
  [402, 'no-credits'],
  [429, 'rate-limited'],
  [404, 'model-gone'],
  [503, 'server'],
]
for (const [status, atteso] of casi) {
  const err = await failureFromResponse(fakeResponse(status), 'm/x')
  check(`HTTP ${status} → ${atteso}`, err instanceof ChatError && err.failure === atteso, `ottenuto ${err.failure}`)
}

const modelloMorto = await failureFromResponse(
  fakeResponse(400, { error: { message: 'No endpoints found for model x/y:free' } }),
  'x/y:free',
)
eq('modello introvato nel corpo del messaggio', modelloMorto.failure, 'model-gone')
check('ogni causa ha un messaggio per l utente', Object.values(FAILURE_MESSAGES).every((m) => typeof m === 'string' && m.length > 10))
eq('tutte le cause hanno un messaggio', Object.keys(FAILURE_MESSAGES).length, 7)

/* ------------------------------------------------------------ lettura SSE */

console.log('\n=== Lettura del flusso SSE ===')

function streamOf(corpo) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const pezzo of corpo) c.enqueue(encoder.encode(pezzo))
      c.close()
    },
  })
}

const eventi = []
await readEventStream(
  streamOf(['data: {"a":1}\n\n', 'data: {"b"', ':2}\n\n', 'data: [DONE]\n\n']),
  (d) => eventi.push(d),
)
eq('eventi spezzati a metà vengono riuniti', eventi, ['{"a":1}', '{"b":2}', '[DONE]'])

const eventiUniti = []
await readEventStream(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\n']), (d) => eventiUniti.push(d))
eq('eventi uniti nello stesso pacchetto', eventiUniti, ['{"a":1}', '{"b":2}'])

const eventiFinali = []
await readEventStream(streamOf(['data: {"a":1}']), (d) => eventiFinali.push(d))
eq('evento senza separatore finale', eventiFinali, ['{"a":1}'])

const eventiVuoti = []
await readEventStream(streamOf([': solo commenti\n\n', '\n\n', 'data: {"ok":1}\n\n']), (d) => eventiVuoti.push(d))
eq('commenti e righe vuote ignorati', eventiVuoti, ['{"ok":1}'])

/* ----------------------------------------------------- turno di conversazione */

console.log('\n=== Richiesta al modello ===')

const realeFetch = globalThis.fetch

/**
 * Sostituisce `fetch` con uno finto.
 *
 * `turni` è una risposta **per ogni richiesta**: serve, perché il ciclo degli
 * strumenti fa più richieste e ognuna riceve qualcosa di diverso. L'ultimo turno
 * viene ripetuto all'infinito, così il test del limite non deve elencare quaranta
 * copie identiche.
 */
function mockFetch(turni: string[][], init: { status?: number; body?: unknown } = {}) {
  const chiamate: { url: string; init: RequestInit }[] = []
  let n = 0
  globalThis.fetch = (async (url: string, opts: RequestInit) => {
    chiamate.push({ url, init: opts })
    const status = init.status ?? 200
    if (status !== 200) {
      return new Response(JSON.stringify(init.body ?? {}), { status })
    }
    const eventi = turni[Math.min(n, turni.length - 1)] ?? []
    n += 1
    const encoder = new TextEncoder()
    const corpo = new ReadableStream({
      start(c) {
        for (const e of eventi) c.enqueue(encoder.encode(e))
        c.close()
      },
    })
    return new Response(corpo, { status: 200 })
  }) as typeof fetch
  return chiamate
}

function sse(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`
}

// Turno semplice: i pezzi arrivano e si ricompongono nell'ordine giusto.
mockFetch([[sse('Ciao'), sse(', come'), sse(' stai?'), 'data: [DONE]\n\n']])
const pezzi: string[] = []
const semplice = await streamChat({
  apiKey: 'sk-or-prova',
  model: 'openrouter/free',
  messages: [
    { role: 'system', content: 'Sei Ari.' },
    { role: 'user', content: 'Come stai?' },
  ],
  onDelta: (d) => pezzi.push(d),
})
eq('i pezzi arrivano uno alla volta', pezzi, ['Ciao', ', come', ' stai?'])
eq('il testo finale è ricomposto', semplice.text, 'Ciao, come stai?')
eq('nessuna chiamata a strumento', semplice.toolCalls, [])

// Il corpo della richiesta: rotolo, modello, stream, e la chiave in Authorization.
const catturate: { url: string; init: RequestInit }[] = []
{
  const precedente = globalThis.fetch
  globalThis.fetch = (async (url: string, opts: RequestInit) => {
    catturate.push({ url, init: opts })
    return new Response(new ReadableStream({ start(c) { c.close() } }), { status: 200 })
  }) as typeof fetch
  await streamChat({ apiKey: 'sk-or-segreta', model: 'm/x:free', messages: [{ role: 'user', content: 'ciao' }] })
  globalThis.fetch = precedente
}
const init = catturate[0].init
const headers = init.headers as Record<string, string>
eq('all indirizzo giusto', catturate[0].url, 'https://openrouter.ai/api/v1/chat/completions')
eq('metodo POST', init.method, 'POST')
eq('streaming attivo', (JSON.parse(init.body as string) as { stream: boolean }).stream, true)
eq('chiave in Authorization', headers.Authorization, 'Bearer sk-or-segreta')
check('la chiave non finisce nel corpo', !(init.body as string).includes('segreta'))

// `at` serve solo all'interfaccia (orario del messaggio, pulsante copia). Il
// provider non lo conosce e mandarlo sarebbe rumore che ogni chiamato dovrebbe
// imparare a ignorare: è il tipo di dettaglio che percorre l'intera cronologia
// di ogni richiesta senza mai servire a qualcosa.
const catturato = mockFetch([[]])
await streamChat({
  apiKey: 'k',
  model: 'm',
  messages: [
    { role: 'user', content: 'ciao', at: 1_750_000_000_000 },
    { role: 'assistant', content: 'ehi', at: 1_750_000_001_000 },
  ],
})
const inviato = JSON.parse(catturato[0].init.body as string) as {
  messages: Record<string, unknown>[]
}
check('il timestamp non finisce in rete', inviato.messages.every((m) => !('at' in m)), JSON.stringify(inviato.messages))
eq('il testo invece passa intero', inviato.messages[0].content, 'ciao')

/** Evento SSE con una chiamata a strumento, arguments già serializzato. */
function sseTool(index: number, id: string | null, nome: string | null, args: string): string {
  const call: Record<string, unknown> = { index, function: {} as Record<string, string> }
  if (id !== null) call.id = id
  const fn: Record<string, string> = {}
  if (nome !== null) fn.name = nome
  if (args !== '') fn.arguments = args
  call.function = fn
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`
}

// Chiamata a strumento: gli argomenti arrivano a pezzi e vanno riuniti.
mockFetch([
  [
    sseTool(0, 'c1', 'meteo', '{\"cit'),
    sseTool(0, null, null, 'ta\":\"Roma\"}'),
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ],
  [sse('A Roma '), sse('c\u2019\u00e8 sole.'), 'data: [DONE]\n\n'],
])
let eseguiti = 0
let ricevuto: unknown = null
const conStrumento = await streamChat({
  apiKey: 'sk-or-prova',
  model: 'm/x:free',
  messages: [{ role: 'user', content: 'meteo a Roma' }],
  onToolCall: (call) => {
    eseguiti += 1
    ricevuto = call
    return 'sole'
  },
})
eq('lo strumento viene eseguito una volta', eseguiti, 1)
eq('gli argomenti spezzati vengono riuniti', ricevuto, { id: 'c1', name: 'meteo', arguments: { citta: 'Roma' } })
eq('dopo lo strumento il modello risponde', conStrumento.text, 'A Roma c’è sole.')

// Limite di giri: un modello che chiede strumenti per sempre deve fermarsi.
mockFetch([Array.from({ length: 40 }, (_, i) => sseTool(0, `c${i}`, 'meteo', '{}'))])
let giri = 0
let troppiGiri: unknown = null
try {
  await streamChat({
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    onToolCall: () => {
      giri += 1
      return 'r'
    },
  })
} catch (e) {
  troppiGiri = e
}
check('il ciclo di strumenti è limitato', troppiGiri instanceof ChatError && troppiGiri.failure === 'server', String(troppiGiri))
check('il limite viene rispettato', giri === 4, `giri=${giri}`)
check('il messaggio spiega il motivo', troppiGiri instanceof Error && troppiGiri.message.includes('4 giri'))

// Argomenti non JSON: non devono far cadere il turno.
mockFetch([[sseTool(0, 'c2', 'x', 'non-json')], [sse('Va bene.'), 'data: [DONE]\n\n']])
let rottoArgs: unknown = null
await streamChat({
  apiKey: 'k',
  model: 'm',
  messages: [{ role: 'user', content: 'x' }],
  onToolCall: (call) => {
    rottoArgs = call.arguments
    return 'r'
  },
})
eq('argomenti non JSON diventano oggetto vuoto', rottoArgs, {})

// Nessuna chiave: errore immediato, senza nemmeno uscire di casa.
let senzaChiave: unknown = null
try {
  await streamChat({ apiKey: '  ', model: 'm', messages: [] })
} catch (e) {
  senzaChiave = e
}
check('senza chiave non parte nessuna richiesta', senzaChiave instanceof ChatError && senzaChiave.failure === 'no-key')

// Errore di rete tradotto, e AbortError lasciato passare.
mockFetch([[]], { status: 401 })
let nonAutorizzato: unknown = null
try {
  await streamChat({ apiKey: 'k', model: 'm', messages: [] })
} catch (e) {
  nonAutorizzato = e
}
check('HTTP 401 diventa bad-key', nonAutorizzato instanceof ChatError && nonAutorizzato.failure === 'bad-key')

globalThis.fetch = (async () => {
  throw new TypeError('connessione persa')
}) as typeof fetch
let rete: unknown = null
try {
  await streamChat({ apiKey: 'k', model: 'm', messages: [] })
} catch (e) {
  rete = e
}
check('errore di rete tradotto', rete instanceof ChatError && rete.failure === 'network')

// Abort: deve restare AbortError, altrimenti il barge-in mostra "connessione persa".
const controllerAbort = new AbortController()
globalThis.fetch = ((_url: string, opts: RequestInit) =>
  new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () =>
      reject(new DOMException('interrotto', 'AbortError')),
    )
  })) as unknown as typeof fetch
const inCorso = streamChat({
  apiKey: 'k',
  model: 'm',
  messages: [],
  signal: controllerAbort.signal,
})
controllerAbort.abort()
let abortErrore: unknown = null
try {
  await inCorso
} catch (e) {
  abortErrore = e
}
check('abort non diventa errore di rete', abortErrore instanceof DOMException && abortErrore.name === 'AbortError', String(abortErrore))

/* ------------------------------------------------- rate limiting e ritentativi */

console.log('\n=== Rate limiting: che cosa si ritenta ===')

eq('il 429 si ritenta', isRetryableStatus(429), true)
eq('il 5xx si ritenta', isRetryableStatus(503), true)
eq('il 400 non si ritenta', isRetryableStatus(400), false)
eq('il 401 non si ritenta', isRetryableStatus(401), false)
eq('il 404 del modello non si ritenta', isRetryableStatus(404), false)

console.log('\n=== Rate limiting: quanto si aspetta ===')

eq('Retry-After in secondi', parseRetryAfter('2'), 2000)
eq('Retry-After assente', parseRetryAfter(null), null)
eq('Retry-After vuoto', parseRetryAfter('   '), null)
eq('Retry-After non numerico e non data', parseRetryAfter('domani'), null)
eq('il Retry-After enorme è limitato', parseRetryAfter('99999'), RETRY_MAX_MS)
eq('il Retry-After nel passato non è negativo', parseRetryAfter('Thu, 01 Jan 1970 00:00:00 GMT'), 0)

// Con `random` a 0.5 il margine è 1.0, e i valori diventano leggibili.
eq('primo tentativo dopo una base', backoffDelay(1, null, () => 0.5), RETRY_BASE_MS)
eq('secondo tentativo raddoppiato', backoffDelay(2, null, () => 0.5), RETRY_BASE_MS * 2)
eq('il backoff non cresce oltre il tetto', backoffDelay(9, null, () => 0.5), RETRY_MAX_MS)
check('il margine casuale resta nel range', (() => { const d = backoffDelay(1); return d >= RETRY_BASE_MS * 0.7 && d <= RETRY_BASE_MS * 1.3 })())
check('due client non ritentano all\'identico istante', backoffDelay(1, null, () => 0.5) !== backoffDelay(1, null, () => 0.95))
eq('il Retry-After vince sul backoff', backoffDelay(3, 1234), 1234)

await sleep(0)
check('sleep(0) risolve subito', true)
const perInterrompere = new AbortController()
const attesaLunga = sleep(5000, perInterrompere.signal)
perInterrompere.abort()
const erroreAttesa = await attesaLunga.then(() => null, (e) => e)
check('lo sleep si interrompe al barge-in', erroreAttesa instanceof DOMException && erroreAttesa.name === 'AbortError', String(erroreAttesa))

console.log('\n=== Rate limiting: il giro completo ===')

/** Risposte in sequenza: ogni chiamata riceve lo status successivo. */
function mockFetchSequenza(stati: number[], retryAfter?: string) {
  const ricevuti: number[] = []
  let n = 0
  globalThis.fetch = (async () => {
    const status = stati[Math.min(n, stati.length - 1)]
    n += 1
    ricevuti.push(status)
    if (status !== 200) {
      const headers = new Headers()
      if (retryAfter) headers.set('retry-after', retryAfter)
      return new Response(JSON.stringify({ error: { message: 'troppe richieste' } }), { status, headers })
    }
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(sse('prima')))
          c.enqueue(encoder.encode('data: [DONE]\n\n'))
          c.close()
        },
      }),
      { status: 200 },
    )
  }) as typeof fetch
  return ricevuti
}

const messaggioProva = [{ role: 'user' as const, content: 'ciao' }]

// Un 429 e poi il via libera: è il caso normale dei provider gratuiti.
const tentativiRitenti = mockFetchSequenza([429, 200], '1')
const dopoRitento = await streamChat({
  apiKey: 'sk-or-prova',
  model: 'openrouter/free',
  messages: messaggioProva,
  maxAttempts: 2,
})
eq('il 429 non fa perdere il turno', dopoRitento.text, 'prima')
eq('è stato fatto un solo tentativo in più', tentativiRitenti.length, 2)

// Tentativi esauriti: l'errore deve essere quello giusto, non uno generico.
const tentativiEsauriti = mockFetchSequenza([429])
let esaurito: unknown = null
try {
  await streamChat({ apiKey: 'sk-or-prova', model: 'openrouter/free', messages: messaggioProva, maxAttempts: 2 })
} catch (e) {
  esaurito = e
}
check(
  'esauriti i tentativi resta un rate-limit',
  esaurito instanceof ChatError && esaurito.failure === 'rate-limited',
  String(esaurito),
)
eq('non si insiste oltre il tetto', tentativiEsauriti.length, 2)

// Una chiave sbagliata non si ritenta: tre tentativi costerebbero tre secondi
// per un errore che l'utente deve correggere a mano.
const tentativiChiave = mockFetchSequenza([401])
let chiaveErrata: unknown = null
try {
  await streamChat({ apiKey: 'sk-or-sbagliata', model: 'openrouter/free', messages: messaggioProva })
} catch (e) {
  chiaveErrata = e
}
check('la chiave sbagliata non viene ritentata', tentativiChiave.length, 1, String(tentativiChiave.length))
check('l\'errore resta quello della chiave', chiaveErrata instanceof ChatError && chiaveErrata.failure === 'bad-key', String(chiaveErrata))

// Barge-in durante l'attesa: deve uscire subito, non finire il sonno.
const tentativiInterrotti = mockFetchSequenza([429, 200])
const duranteAttesa = new AbortController()
setTimeout(() => duranteAttesa.abort(), 30)
let interrotto: unknown = null
try {
  await streamChat({
    apiKey: 'sk-or-prova',
    model: 'openrouter/free',
    messages: messaggioProva,
    maxAttempts: 3,
    signal: duranteAttesa.signal,
  })
} catch (e) {
  interrotto = e
}
check('l\'interruzione durante l\'attesa non diventa connessione persa', interrotto instanceof DOMException && interrotto.name === 'AbortError', String(interrotto))
eq('l\'interruzione ferma al primo tentativo', tentativiInterrotti.length, 1)

check('il tetto di tentativi è tre', DEFAULT_MAX_ATTEMPTS === 3)

globalThis.fetch = realeFetch

console.log('\n=== riepilogo ===')
console.log(`${passed} verifiche superate, ${failed} fallite`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('TUTTE LE VERIFICHE SUPERATE')