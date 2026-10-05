/**
 * Riconoscimento vocale del browser.
 *
 * `SpeechRecognition` è una Web API palesemente incompleta: non è standard, non
 * esiste in Firefox, in Chrome si chiama `webkitSpeechRecognition`, e ha una
 * lista di comportamenti che vanno compensati. Qui sotto ogni difetto è
 * annotato con il rimedio accanto.
 *
 * Nota sulla privacy: per impostazione predefinita l'audio viene **mandato ai
 * server di Google**. È il comportamento del browser e non è aggirabile da
 * JavaScript, salvo dove Chrome espone il riconoscimento on-device (vedi
 * il riconoscimento su dispositivo). Va detto all'utente, non nascosto.
 */

export type SttErrorKind =
  | 'not-allowed'
  | 'no-speech'
  | 'network'
  | 'language-not-supported'
  | 'aborted'
  | 'unsupported'
  | 'unknown'

export interface SttCallbacks {
  /** Risultato parziale, in continuo. */
  onInterim?: (text: string) => void
  /** Risultato definitivo. */
  onFinal?: (text: string) => void
  /** Errore con categoria e messaggio già in italiano. */
  onError?: (kind: SttErrorKind, message: string) => void
  /** Il motore è stato avviato davvero. */
  onStart?: () => void
  /** Il motore si è fermato (per sua decisione o per un restart). */
  onEnd?: () => void
}

export interface SttOptions {
  lang: string
}

export interface SttOptionsFull extends SttOptions {
  /**
   * Attesa prima del riavvio automatico.
   *
   * Chrome chiude il riconoscimento dopo un breve silenzio. Senza riavvio, una
   * conversazione lunga si bloccherebbe dopo la prima frase. I 120 ms servono a
   * dare tempo al motore di chiudere la sessione precedente: riavviare troppo
   * presto fa scattare `InvalidStateError`.
   */
  restartDelayMs: number
}

export const DEFAULT_STT_OPTIONS: SttOptionsFull = {
  lang: 'it-IT',
  restartDelayMs: 120,
}

/** Messaggi d'errore in italiano, per categoria. */
const ERROR_MESSAGES: Record<SttErrorKind, string> = {
  'not-allowed': 'Permesso del microfono negato. Consenti il microfono per usare il riconoscimento vocale.',
  'no-speech': 'Non ho sentito nulla. Riprova parlando più vicino al microfono.',
  network: 'Il servizio di riconoscimento vocale non è raggiungibile. Serve una connessione internet.',
  'language-not-supported': 'Il riconoscimento vocale per questa lingua non è disponibile.',
  aborted: 'Riconoscimento interrotto.',
  unsupported: 'Questo browser non supporta il riconoscimento vocale. Serve Chrome, Edge o Safari.',
  unknown: 'Errore imprevisto nel riconoscimento vocale.',
}

type SpeechRecognitionCtor = SpeechRecognitionConstructor

function recognitionConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export function isSpeechRecognitionSupported(): boolean {
  return recognitionConstructor() !== null
}

export class BrowserStt {
  private recognition: SpeechRecognition | null = null
  private readonly callbacks: SttCallbacks
  private options: SttOptionsFull

  /** true finché l'utente tiene premuto l'ascolto. */
  private active = false
  private stopping = false
  private restartTimer: number | null = null

  /** Trascrizione finale accumulata nella sessione di ascolto corrente. */
  private finalText = ''
  private interimText = ''

  constructor(callbacks: SttCallbacks = {}, options: Partial<SttOptionsFull> = {}) {
    this.callbacks = callbacks
    this.options = { ...DEFAULT_STT_OPTIONS, ...options }
  }

  setOptions(patch: Partial<SttOptionsFull>): void {
    this.options = { ...this.options, ...patch }
    // La lingua non si può cambiare a caldo su un'istanza viva: Chrome la legge
    // solo in `start()`. Se cambia, il riconoscimento riparte.
    if (patch.lang !== undefined && this.active) this.restartNow()
  }

  get isActive(): boolean {
    return this.active
  }

  /** Trascrizione completa di ciò che è stato riconosciuto finora. */
  get transcript(): string {
    return [this.finalText, this.interimText].filter(Boolean).join(' ').trim()
  }

