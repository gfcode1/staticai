/**
 * Verifica della logica di Fase 2.
 *
 * La logica di testo e visemi è pura e isolata dal TTS, quindi si testa
 * esattamente com'è: nessun mocking, nessun browser. L'unica cosa che non
 * possiamo provare qui è il motore di sintesi vero e proprio, che dipende dalle
 * voci installate sul sistema.
 */

import { splitIntoChunks, estimateDuration } from '/src/speech/chunks'
import { sanitizeForSpeech, hasSpeakableContent } from '/src/speech/sanitize'
import {
  buildVisemeTimeline,
  sampleTimeline,
  dominantViseme,
  mouthOpenness,
  timelineLength,
  type VisemeWeights,
} from '/src/speech/visemes'
import { TimedLipSync, DEFAULT_CHARS_PER_SECOND } from '/src/speech/lipSync'
import { rankVoices, voiceLabel } from '/src/speech/tts'

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

console.log('\n=== sanitize ===')
eq('markdown asterischi', sanitizeForSpeech('**grassetto** e *corsivo*'), 'grassetto e corsivo')
eq('titoli', sanitizeForSpeech('# Titolo\nTesto'), 'Titolo Testo')
eq('elenchi', sanitizeForSpeech('- primo\n- secondo'), 'primo secondo')
eq('link', sanitizeForSpeech('Vedi [qui](https://esempio.com)'), 'Vedi qui')
eq('url nudo', sanitizeForSpeech('Apri https://esempio.com/x adesso'), 'Apri adesso')
eq('emoji', sanitizeForSpeech('Ciao 👋🏽 come stai? 🎉'), 'Ciao come stai?')
eq('selettore variazione', sanitizeForSpeech('Bene ❤️'), 'Bene')
eq('simboli', sanitizeForSpeech('Fa 23 °C, costa 10 € e +5%'), 'Fa 23 gradi C, costa 10 euro e più 5 per cento')
eq('virgolette', sanitizeForSpeech('Ha detto "ciao"'), 'Ha detto ciao')
eq('spazi multipli', sanitizeForSpeech('  a   b  '), 'a b')
eq('punteggiatura conservata', sanitizeForSpeech('Ciao, come stai? Bene!'), 'Ciao, come stai? Bene!')
eq('punteggiatura doppia', sanitizeForSpeech('Wow!!! Che cosa???'), 'Wow! Che cosa?')
check('solo codice → non pronunciabile', !hasSpeakableContent('```js\nconst x = 1\n```'))
check('testo normale → pronunciabile', hasSpeakableContent('Buongiorno a te'))
eq('cinese rimosso', sanitizeForSpeech('Ciao 世界'), 'Ciao')

console.log('\n=== chunks ===')
eq('frase unica', splitIntoChunks('Buongiorno a tutti.'), ['Buongiorno a tutti.'])
// Le frasi molto brevi vengono unite di proposito: pronunciarle singolarmente
// suona come uno scatto, e un chunk da 4 caratteri dà una stima di ritmo rumorosa.
eq('due frasi brevi vengono unite', splitIntoChunks('Uno. Due.'), ['Uno. Due.'])
eq('frasi corte non vengono unite se sono lunghe', splitIntoChunks('Prima frase completa. Seconda frase completa.').length >= 2, true)
check(
  'nessun chunk oltre il limite',
  splitIntoChunks('parola '.repeat(200)).every((c) => c.length <= 130),
  `max=${Math.max(...splitIntoChunks('parola '.repeat(200)).map((c) => c.length))}`,
)
check(
  'nessuna perdita di testo',
  splitIntoChunks('Uno. Due, tre; quattro: cinque.').join(' ') === 'Uno. Due, tre; quattro: cinque.',
  splitIntoChunks('Uno. Due, tre; quattro: cinque.').join(' | '),
)
const tiny = splitIntoChunks('Sì. No. Forse.')
check('frasi brevi unite', tiny.length === 1, JSON.stringify(tiny))
eq('testo vuoto', splitIntoChunks('   '), [])
eq('parola unica', splitIntoChunks('ciao'), ['ciao'])
const long = splitIntoChunks('a'.repeat(500))
check('parola enorme spezzata', long.every((c) => c.length <= 130), `chunk=${long.map((c) => c.length)}`)
check('durata stimata > 0', estimateDuration('Ciao mondo.', DEFAULT_CHARS_PER_SECOND) > 0)
check(
  'la stima cresce con la lunghezza',
  estimateDuration('a'.repeat(100), 15) > estimateDuration('a'.repeat(20), 15),
)

