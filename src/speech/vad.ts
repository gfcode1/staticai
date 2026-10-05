/**
 * Rilevamento dell'attività vocale sul flusso del microfono.
 *
 * Perché serve, se il motore di riconoscimento sa già quando l'utente ha finito
 * di parlare: perché **non lo sa**. Chrome chiude il riconoscimento dopo un
 * silenzio di durata variabile (da 2 a una decina di secondi, a seconda della
 * versione e del rumore), e non c'è alcun modo di chiedergli "l'utente ha
 * finito?". Il risultato è una conversazione scomoda: si parla, si aspetta, si
 * aspetta ancora, e a volte la frase non parte perché il timeout non è scaduto.
 *
 * Misuriamo quindi l'intensità del segnale noi stessi e decidiamo noi quando
 * l'utente ha finito. Il segnale greco è solo un rumore; è il **pavimento
 * adattivo** a rendere la soglia utilizzabile in una stanza vera.
 */

export interface VadOptions {
  /** Soglia assoluta minima, in dBFS. Ripiano per una stanza molto rumorosa. */
  minThresholdDb: number
  /** Margine sopra il rumore di fondo misurato, in dB. */
  marginDb: number
  /**
   * Picco minimo, in dB sopra il pavimento di fondo, per confermare che si tratti
   * davvero di voce.
   *
   * La soglia istantanea da sola è troppo permissiva: in una stanza silenziosa
   * il pavimento si aggira sui −70 dBFS e la soglia si blocca sul minimo
   * assoluto, cosicché un colpo di tastiera, uno schiocco o una porta aprendo la
   * superano senza problemi. Ma sono rumori **brevi**: se il segnale non sale
   * mai chiaramente sopra il fondo, non era una voce.
   *
   * È la differenza fra "qualcosa ha fatto rumore" e "qualcuno ha parlato".
   */
  peakMarginDb: number
  /** Soglia massima: oltre questa, il microfono è saturo e non ha senso alzarla. */
  maxThresholdDb: number
  /** Quanto tempo il segnale resta sopra soglia prima di confermare il parlato. */
  onsetMs: number
  /** Quanto tempo resta sotto soglia prima di confermare la fine del parlato. */
  hangoverMs: number
  /** Quanto rapidamente il pavimento di rumore insegue il livello corrente. */
  floorTau: number
}

export const DEFAULT_VAD: VadOptions = {
  // -52 dBFS corrisponde a una conversazione a mezzo metro; sotto, è ambiente.
  minThresholdDb: -52,
  marginDb: 11,
  // Per confermare il parlato il picco deve stare almeno 17 dB sopra il fondo:
  // abbastanza sopra un rumore occasionale, abbastanza sotto una voce anche
  // sommessa.
  peakMarginDb: 17,
  maxThresholdDb: -28,
  onsetMs: 180,
  hangoverMs: 650,
  floorTau: 1.2,
}

/** Frequenza di analisi. 50 Hz: abbastanza rapida, abbastanza economica. */
const POLL_INTERVAL_MS = 20

/** Dimensione della finestra dell'analizzatore. */
const FFT_SIZE = 1024

/** Normalizzazione a 0…1 per il meter, in dBFS. */
const METER_MIN_DB = -60
const METER_MAX_DB = -10

/** Soglia sotto la quale il segnale è considerato silenzio assoluto. */
const SILENCE_DB = -90

export interface VadCallbacks {
  /** Inizio del parlato confermato. */
  onSpeechStart?: () => void
  /** Fine del parlato confermata. */
  onSpeechEnd?: () => void
  /** Livello 0…1 per il meter, a ogni poll. */
  onLevel?: (level: number) => void
}

export interface VadHandle {
  stop(): void
  readonly isSpeechActive: boolean
  readonly currentThresholdDb: number
  readonly noiseFloorDb: number
}

export function isMicrophoneSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

export async function requestMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // Questi tre filtri sono ciò che rende il riconoscimento-usabile in una
      // stanza vera: senza, la tastiera di chi scrive finisce nel transcript.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  })
}

