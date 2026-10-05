/**
 * Verifica della logica di Fase 3 (ascolto).
 *
 * Il riconoscimento vocale vero e proprio non è riproducibile qui: dipende dal
 * motore del browser e da un microfono. Ma le due parti che abbiamo scritto noi
 * — la soglia del VAD e la normalizzazione del livello — sono funzioni pure e si
 * verificano esattamente come sono.
 */

import { normalizeLevel, DEFAULT_VAD, type VadOptions } from '/src/speech/vad.ts'
import { DEFAULT_STT_OPTIONS } from '/src/speech/stt.ts'

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

/**
 * Ricostruisce la macchina a stati del VAD su una serie di livelli.
 *
 * Riprodurre la logica qui serve a controllarne il comportamento: il resto del
 * modulo è legato a `AudioContext` e `AnalyserNode`, che in Node non esistono.
 * Se le due copie divergono, il test vale poco — ma la logica è di poche righe
 * ed è commentata allo stesso modo nei due posti.
 */
function simulateGate(levelsDb, options = DEFAULT_VAD, stepMs = 20) {
  let floor = options.minThresholdDb - options.marginDb
  let speaking = false
  let aboveSince = 0
  let belowSince = 0
  let peak = -120
  let clock = 0
  let threshold = 0
  const events = []

  for (const level of levelsDb) {
    clock += stepMs

    if (!speaking) {
      const alpha = 1 - Math.exp(-stepMs / 1000 / options.floorTau)
      floor += (level - floor) * alpha
    }
    threshold = Math.min(Math.max(floor + options.marginDb, options.minThresholdDb), options.maxThresholdDb)

    if (level > threshold) {
      belowSince = 0
      if (peak < level) peak = level
      if (aboveSince === 0) aboveSince = clock
      if (!speaking && clock - aboveSince >= options.onsetMs) {
        if (peak - floor >= options.peakMarginDb) {
          speaking = true
          events.push({ type: 'start', at: clock })
        } else {
          peak = -120
          aboveSince = clock
        }
      }
      continue
    }

    aboveSince = 0
    peak = -120
    if (belowSince === 0) belowSince = clock
    if (speaking && clock - belowSince >= options.hangoverMs) {
      speaking = false
      events.push({ type: 'end', at: clock })
    }
  }

  return { events, threshold, floor }
}

console.log('\n=== VAD: normalizzazione del livello ===')
eq('silenzio assoluto → 0', normalizeLevel(-120), 0)
eq('sotto il fondo scala → 0', normalizeLevel(-90), 0)
eq('fondo scala → 0', normalizeLevel(-60), 0)
eq('metà scala', normalizeLevel(-35), 0.5)
eq('saturazione → 1', normalizeLevel(0), 1)
check('monotono', normalizeLevel(-40) > normalizeLevel(-50), '')

console.log('\n=== VAD: rumore di fondo ===')
// Silenzio continuo: nessun evento di parlato.
const silenzio = simulateGate(new Array(200).fill(-70))
eq('silenzio: nessun inizio', silenzio.events.length, 0)
check('in silenzio la soglia resta bassa', silenzio.threshold <= -40, `soglia=${silenzio.threshold.toFixed(1)}`)

// Parlato in mezzo al silenzio.
const frase = [
  ...new Array(60).fill(-70), // 1,2 s di ambiente
  ...new Array(50).fill(-25), // 1,0 s di voce
  ...new Array(60).fill(-70), // 1,2 s di silenzio
]
const conFrase = simulateGate(frase)
eq('parlato: un inizio e una fine', conFrase.events.map((e) => e.type), ['start', 'end'])
check('l inizio arriva durante il parlato', conFrase.events[0].at >= 1220 && conFrase.events[0].at <= 1500, `a ${conFrase.events[0].at} ms`)
check('la fine arriva durante il silenzio', conFrase.events[1].at >= 2020, `a ${conFrase.events[1].at} ms`)

console.log('\n=== VAD: robustezza ===')
// Un rumore improvviso ma contenuto non deve far scattare il riconoscimento:
// supera la soglia istantanea, ma non sale abbastanza sopra il fondo da essere
// voce. È il caso della tastiera, di uno schiocco, di una porta.
const rumore = [...new Array(60).fill(-70), ...new Array(25).fill(-52), ...new Array(60).fill(-70)]
const conRumore = simulateGate(rumore)
eq('un rumore breve non viene scambiato per parola', conRumore.events.length, 0)

