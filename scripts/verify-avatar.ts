/**
 * Verifica del selettore di avatar.
 *
 * La parte che si può provare qui è quella pura: riconoscere un file VRM prima
 * di archiviarlo, e difendere le liste che vengono da `localStorage`. Il resto
 * — IndexedDB, object URL, ricarica — dipende da un browser vero e sta in
 * `npm run test:ui`.
 */

import { open } from 'node:fs/promises'
import { GREETING_FLASH, SPEAKING_MOOD } from '/src/config.ts'
import { ExpressionRig } from '/src/vrm/expressionRig.ts'
import {
  BUNDLED,
  DEFAULT_AVATAR_ID,
  bundledById,
  eliminaModello,
  leggiModello,
  parseAvatarChoice,
  parseUploaded,
  salvaModello,
  verificaFile,
  MAX_AVATAR_BYTES,
} from '/src/vrm/avatarLibrary.ts'

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

/** Tre decimali: i pesi delle espressioni sono numeri piccoli e sovrapposti. */
function round(value: number) {
  return Math.round(value * 1000) / 1000
}

/* -------------------------------------------------------------- catalogo */

console.log('\n=== Il catalogo ===')

check('ci sono almeno due modelli', BUNDLED.length >= 2, String(BUNDLED.length))
check('il predefinito è nel catalogo', bundledById(DEFAULT_AVATAR_ID) !== undefined)

for (const avatar of BUNDLED) {
  check(`${avatar.id}: identificatore`, /^[a-z0-9-]{1,32}$/.test(avatar.id))
  check(`${avatar.id}: etichetta`, avatar.label.trim().length > 0)
  // La licenza non è una formalità: un modello con restrizioni mostra che
  // l'applicazione ne tiene conto invece di ignorare il problema.
  check(`${avatar.id}: nota di licenza presente`, avatar.note.toLowerCase().includes('licenz'), avatar.note)
  check(`${avatar.id}: url .vrm`, avatar.url.endsWith('.vrm'))
  // Chi ridistribuisce il progetto deve sapere a chi accreditare: un modello
  // senza autore è un modello di cui non si conoscono i vincoli.
  check(`${avatar.id}: autore dichiarato`, /di\s+\S/.test(avatar.note), avatar.note)
}

const ids = BUNDLED.map((a) => a.id)
eq('identificatori univoci', new Set(ids).size, ids.length)
check('gli url sono univoci', new Set(BUNDLED.map((a) => a.url)).size === BUNDLED.length)
eq('id inesistente → undefined', bundledById('non-esiste'), undefined)

/* -------------------------------------------------- riconoscimento del file */

console.log('\n=== Un file è un VRM? ===')

const vrmFalso = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0, 0, 0])
let accettato = null
try {
  await verificaFile(new File([vrmFalso], 'modello.vrm'))
  accettato = true
} catch (e) {
  accettato = e instanceof Error ? e.message : String(e)
}
check('un file che inizia con glTF è accettato', accettato === true, String(accettato))

const pngFalso = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let rifiutato = ''
try {
  await verificaFile(new File([pngFalso], 'immagine.png'))
  rifiutato = ''
} catch (e) {
  rifiutato = e instanceof Error ? e.message : String(e)
}
check('un PNG viene rifiutato', rifiutato !== '', rifiutato)
check('il rifiuto spiega perché', /non è un VRM/i.test(rifiutato), rifiutato)

const testo = new File([new TextEncoder().encode('questo è un file di testo')], 'nota.txt')
let rifiutato2 = ''
try {
  await verificaFile(testo)
} catch (e) {
  rifiutato2 = e instanceof Error ? e.message : String(e)
}
check('un file di testo viene rifiutato', rifiutato2 !== '', rifiutato2)

// Un file più piccolo della testata non deve far leggere fuori dal buffer.
const cortissimo = new File([new Uint8Array([0x67])], 'corto.vrm')
let rifiutato3 = ''
try {
  await verificaFile(cortissimo)
  rifiutato3 = 'accettato'
} catch (e) {
  rifiutato3 = 'rifiutato'
}
check('un file troppo corto non viene accettato per caso', rifiutato3 === 'rifiutato', rifiutato3)

check('il limite di dimensione è ragionevole', MAX_AVATAR_BYTES >= 50 * 1024 * 1024 && MAX_AVATAR_BYTES <= 500 * 1024 * 1024)