  get interim(): string {
    return this.interimText
  }

  start(): boolean {
    if (this.active) return true

    const ctor = recognitionConstructor()
    if (!ctor) {
      this.callbacks.onError?.('unsupported', ERROR_MESSAGES.unsupported)
      return false
    }

    this.active = true
    this.stopping = false
    this.finalText = ''
    this.interimText = ''
    this.spawn(ctor)
    return true
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.stopping = true
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    // `abort()` e non `stop()`: `stop()` chiede al motore di finalizzare la frase
    // corrente e può rifiutarsi, lasciando il riconoscimento vivo.
    try {
      this.recognition?.abort()
    } catch {
      /* già fermo */
    }
    this.recognition = null
    this.interimText = ''
  }

  /** Svuota la trascrizione accumulata. */
  clear(): void {
    this.finalText = ''
    this.interimText = ''
  }

  dispose(): void {
    this.stop()
  }

  private spawn(ctor: SpeechRecognitionCtor): void {
    const recognition = new ctor()
    this.recognition = recognition

    recognition.lang = this.options.lang
    // `continuous` mantiene la sessione aperta: è noi che decidiamo quando
    // chiuderla, con il rilevamento dell'attività vocale.
    recognition.continuous = true
    // I risultati parziali sono ciò che rende l'esperienza viva: senza, l'utente
    // non vede nulla finché non ha finito di parlare.
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      this.callbacks.onStart?.()
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (!result) continue
        const alternative = result[0]
        if (!alternative) continue
        if (result.isFinal) {
          this.finalText = `${this.finalText} ${alternative.transcript}`.trim()
        } else {
          interim = `${interim} ${alternative.transcript}`.trim()
        }
      }
      this.interimText = interim
      if (interim) this.callbacks.onInterim?.(interim)
      else if (this.finalText) this.callbacks.onInterim?.('')
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const raw = event.error
      // `no-speech` è la Via normale del VAD: il motore si arrende perché
      // l'utente ha smesso di parlare, non è un errore da mostrare.
      if (raw === 'no-speech') {
        this.callbacks.onError?.('no-speech', ERROR_MESSAGES['no-speech'])
        return
      }
      if (raw === 'aborted') {
        // È la nostra `stop()`: nessun messaggio, nessun riavvio.
        return
      }
      const kind = normalizeErrorKind(raw)
      this.callbacks.onError?.(kind, ERROR_MESSAGES[kind])

      // Un errore di rete o di permesso non si risolve riavviando: da qui in poi
      // ogni tentativo fallirebbe allo stesso modo.
      if (kind === 'network' || kind === 'not-allowed' || kind === 'language-not-supported') {
        this.active = false
      }
    }

    recognition.onend = () => {
      this.callbacks.onEnd?.()
      this.recognition = null
      if (!this.active || this.stopping) return
      this.scheduleRestart(ctor)
    }

    try {
      recognition.start()
    } catch (error) {
      // `start()` su un'istanza già avviata solleva: capita quando un restart
      // scatta mentre il motore sta ancora chiudendo la sessione precedente.
      if (!isAlreadyStarted(error)) {
        this.active = false
        this.callbacks.onError?.('unknown', error instanceof Error ? error.message : ERROR_MESSAGES.unknown)
      }
    }
  }

  private scheduleRestart(ctor: SpeechRecognitionCtor): void {
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer)
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null
      if (!this.active || this.stopping) return
      this.spawn(ctor)
    }, this.options.restartDelayMs)
  }

  /** Riavvio immediato, senza attesa: serve quando cambia la lingua. */
  private restartNow(): void {
    this.stopping = false
    try {
      this.recognition?.abort()
    } catch {
      /* già fermo */
    }
    const ctor = recognitionConstructor()
    if (ctor && this.active) this.spawn(ctor)
  }
}

function normalizeErrorKind(raw: string): SttErrorKind {
  if (raw === 'not-allowed' || raw === 'service-not-allowed') return 'not-allowed'
  if (raw === 'no-speech') return 'no-speech'
  if (raw === 'network') return 'network'
  if (raw === 'language-not-supported') return 'language-not-supported'
  if (raw === 'aborted') return 'aborted'
  return 'unknown'
}

function isAlreadyStarted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError'
}