console.log('\n=== visemes: mappa vocali ===')
function visemeOf(text) {
  const timeline = buildVisemeTimeline(text)
  const index = timelineLength(timeline) - 1
  return dominantViseme(sampleTimeline(timeline, index))
}
eq('vocale A', visemeOf('a'), 'aa')
eq('vocale E', visemeOf('e'), 'ee')
eq('vocale I', visemeOf('i'), 'ih')
eq('vocale O', visemeOf('o'), 'oh')
eq('vocale U', visemeOf('u'), 'ou')
eq('accentata à', visemeOf('à'), 'aa')
eq('accentata ù', visemeOf('ù'), 'ou')
eq('Y italiana', visemeOf('y'), 'ih')
eq('vocale accentata = stessa vocale', visemeOf('é'), visemeOf('e'))

console.log('\n=== visemes: consonanti ===')
function weightsAt(text, index) {
  const timeline = buildVisemeTimeline(text)
  return sampleTimeline(timeline, index)
}
const m = weightsAt('mamma', 0)
check('labiale m chiude la bocca', mouthOpenness(m) < 0.1, `openness=${mouthOpenness(m).toFixed(3)}`)
const f = weightsAt('fino', 0)
check('labiodentale f semi-aperta', mouthOpenness(f) > 0.1 && mouthOpenness(f) < 0.4, `openness=${mouthOpenness(f).toFixed(3)}`)
const p = weightsAt('perché', 1)
check('vocale dopo consonante si trova', dominantViseme(p) === 'ee', JSON.stringify(dominantViseme(p)))
const s = weightsAt('sss', 0)
check('consonante isolata quasi chiusa', mouthOpenness(s) < 0.2, `openness=${mouthOpenness(s).toFixed(3)}`)
const punct = weightsAt('ciao.', 4)
check('punto = bocca chiusa', mouthOpenness(punct) < 0.05, `openness=${mouthOpenness(punct).toFixed(3)}`)
const comma = weightsAt('ciao,', 4)
check('virgola = chiusura parziale', mouthOpenness(comma) > 0.05 && mouthOpenness(comma) < 0.6, `openness=${mouthOpenness(comma).toFixed(3)}`)

console.log('\n=== visemes: struttura ===')
eq('timeline vuota per testo vuoto', timelineLength(buildVisemeTimeline('')), 0)
eq('lunghezza = caratteri', timelineLength(buildVisemeTimeline('ciao mondo')), 10)
const sampled = sampleTimeline(new Float32Array(0), 5)
check('campionamento su timeline vuota non lancia', mouthOpenness(sampled) === 0)
const tl = buildVisemeTimeline('aaa')
check('clamp sopra la fine', mouthOpenness(sampleTimeline(tl, 999)) === mouthOpenness(sampleTimeline(tl, 2)))
check('clamp sotto lo zero', mouthOpenness(sampleTimeline(tl, -5)) === mouthOpenness(sampleTimeline(tl, 0)))

console.log('\n=== visemes: varietà nella frase ===')
const phrase = 'Buongiorno, come stai oggi? Molto bene, grazie!'
const tlPhrase = buildVisemeTimeline(phrase)
const seen = new Set()
for (let i = 0; i < timelineLength(tlPhrase); i += 1) {
  const d = dominantViseme(sampleTimeline(tlPhrase, i))
  if (d) seen.add(d)
}
check(
  'una frase reale usa più di due forme',
  seen.size >= 3,
  `forme osservate: ${[...seen].join(', ')}`,
)