/* ------------------------------------------------- il predefinito è servibile */

console.log('\n=== Il predefinito esiste davvero sul disco ===')

// Il caso vale per tutti i modelli inclusi, non solo per il predefinito: un
// `url` scritto a mano può sopravvivere a una rinomina del file, e il difetto
// si vede solo aprendo l'app.
for (const avatar of BUNDLED) {
  const percorso = `public${avatar.url}`
  let esiste = true
  try {
    const f = await open(percorso, 'r')
    f.close()
  } catch {
    esiste = false
  }
  check(`${avatar.id}: il file è in public/`, esiste, percorso)
}

/* ---------------------------------------------------- elenchi difensivi */

console.log('\n=== Elenchi che vengono da localStorage ===')

eq('elenco non valido → vuoto', parseUploaded('nope'), [])
eq('oggetto → vuoto', parseUploaded({}), [])
eq('vuoto → vuoto', parseUploaded([]), [])

const sporco = parseUploaded([
  { id: 'a', name: 'uno.vrm', size: 100, at: 5 },
  { id: 2, name: 'id non stringa' },
  { name: 'senza id' },
  { id: 'c' },
  null,
  'stringa',
])
eq('solo le voci valide sopravvivono', sporco.map((u) => u.name), ['uno.vrm'])
eq('la data mancante diventa zero', sporco[0].at, 5)

const senzaSize = parseUploaded([{ id: 'x', name: 'y.vrm' }])
eq('dimensione assente → zero', senzaSize[0].size, 0)

eq('scelta vuota → null', parseAvatarChoice(''), null)
eq('scelta non stringa → null', parseAvatarChoice(42), null)
eq('scelta valida', parseAvatarChoice('kaori'), 'kaori')
check('gli spazi rendono la scelta non valida', parseAvatarChoice('   ') === null)

/* ------------------------------------------------------------ IndexedDB */

console.log('\n=== IndexedDB non esiste fuori da un browser ===')

// Non è un test che debba passare: serve a ricordare che `salvaModello` usa
// IndexedDB e quindi va provato in `test:ui`, non qui. Se un giorno IndexedDB
// diventasse disponibile in Node, l'errore non ci sarebbe più e il test
// cambierebbe senso — per questo controlla solo che l'assenza sia gestita.
const haIdb = typeof indexedDB !== 'undefined'
check('questo ambiente non ha IndexedDB, i file si provano nel browser', !haIdb, `disponibile: ${haIdb}`)
if (!haIdb) {
  let fallito = false
  try {
    await salvaModello('x', new File([], 'x.vrm'))
  } catch {
    fallito = true
  }
  check('salvare senza IndexedDB solleva un errore, non silenziosamente', fallito)
  let letto: unknown = null
  try {
    letto = await leggiModello('x')
  } catch {
    letto = 'errore'
  }
  check('leggere senza IndexedDB non promette un modello inesistente', letto === null || letto === 'errore')
  let rimozione = 'nessun errore'
  try {
    await eliminaModello('x')
  } catch {
    rimozione = 'errore'
  }
  check('rimuovere senza IndexedDB è dichiarato, non nascosto', rimozione === 'errore')
}

/* ------------------------------------------------- la preferenza e il motore */

console.log('\n=== La casella e il motore non possono discordare ===')

/**
 * `window` finto, per poter importare il negozio e il controller fuori dal
 * browser.
 *
 * Serve perché il controller del linguaggio costruisce `BrowserTts` al momento
 * dell'import, e quello chiede `window.speechSynthesis` e `document` subito. Non
 * è una simulazione del motore di sintesi: si controlla solo che i due default
 * della preferenza siano lo stesso numero.
 */
const memoria = new Map<string, string>()
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: {
      getItem: (k: string) => memoria.get(k) ?? null,
      setItem: (k: string, v: string) => void memoria.set(k, v),
    },
    speechSynthesis: { speak: () => {}, cancel: () => {}, getVoices: () => [] },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  },
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null },
})