/**
 * Avvia l'analisi del flusso audio.
 *
 * Va chiamata da un gesto dell'utente: un `AudioContext` creato senza interazione
 * parte in stato `suspended` e non produce campioni.
 */
export async function startVad(
  stream: MediaStream,
  options: VadOptions = DEFAULT_VAD,
  callbacks: VadCallbacks = {},
): Promise<VadHandle> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio non disponibile in questo browser.')

  const context = new AudioContextCtor()
  if (context.state === 'suspended') await context.resume()

  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = FFT_SIZE
  // Lo smoothing attutisce il tremolio frame per frame senza farci perdere
  // l'attacco delle consonanti, che sono brevi.
  analyser.smoothingTimeConstant = 0.35
  source.connect(analyser)

  const buffer = new Float32Array(analyser.fftSize)

  let noiseFloorDb = Math.max(options.minThresholdDb - options.marginDb, SILENCE_DB + 6)
  let thresholdDb = noiseFloorDb + options.marginDb
  let speaking = false
  let aboveSinceMs = 0
  let belowSinceMs = 0
  /** Picco raggiunto dall'attuale candidato, per il controllo di conferma. */
  let candidatePeakDb = SILENCE_DB
  let lastPollMs = 0
  let stopped = false

  const measure = (): number => {
    analyser.getFloatTimeDomainData(buffer)
    let sum = 0
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = buffer[i] ?? 0
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / buffer.length)
    return rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB
  }

  const timer = window.setInterval(() => {
    if (stopped) return
    const now = performance.now()
    const elapsed = lastPollMs === 0 ? POLL_INTERVAL_MS : now - lastPollMs
    lastPollMs = now

    const level = measure()
    callbacks.onLevel?.(normalizeLevel(level))

    // Il pavimento di rumore insegue il livello **solo quando non si parla**.
    // inseguirlo anche durante il parlato significherebbe alzare la soglia
    // proprio mentre l'utente parla, e il resto della frase andrebbe perso.
    if (!speaking) {
      const alpha = 1 - Math.exp(-elapsed / 1000 / options.floorTau)
      noiseFloorDb += (level - noiseFloorDb) * alpha
    }
    thresholdDb = Math.min(
      Math.max(noiseFloorDb + options.marginDb, options.minThresholdDb),
      options.maxThresholdDb,
    )

    const above = level > thresholdDb

    if (above) {
      belowSinceMs = 0
      if (candidatePeakDb < level) candidatePeakDb = level
      if (aboveSinceMs === 0) aboveSinceMs = now
      if (!speaking && now - aboveSinceMs >= options.onsetMs) {
        // Confermiamo solo se il segnale è salito davvero: oltre la soglia
        // istantanea, il picco deve essere chiaramente sopra il fondo.
        if (candidatePeakDb - noiseFloorDb >= options.peakMarginDb) {
          speaking = true
          callbacks.onSpeechStart?.()
        } else {
          // Era un rumore: ripartiamo da zero e aspettiamo qualcosa di più chiaro.
          candidatePeakDb = SILENCE_DB
          aboveSinceMs = now
        }
      }
      return
    }

    aboveSinceMs = 0
    candidatePeakDb = SILENCE_DB
    if (belowSinceMs === 0) belowSinceMs = now
    if (speaking && now - belowSinceMs >= options.hangoverMs) {
      speaking = false
      callbacks.onSpeechEnd?.()
    }
  }, POLL_INTERVAL_MS)

  return {
    get isSpeechActive() {
      return speaking
    },
    get currentThresholdDb() {
      return thresholdDb
    },
    get noiseFloorDb() {
      return noiseFloorDb
    },
    stop() {
      if (stopped) return
      stopped = true
      window.clearInterval(timer)
      source.disconnect()
      analyser.disconnect()
      // Il contesto va chiuso, non solo sospeso: tiene aperto il thread audio.
      void context.close().catch(() => undefined)
    },
  }
}

/** Traduce dBFS in 0…1 per il meter. */
export function normalizeLevel(db: number): number {
  if (db <= SILENCE_DB) return 0
  const clamped = Math.min(Math.max(db, METER_MIN_DB), METER_MAX_DB)
  return (clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)
}