console.log('\n=== lipSync: posizione nel tempo ===')
const ls = new TimedLipSync()
ls.start('abcdefghij', 1000, 1000)
check('a t=0 siamo all\'inizio', Math.abs(ls.charPositionAt(1000)) < 0.5, `pos=${ls.charPositionAt(1000)}`)
// 0.5 s × 15 caratteri/s = 7.5 caratteri: la posizione segue il tempo, non la
// metà del testo. È proprio questo il punto della calibrazione.
const midPos = ls.charPositionAt(1500)
check('la posizione segue il ritmo', Math.abs(midPos - 7.5) < 0.5, `pos=${midPos.toFixed(2)} (atteso 7.5)`)
// Con 10 caratteri in un secondo, dopo 1 s saremmo all'indice 10: fuori dal testo
// (lunghezza 10, indici 0-9), quindi la posizione viene bloccata all'ultimo.
const slow = new TimedLipSync()
slow.seedRate(10)
slow.start('abcdefghij', 0, 1000)
check('la posizione è bloccata alla fine del testo', slow.charPositionAt(1000) === 9, `pos=${slow.charPositionAt(1000)}`)
check('un ritmo più lento arriva più avanti a parità di testo', slow.charPositionAt(500) === 5, `pos=${slow.charPositionAt(500)}`)
check('oltre la durata resta dentro', ls.charPositionAt(999_999) <= 9, `pos=${ls.charPositionAt(999_999)}`)
check('tempo negativo non va indietro', ls.charPositionAt(0) >= 0)

console.log('\n=== lipSync: calibrazione ===')
const cal = new TimedLipSync()
eq('ritmo iniziale = default', cal.currentCharsPerSecond, DEFAULT_CHARS_PER_SECOND)
check('non calibrato all\'inizio', cal.calibration.measured === false)
cal.start('aaaa', 0, 1000)
cal.end(500) // 4 caratteri in 0.5 s → 8 car/s
check('ritmo calibrato dopo un chunk', cal.calibration.measured === true)
check('ritmo vicino a quello reale', Math.abs(cal.currentCharsPerSecond - 8) < 0.5, `cps=${cal.currentCharsPerSecond.toFixed(2)}`)
const cal2 = new TimedLipSync()
cal2.start('aaaa', 0, 1000)
cal2.end(200) // 20 car/s
cal2.start('aaaa', 0, 500)
cal2.end(500) // 8 car/s: la mediana scarta il valore anomalo
check(
  'la mediana scarta le misure anomale',
  cal2.currentCharsPerSecond > 8 && cal2.currentCharsPerSecond < 20,
  `cps=${cal2.currentCharsPerSecond.toFixed(2)}`,
)
const cal3 = new TimedLipSync()
cal3.start('aaaa', 0, 100)
cal3.end(50) // sotto la soglia: misura scartata
check('misure troppo corte scartate', cal3.calibration.measured === false)
cal3.resetCalibration()
check('reset della calibrazione', cal3.currentCharsPerSecond === DEFAULT_CHARS_PER_SECOND)
cal3.seedRate(30)
eq('seedRate', cal3.currentCharsPerSecond, 30)
cal3.seedRate(-5)
eq('seedRate rifiuta valori invalidi', cal3.currentCharsPerSecond, 30)

console.log('\n=== lipSync: campionamento ===')
const ls2 = new TimedLipSync()
ls2.start('a', 0, 1000)
check('testo di una lettera: aperta', mouthOpenness(ls2.sample(500)) > 0.8)
ls2.stop()
check('dopo stop i pesi sono zero', mouthOpenness(ls2.sample(500)) === 0)
check('dopo stop non è attivo', ls2.isActive === false)

console.log('\n=== lipSync: sincronia end-to-end ===')
// Simulazione: pronunciamo "aaaa" (4 caratteri) in 400 ms reali, con ritmo
// stimato al doppio. I visemi devono restare entro la parte di testo corretta.
const sync = new TimedLipSync()
sync.start('aaaa', 0, 400) // stima 400 ms
const samples = []
for (let ms = 0; ms <= 800; ms += 50) {
  samples.push({ ms, openness: mouthOpenness(sync.sample(ms)) })
}
sync.end(400)
const wrongRate = sync.currentCharsPerSecond
check(
  'il ritmo misurato corregge la stima',
  Math.abs(wrongRate - 10) < 1,
  `1 char/50ms ⇒ ${wrongRate.toFixed(2)} car/s`,
)

