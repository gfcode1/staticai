/**
 * Verifica della configurazione della wake word.
 *
 * Il motore ONNX non è testabile in Node (serve `AudioContext`, WASM e i
 * modelli); ma la parte che decide *cosa* il motore fa — parola valida,
 * soglia nei limiti, URL degli asset sotto `base` di Vite — è pura e si
 * verifica esattamente come il VAD in `verify-listening.ts`.
 */

import { STORAGE_KEYS, WAKE_WORD_ENABLED_DEFAULT } from '/src/config.ts'
import {
  WAKE_DEFAULT_KEYWORD,
  WAKE_DEFAULT_THRESHOLD,
  WAKE_KEYWORDS,
  WAKE_MODEL_FILES,
  WAKE_THRESHOLD_LIMITS,
  clampWakeThreshold,
  defaultWakeBaseUrl,
  inferKeywordWindowSize,
  isWakeKeyword,
  normalizeWakeKeyword,
  resolveWakeAssetUrl,
} from '/src/speech/wakeWordConfig.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, a === b ? '' : `atteso ${b}, ottenuto ${a}`)
}

/* -------------------------------------------------------- parole chiave */

check('tutte le parole hanno un file modello', WAKE_KEYWORDS.every((k) => typeof WAKE_MODEL_FILES[k] === 'string' && WAKE_MODEL_FILES[k].endsWith('.onnx')))
check('default fra le parole bundled', isWakeKeyword(WAKE_DEFAULT_KEYWORD))
check('parola sconosciuta riconosciuta', !isWakeKeyword('hey_ari'))
check('parola sconosciuta normalizzata al default', normalizeWakeKeyword('hey_ari') === WAKE_DEFAULT_KEYWORD)
check('parola nulla normalizzata al default', normalizeWakeKeyword(null) === WAKE_DEFAULT_KEYWORD)
eq('parola valida tenuta', normalizeWakeKeyword('alexa'), 'alexa')

/* ---------------------------------------------------------------- soglia */

eq('soglia default nei limiti', WAKE_DEFAULT_THRESHOLD >= WAKE_THRESHOLD_LIMITS.min && WAKE_DEFAULT_THRESHOLD <= WAKE_THRESHOLD_LIMITS.max, true)
eq('soglia sotto il minimo clampata', clampWakeThreshold(0.01), WAKE_THRESHOLD_LIMITS.min)
eq('soglia sopra il massimo clampata', clampWakeThreshold(0.99), WAKE_THRESHOLD_LIMITS.max)
eq('soglia valida tenuta', clampWakeThreshold(0.65), 0.65)
eq('soglia non numero al default', clampWakeThreshold('alta'), WAKE_DEFAULT_THRESHOLD)
eq('soglia NaN al default', clampWakeThreshold(Number.NaN), WAKE_DEFAULT_THRESHOLD)

/* ----------------------------------------------------------------- asset */

eq('base dev sotto root', defaultWakeBaseUrl('/'), '/openwakeword/models')
eq('base pages con slash finale', defaultWakeBaseUrl('/staticai/'), '/staticai/openwakeword/models')
eq('base pages senza slash finale', defaultWakeBaseUrl('/staticai'), '/staticai/openwakeword/models')
eq('url asset senza doppie barre', resolveWakeAssetUrl('/staticai/openwakeword/models/', 'hey_jarvis_v0.1.onnx'), '/staticai/openwakeword/models/hey_jarvis_v0.1.onnx')
eq('url asset base pulita', resolveWakeAssetUrl('/staticai/openwakeword/models', 'melspectrogram.onnx'), '/staticai/openwakeword/models/melspectrogram.onnx')

/* ----------------------------------------------- finestra di embedding */

/**
 * Regressione del `Flatten_0 ... Got: 16 Expected: 34` su Timer: ORT 1.30
 * espone `inputMetadata` come array, le vecchie versioni come dizionario.
 * Forme misurate sui modelli bundled reali.
 */
function sessioneArray(nome: string, finestra: number): object {
  return {
    inputNames: [nome],
    inputMetadata: [{ name: nome, isTensor: true, type: 'float32', shape: [1, finestra, 96] }],
  }
}

function sessioneDizionario(nome: string, finestra: number): object {
  return {
    inputNames: [nome],
    inputMetadata: { [nome]: { isTensor: true, shape: [1, finestra, 96] } },
  }
}

eq('timer in forma array dà 34', inferKeywordWindowSize(sessioneArray('onnx::Flatten_0', 34)), 34)
eq('weather in forma array dà 22', inferKeywordWindowSize(sessioneArray('onnx::Flatten_0', 22)), 22)
eq('jarvis in forma array dà 16', inferKeywordWindowSize(sessioneArray('x.1', 16)), 16)
eq('timer in forma dizionario dà 34', inferKeywordWindowSize(sessioneDizionario('onnx::Flatten_0', 34)), 34)
eq('sessione senza nomi dà undefined', inferKeywordWindowSize({ inputNames: [], inputMetadata: [] }), undefined)
eq('sessione nulla dà undefined', inferKeywordWindowSize(null), undefined)
eq('metadata irriconoscibili danno undefined', inferKeywordWindowSize({ inputNames: ['x'], inputMetadata: { x: { isTensor: true } } }), undefined)
eq('dimensione simbolica dà undefined', inferKeywordWindowSize({ inputNames: ['x'], inputMetadata: [{ name: 'x', shape: [1, 'batch', 96] }] }), undefined)

/* ------------------------------------------------- default e persistenza */

check('risveglio spento di default (opt-in)', WAKE_WORD_ENABLED_DEFAULT === false)
check('chiave di persistenza dedicata', typeof STORAGE_KEYS.wakeWord === 'string' && STORAGE_KEYS.wakeWord.length > 0)
check(
  'chiave distinta da camera e voce',
  STORAGE_KEYS.wakeWord !== STORAGE_KEYS.camera && STORAGE_KEYS.wakeWord !== STORAGE_KEYS.voice,
)

console.log(`\nwakeword: ${passed} ok, ${failed} falliti`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  throw new Error(`${failed} verifiche wakeword fallite`)
}
