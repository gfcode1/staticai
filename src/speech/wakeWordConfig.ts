/**
 * Configurazione pura della wake word.
 *
 * Sta in un modulo senza dipendenze dal browser (niente `window`, niente
 * `AudioContext`, niente ORT) per due motivi: è importabile dai test Node
 * attraverso il risolutore di Vite, e non tira dentro `onnxruntime-web` —
 * che deve restare in un chunk lazy caricato solo quando l'utente attiva
 * l'ascolto in background.
 */

/** Parole chiave con un modello bundled in `public/openwakeword/models/`. */
export const WAKE_KEYWORDS = [
  'hey_jarvis',
  'alexa',
  'hey_mycroft',
  'hey_rhasspy',
  'timer',
  'weather',
] as const

export type WakeKeyword = (typeof WAKE_KEYWORDS)[number]

/** File ONNX per ogni parola chiave (mappa di `MODEL_FILE_MAP` upstream). */
export const WAKE_MODEL_FILES: Record<WakeKeyword, string> = {
  hey_jarvis: 'hey_jarvis_v0.1.onnx',
  alexa: 'alexa_v0.1.onnx',
  hey_mycroft: 'hey_mycroft_v0.1.onnx',
  hey_rhasspy: 'hey_rhasspy_v0.1.onnx',
  timer: 'timer_v0.1.onnx',
  weather: 'weather_v0.1.onnx',
}

/** File comuni della pipeline: mel → embedding → VAD. */
export const WAKE_CORE_FILES = [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
] as const

export const WAKE_DEFAULT_KEYWORD: WakeKeyword = 'hey_jarvis'
export const WAKE_DEFAULT_THRESHOLD = 0.5
export const WAKE_THRESHOLD_LIMITS = { min: 0.2, max: 0.9, step: 0.05 } as const
export const WAKE_COOLDOWN_MS = 2000

/** Etichette leggibili per il selettore. */
export const WAKE_KEYWORD_LABELS: Record<WakeKeyword, string> = {
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
  hey_rhasspy: 'Hey Rhasspy',
  timer: 'Timer',
  weather: 'Weather',
}

export function isWakeKeyword(value: unknown): value is WakeKeyword {
  return (
    typeof value === 'string' && (WAKE_KEYWORDS as readonly string[]).includes(value)
  )
}

/** La parola salvata deve esistere ancora, altrimenti si torna al default. */
export function normalizeWakeKeyword(value: unknown): WakeKeyword {
  return isWakeKeyword(value) ? value : WAKE_DEFAULT_KEYWORD
}

/** La soglia resta in un intervallo sensato: fuori, il motore o non sente mai o sente sempre. */
export function clampWakeThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WAKE_DEFAULT_THRESHOLD
  return Math.min(
    Math.max(value, WAKE_THRESHOLD_LIMITS.min),
    WAKE_THRESHOLD_LIMITS.max,
  )
}

/**
 * Base URL degli ONNX a runtime.
 *
 * Deve rispettare `base` di Vite (`/staticai/` su Project Pages): un path
 * assoluto cablato come `/openwakeword/models` funzionerebbe in dev e si
 * romperebbe in produzione.
 */
export function defaultWakeBaseUrl(base: string): string {
  const pulita = base.endsWith('/') ? base : `${base}/`
  return `${pulita}openwakeword/models`
}

/** `base + file` senza doppie barre. */
export function resolveWakeAssetUrl(baseAssetUrl: string, file: string): string {
  return `${baseAssetUrl.replace(/\/+$/, '')}/${file}`
}

/**
 * Deduce la finestra di embedding attesa dalla testata della parola chiave
 * (16 per Jarvis/Mycroft/Alexa/Rhasspy, 22 per Weather, 34 per Timer).
 *
 * Senza questo, Timer fallirebbe con `Got invalid dimensions for input:
 * onnx::Flatten_0 ... Got: 16 Expected: 34`: la finestra passata deve
 * coincidere con quella di training.
 *
 * Legge `unknown` di proposito: la forma di `inputMetadata` cambia fra le
 * versioni di ORT (dizionario nelle vecchie, array di `{name, shape}` nella
 * 1.30), e legarsi a una sola forma è esattamente il difetto che ha prodotto
 * il fallback a 16. Se la forma non si riconosce, torna `undefined` e il
 * chiamante usa il default — mai un numero inventato.
 */
export function inferKeywordWindowSize(session: unknown): number | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  const record = session as Record<string, unknown>
  const inputNames: unknown = record['inputNames']
  const inputName: unknown =
    Array.isArray(inputNames) && typeof inputNames[0] === 'string' ? inputNames[0] : undefined
  if (typeof inputName !== 'string') return undefined

  const allMeta: unknown = record['inputMetadata']
  let shape: unknown
  if (Array.isArray(allMeta)) {
    const entry: unknown =
      allMeta.find(
        (m) =>
          typeof m === 'object' && m !== null && (m as Record<string, unknown>)['name'] === inputName,
      ) ?? allMeta[0]
    shape =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['shape']
        : undefined
  } else if (typeof allMeta === 'object' && allMeta !== null) {
    const metadata: unknown = (allMeta as Record<string, unknown>)[inputName]
    shape =
      typeof metadata === 'object' && metadata !== null
        ? (metadata as Record<string, unknown>)['shape']
        : undefined
  }
  if (!Array.isArray(shape)) return undefined
  const dim: unknown = shape[1]
  return typeof dim === 'number' && Number.isFinite(dim) ? dim : undefined
}