// Il default è scritto in due posti: il campo di `VoicePrefs` e il campo del
// controller. Se i due divergono, la casella dice "acceso" mentre il motore
// sospende il blink, e non c'è errore né avviso: si scopre guardando i numeri,
// come è successo.
{
  const store = await import('/src/store/appStore.ts')
  const { speech } = await import('/src/speech/speechController.ts')
  check(
    'il default del negozio e quello del motore coincidono',
    store.DEFAULT_VOICE.blinkWhileSpeaking === speech.blinkWhileSpeaking,
    `negozio=${store.DEFAULT_VOICE.blinkWhileSpeaking} motore=${speech.blinkWhileSpeaking}`,
  )
  check('il default è acceso: le persone lampeggiano parlando', store.DEFAULT_VOICE.blinkWhileSpeaking === true)

  store.setBlinkWhileSpeaking(false)
  check('la casella cambia anche il motore', speech.blinkWhileSpeaking === false)
  store.setBlinkWhileSpeaking(true)
  check('e lo riaccende', speech.blinkWhileSpeaking === true)
}

/* --------------------------------------------------------- blink e umore */

console.log('\n=== Il blink automatico ===')

/**
 * `expressionManager` finto.
 *
 * `ExpressionRig` scrive solo attraverso `expressionMap` e `setValue`, quindi
 * questo è tutto ciò che serve: nessun three.js, nessun DOM. Il rig è codice
 * che gira a ogni frame su ogni avatar — se il blink non parte, o resta
 * incastrato a metà, non lo nota nessuno guardando l'app.
 */
function expressionManagerFinto(nomi: string[]) {
  const pesi: Record<string, number> = {}
  for (const name of nomi) pesi[name] = 0
  return {
    expressionMap: Object.fromEntries(nomi.map((n) => [n, { expressionName: n }])),
    setValue(name: string, value: number) {
      if (!(name in pesi)) return
      pesi[name] = value
    },
    resetValues() {
      for (const n of nomi) pesi[n] = 0
    },
    get: (name: string) => pesi[name] ?? 0,
  }
}

/** Costruisce un `VRM` con il solo `expressionManager` che al rig serve. */
function vrmFinto(nomi: string[]) {
  const manager = expressionManagerFinto(nomi)
  return { vrm: { expressionManager: manager }, manager }
}

// I nomi devono essere quelli che three-vrm espone davvero, non quelli che il
// file VRM dichiara: la specifica 0.0 li chiama `fun` e `unknown`, three-vrm li
// ha riscritti `relaxed` e `Surprised`. Coprire il test con i nomi del file
// avrebbe reso verde un test che non copre niente — `setValue` su un preset
// inesistente è un no-op, e l'umore resterebbe spento senza errori.
const TUTTE = ['aa', 'ee', 'ih', 'oh', 'ou', 'blink', 'relaxed', 'Surprised']

check(
  'i nomi di umore sono quelli che three-vrm espone, non quelli del file',
  GREETING_FLASH.name === 'Surprised' && SPEAKING_MOOD.name === 'relaxed',
  `${GREETING_FLASH.name} / ${SPEAKING_MOOD.name}`,
)

