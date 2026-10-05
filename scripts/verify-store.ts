/**
 * Verifica dello store e della persistenza (Fase 7).
 *
 * Qui c'è un test che nasce da un bug vero: `readJson` avvolgeva il parser in un
 * `try` che ingoiava anche i difetti del codice. Una costante usata prima della
 * sua dichiarazione faceva lanciare una `ReferenceError`, il fallback prendeva
 * il sopravvento, e l'applicazione ripartiva con la cronologia vuota **senza un
 * solo errore in console**. È il peggior tipo di guasto: silenzioso e
 * riproducibile solo ricaricando la pagina.
 */

import { readJson, writeJson, clamp, debounce } from '/src/store/persistence.ts'

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

/* ------------------------------------------------------------- finto store */

let memoria = new Map<string, string>()

/**
 * `window` finto.
 *
 * Espone anche i timer: `debounce` chiama `window.setTimeout`, e un finto senza
 * timer farebbe fallire il test del debounce per un motivo che non c'entra,
 * coprendo il difetto che si voleva guardare.
 */
function fintoWindow(storage: {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
}): object {
  return {
    localStorage: storage,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  }
}

function installa(value: object): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value })
}

installa(
  fintoWindow({
    getItem: (k) => memoria.get(k) ?? null,
    setItem: (k, v) => void memoria.set(k, v),
  }),
)

/* ------------------------------------------- il parser non viene più nascosto */

console.log('\n=== Un difetto del codice non si nasconde dietro il ripiego ===')

memoria.clear()
writeJson('prova', { a: 1 })
eq('scrive e rilegge', readJson('prova', (r) => r as { a: number } | null, null), { a: 1 })

// Questo è il test che il bug avrebbe dovuto far fallire.
let eccezioneDelParser: unknown = null
try {
  readJson('prova', () => {
    throw new ReferenceError('MAX_SAVED_MESSAGES is not defined')
  }, 'fallback')
} catch (e) {
  eccezioneDelParser = e
}
check(
  'un errore del parser emerge invece di diventare fallback',
  eccezioneDelParser instanceof ReferenceError,
  String(eccezioneDelParser),
)

// Il caso analogo che invece DEVE tornare al ripiego: dato corrotto.
memoria.set('rotto', '{ non è json')
eq('JSON non valido → ripiego', readJson('rotto', (r) => r as never, 'ripiego'), 'ripiego')

memoria.set('nonObjectio', '"una stringa"')
eq('tipo inatteso gestito dal parser', readJson('nonObjectio', (r) => (typeof r === 'object' ? (r as object) : null), 'ripiego'), 'ripiego')

eq('chiave assente → ripiego', readJson('inesistente', () => 'mai', 'ripiego'), 'ripiego')
eq('parser che restituisce null → ripiego', readJson('prova', () => null, 'ripiego'), 'ripiego')

// Storage negato: il caso legittimo in cui il fallback serve davvero.
const windowNegato = fintoWindow({
  getItem() { throw new Error('SecurityError') },
  setItem() { throw new Error('SecurityError') },
}) as { localStorage: Record<string, unknown> }
Object.defineProperty(globalThis, 'window', { configurable: true, value: windowNegato })
eq('storage negato in lettura → ripiego', readJson('prova', () => 'mai', 'ripiego'), 'ripiego')
let scritturaNegata = false
try {
  writeJson('prova', { a: 1 })
} catch {
  scritturaNegata = true
}
check('storage negato in scrittura → eccezione contenuta', !scritturaNegata)

// Si rimette uno `window` funzionante: i test del debounce vengono dopo.
installa(
  fintoWindow({
    getItem: (k) => memoria.get(k) ?? null,
    setItem: (k, v) => void memoria.set(k, v),
  }),
)

/* --------------------------------------------------------------- debounce */

console.log('\n=== Il debounce scrive una volta sola ===')

memoria.clear()
const conta = { n: 0 }
const salva = debounce(() => {
  conta.n += 1
}, 100)
salva()
salva()
salva()
eq('prima che scada il tempo non scrive', conta.n, 0)
await new Promise((r) => setTimeout(r, 180))
eq('dopo scrive una volta sola', conta.n, 1)

/* ------------------------------------------------------------------ clamp */

console.log('\n=== clamp ===')

eq('valore dentro', clamp(5, 0, 10), 5)
eq('sotto il minimo', clamp(-3, 0, 10), 0)
eq('sopra il massimo', clamp(99, 0, 10), 10)
eq('minimo esatto', clamp(0, 0, 10), 0)
eq('massimo esatto', clamp(10, 0, 10), 10)

console.log('\n=== riepilogo ===')
console.log(`${passed} verifiche superate, ${failed} fallite`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('TUTTE LE VERIFICHE SUPERATE')