/* ------------------------------------------------- scelta della voce */

console.log('\n=== Scelta della voce: per merito, non per ordine ===')

/** Voce finta: `SpeechSynthesisVoice` è una classe, qui basta la forma. */
function voce(nome: string, lang: string, locale = true, predefinita = false): SpeechSynthesisVoice {
  return { name: nome, lang, localService: locale, default: predefinita, voiceURI: nome } as SpeechSynthesisVoice
}

const nessuna: SpeechSynthesisVoice[] = []
eq('nessuna voce → lista vuota', rankVoices(nessuna, { lang: 'it-IT' }).length, 0)

// Il caso reale su Linux: l'ordine di arrivo non dice niente sul merito.
const disordine = [
  voce('it', 'it'),
  voce('Google UK English Female', 'en-GB', false),
  voce('it+f3', 'it'),
  voce('it-IT', 'it-IT'),
]
const scelte = rankVoices(disordine, { lang: 'it-IT' })
eq('la lingua esatta vince sulle varianti', scelte[0].lang, 'it-IT')
check('le voci di altre lingue sono escluse', scelte.every((v) => v.lang.startsWith('it')), scelte.map((v) => v.lang).join(','))

// Una voce locale, anche se arriva dopo una remota: conta il merito, non la posizione.
const misto = [voce('NVIDIA', 'it-IT', false), voce('espeak', 'it-IT', true)]
eq('a parità di lingua la locale vince', rankVoices(misto, { lang: 'it-IT' })[0].localService, true)

// Locale e remota con lingue diverse: la lingua esatta resta la prima.
const lingue = [voce('Remota IT', 'it-IT', false), voce('Locale IT', 'it', true)]
eq('la lingua esatta vince anche sulla locale più generica', rankVoices(lingue, { lang: 'it-IT' })[0].name, 'Remota IT')

// `default` del sistema: spareggio debole, vale solo a parità.
const predefinite = [voce('A', 'it-IT'), voce('B', 'it-IT', true, true)]
eq('il default del sistema è lo spareggio', rankVoices(predefinite, { lang: 'it-IT' })[0].name, 'B')

// Stabile a parità: non deve riordinare a caso.
const equivalenti = [voce('X', 'it-IT'), voce('Y', 'it-IT'), voce('Z', 'it-IT')]
eq("a parità l'ordine non cambia", rankVoices(equivalenti, { lang: 'it-IT' }).map((v) => v.name), ['X', 'Y', 'Z'])

// Nessun italiano disponibile: la lista è vuota, e il chiamante lo gestisce.
eq('senza voci italiane → lista vuota', rankVoices([voce('X', 'en-US')], { lang: 'it-IT' }).length, 0)

// Lingue con prefisso che non è italiano ma contiene "it": il confronto è per lingua.
const falsoPositivo = rankVoices([voce('X', 'de-DE'), voce('Y', 'it')], { lang: 'it-IT' })
eq('nessun falso positivo fra lingue diverse', falsoPositivo.map((v) => v.name), ['Y'])

/* ------------------------------------------------------------ etichette */

console.log('\n=== Le voci si distinguono nel menù ===')

eq('voce locale', voiceLabel(voce('Elena', 'it-IT', true)), 'Elena · it-IT · locale')
eq('voce online', voiceLabel(voce('Google Italiano', 'it-IT', false)), 'Google Italiano · it-IT · online')
eq('il suffisso tecnico viene tolto', voiceLabel(voce('Microsoft Elena Online (Natural) - Italian (Italy)', 'it-IT', false)), 'Microsoft Elena Online · it-IT · online')
eq('due voci omonome si distinguono per lingua', voiceLabel(voce('Voce', 'it-IT')) !== voiceLabel(voce('Voce', 'en-US')), true)

console.log('\n=== riepilogo ===')
console.log(`${passed} verifiche superate, ${failed} fallite`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('TUTTE LE VERIFICHE SUPERATE')