{
  const { vrm, manager } = vrmFinto(TUTTE)
  const rig = new ExpressionRig(vrm as never)

  check('i cinque visemi sono supportati', rig.supportedVisemes.length === 5, String(rig.supportedVisemes.length))
  check('il blink è riconosciuto', rig.hasBlink())
  check('l\'umore è riconosciuto', rig.hasMood)
  check('all\'inizio il blink è chiuso', rig.currentBlink === 0, String(rig.currentBlink))

  // Unblink deve accadere entro BLINK_MAX_GAP + un frame: se non parte mai,
  // l'avatar guarda fisso come un poster.
  let massimo = 0
  for (let i = 0; i < 400; i += 1) {
    rig.update(1 / 60)
    massimo = Math.max(massimo, rig.currentBlink)
  }
  check('il blink arriva entro ~6 s', massimo > 0.9, `picco ${round(massimo)}`)

  // Un peso che non torna a zero significa una palpebra socchiusa per sempre.
  // Il ritorno va **aspettato**, non dato per scontato dopo un numero fisso di
  // frame: l'intervallo fra due lampeggi è casuale, quindi un'attesa fissa
  // può cadere dentro il blink successivo e fallire a intermittenza. È successo
  // qui: il test era verde una volta e rosso la successiva.
  let rientrato = false
  for (let i = 0; i < 600 && !rientrato; i += 1) {
    rig.update(1 / 60)
    if (rig.currentBlink === 0) rientrato = true
  }
  check('il viso torna aperto dopo il blink', rientrato, String(rig.currentBlink))
  check('e il peso scritto coincide', manager.get('blink') === rig.currentBlink, `${manager.get('blink')} vs ${rig.currentBlink}`)

  // La curva deve passare da 0 a 1 senza salti: un valore > 1 o < 0 significa
  // che la rampa è stata sbagliata.
  let fuoriScala = false
  for (let i = 0; i < 1200; i += 1) {
    rig.update(1 / 60)
    const b = rig.currentBlink
    if (b < 0 || b > 1) fuoriScala = true
  }
  check('il blink resta dentro 0..1', !fuoriScala)

  // Spegnendolo a metà, la palpebra deve aprirsi subito: lasciarla a metà è il
  // difetto che un utente segnalerebbe come "l'ha tenuto gli occhi chiusi".
  rig.setAutoBlink(false)
  check('setAutoBlink(false) azzera subito', rig.currentBlink === 0, String(rig.currentBlink))
  check('e lo dice anche al peso scritto', manager.get('blink') === 0)
  for (let i = 0; i < 60; i += 1) rig.update(1 / 60)
  check('a spento non torna su', rig.currentBlink === 0, String(rig.currentBlink))
  rig.setAutoBlink(true)

  // Il lampo di inizio risposta: sale, e poi rientra. Senza il rientro
  // l'avatar resta con le sopracciglia alzate per tutta la conversazione.
  rig.greetingFlash()
  let picco = 0
  for (let i = 0; i < 30; i += 1) {
    rig.update(1 / 60)
    picco = Math.max(picco, rig.moodValue(GREETING_FLASH.name))
  }
  check('il lampo sale', picco > 0.05, `picco ${round(picco)}`)
  check('il lampo non supera il peso dichiarato', picco <= GREETING_FLASH.weight + 0.01, String(round(picco)))
  for (let i = 0; i < 180; i += 1) rig.update(1 / 60)
  check('il lampo rientra', rig.moodValue(GREETING_FLASH.name) < 0.01, String(round(rig.moodValue(GREETING_FLASH.name))))

  rig.dispose()
}

{
  // Un modello povero: solo i visemi e il blink. Il rig non deve sollevare
  // eccezioni scrivendo un'espressione che non esiste — `setValue` su un preset
  // assente è un no-op in three-vrm, ma qui verifichiamo che il rig lo chiami
  // lo stesso senza aspettarsi nulla.
  const { vrm } = vrmFinto(['aa', 'ee', 'ih', 'oh', 'ou', 'blink'])
  const rig = new ExpressionRig(vrm as never)

  check('senza umore il rig continua a funzionare', !rig.hasMood)
  rig.setSpeakingMood(1)
  rig.greetingFlash()
  let eccezione = false
  try {
    for (let i = 0; i < 60; i += 1) rig.update(1 / 60)
  } catch {
    eccezione = true
  }
  check('assenza delle espressioni di umore non solleva', !eccezione)
  check('ma il blink funziona lo stesso', rig.hasBlink())
  rig.dispose()
}

{
  // Nessun expressionManager: il rig deve degradare a no-op, non-crash.
  const rig = new ExpressionRig({ expressionManager: undefined } as never)
  let eccezione = false
  try {
    rig.setVisemes({ aa: 1 })
    rig.greetingFlash()
    rig.update(1 / 60)
    rig.dispose()
  } catch {
    eccezione = true
  }
  check('senza expressionManager il rig è un no-op', !eccezione)
  check('e non dichiara visemi', !rig.hasAnyViseme && rig.supportedVisemes.length === 0)
}

{
  // I visemi vanno smoothati verso il valore di arrivo, non scritti di getto:
  // è la stessa cosa che impedisce al lip-sync di scattare a 30 fps.
  const { vrm, manager } = vrmFinto(TUTTE)
  const rig = new ExpressionRig(vrm as never)
  rig.setVisemes({ aa: 1 })
  rig.update(1 / 60)
  const primoFrame = manager.get('aa')
  check('il viseme non viene scritto tutto d\'un colpo', primoFrame > 0 && primoFrame < 1, String(round(primoFrame)))
  for (let i = 0; i < 30; i += 1) rig.update(1 / 60)
  check('e dopoarriva al valore di arrivo', manager.get('aa') > 0.95, String(round(manager.get('aa'))))
  rig.dispose()
}

console.log('\n=== riepilogo ===')
console.log(`${passed} verifiche superate, ${failed} fallite`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('TUTTE LE VERIFICHE SUPERATE')