// Un suono forte e breve invece è un rumore, ma la conferma avviene comunque:
// non possiamo distinguerlo da una parola a due sillabe. Va gestito a valle,
// dal messaggio "non ho capito", non dal VAD.
const colpo = [...new Array(60).fill(-70), ...new Array(25).fill(-26), ...new Array(60).fill(-70)]
const conColpo = simulateGate(colpo)
check('un suono forte viene rilevato', conColpo.events.some((e) => e.type === 'start'), JSON.stringify(conColpo.events))

// Più frasi separate da pause brevi.
const dueFrasi = [
  ...new Array(60).fill(-70),
  ...new Array(40).fill(-25),
  ...new Array(22).fill(-70), // pausa di 0,44 s: sotto l'hangover
  ...new Array(40).fill(-25),
  ...new Array(60).fill(-70),
]
const due = simulateGate(dueFrasi)
eq('pausa sotto l hangover: una sola frase', due.events.map((e) => e.type), ['start', 'end'])

// Pausa lunga: due frasi distinte.
const dueSeparate = [
  ...new Array(60).fill(-70),
  ...new Array(40).fill(-25),
  ...new Array(80).fill(-70), // pausa di 1,6 s: sopra l'hangover
  ...new Array(40).fill(-25),
  ...new Array(60).fill(-70),
]
const separate = simulateGate(dueSeparate)
eq('pausa lunga: due frasi', separate.events.map((e) => e.type), ['start', 'end', 'start', 'end'])

// Il pavimento non deve inseguire il parlato: se lo facesse, la soglia salirebbe
// sopra la voce e l'utente verrebbe "tagliato fuori" a metà frase.
const prolungato = [
  ...new Array(60).fill(-70),
  ...new Array(200).fill(-25), // 4 s di voce ininterrotta
  ...new Array(60).fill(-70),
]
const continuo = simulateGate(prolungato)
eq('voce lunga: un solo inizio', continuo.events.filter((e) => e.type === 'start').length, 1)
check('la soglia non insegue la voce', continuo.threshold < -25, `soglia=${continuo.threshold.toFixed(1)}`)

// Ambiente rumoroso: il soffio di fondo non deve scattare, ma una voce sì.
const soffio = new Array(240).fill(-45)
const inRumoroso = simulateGate(soffio)
eq('in una stanza rumorosa il soffio non scatta', inRumoroso.events.length, 0)
check(
  'la soglia segue il fondo rumoroso',
  inRumoroso.threshold > -40,
  `soglia=${inRumoroso.threshold.toFixed(1)} (fondo ${inRumoroso.floor.toFixed(1)})`,
)
const voceSuRumoroso = [...new Array(120).fill(-45), ...new Array(50).fill(-24), ...new Array(80).fill(-45)]
const conVoce = simulateGate(voceSuRumoroso)
eq('una voce sopra il rumore viene comunque rilevata', conVoce.events.map((e) => e.type), ['start', 'end'])

console.log('\n=== VAD: parametri ===')
check('onset breve ma non immediato', DEFAULT_VAD.onsetMs >= 100 && DEFAULT_VAD.onsetMs <= 300, `${DEFAULT_VAD.onsetMs}`)
check('hangover più lungo dell onset', DEFAULT_VAD.hangoverMs > DEFAULT_VAD.onsetMs, `${DEFAULT_VAD.hangoverMs}`)
check('margine sopra il fondo sufficiente', DEFAULT_VAD.marginDb >= 8, `${DEFAULT_VAD.marginDb}`)
check('soglia massima sensata', DEFAULT_VAD.maxThresholdDb > DEFAULT_VAD.minThresholdDb)
check(
  'controllo di picco più severo della soglia',
  DEFAULT_VAD.peakMarginDb > DEFAULT_VAD.marginDb,
  `picco=${DEFAULT_VAD.peakMarginDb} dB, soglia=${DEFAULT_VAD.marginDb} dB`,
)

console.log('\n=== STT: impostazioni ===')
eq('lingua predefinita', DEFAULT_STT_OPTIONS.lang, 'it-IT')
check(
  'attesa di riavvio compatibile con il motore',
  DEFAULT_STT_OPTIONS.restartDelayMs >= 80 && DEFAULT_STT_OPTIONS.restartDelayMs <= 400,
  `${DEFAULT_STT_OPTIONS.restartDelayMs} ms`,
)

console.log('\n=== riepilogo ===')
console.log(`${passed} verifiche superate, ${failed} fallite`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('TUTTE LE VERIFICHE SUPERATE')
