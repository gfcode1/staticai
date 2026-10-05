import { speech } from './speechController'
import { STT_LANG } from '../config'
import { BrowserStt, isSpeechRecognitionSupported, type SttErrorKind } from './stt'
import { isMicrophoneSupported, requestMicrophone, startVad, type VadHandle } from './vad'

/**
 * Quanto aspettiamo che il motore finalizzi la frase dopo che il VAD ha detto
 * "l'utente ha finito".
 *
 * Il VAD è più rapido del motore: quando il livello torna sotto soglia, la
 * parola finale è ancora in viaggio. Senza questo margine l'ultima parola
 * verrebbe persa.
 */
const FINALIZE_GRACE_MS = 320

/**
 * Oltre questo tempo dall'inizio dell'ascolto non inviamo più nulla.
 * Un utente che lascia il microfono acceso non deve ritrovarsi, un'ora dopo,
 * una frase campionata dal tavolo.
 */
const MAX_UTTERANCE_MS = 20_000

export type ListeningStatus =
  | 'idle'
  | 'unsupported'
  | 'requesting'
  | 'listening'
  | 'transcribing'
  | 'denied'
  | 'error'

export interface ListeningCallbacks {
  onStatus?: (status: ListeningStatus, detail?: string) => void
  /** Trascrizione parziale, in continuo. */
  onInterim?: (text: string) => void
  /** Frase completa riconosciuta: è il momento di mandarla all'AI. */
  onUtterance?: (text: string) => void
  /** Livello del microfono 0…1, ~50 volte al secondo. */
  onLevel?: (level: number) => void
  onError?: (kind: SttErrorKind, message: string) => void
  /** Il riconoscimento locale è stato spento perché il modello manca. */
  onProcessLocallyForcedOff?: () => void
}

export interface ListeningOptions {
  lang: string
}

/** Dettagli interni della sessione, per la diagnostica. */
export interface ListeningProbe {
  supported: boolean
  status: ListeningStatus
  streamActive: boolean
  vadActive: boolean
  vadSpeechActive: boolean
  vadThresholdDb: number
  vadNoiseFloorDb: number
  recognitionActive: boolean
  transcript: string
  interim: string
  /** Quante volte è stata aperta o chiusa la sessione: serve a contare i riavvii. */
  starts: number
  stops: number
}

/**
 * Sessione di ascolto: microfono + rilevamento attività + riconoscimento.
 *
 * Il ciclo è questo: l'utente tiene premuto → il VAD osserva il segnale → al
 * primo suono confermato parte il riconoscimento → quando il VAD ritorna sotto
 * soglia per 650 ms la frase è finita → si raccoglie la trascrizione e la si
 * consegna a chi ascolta.
 */
export class ListeningSession {
  private readonly callbacks: ListeningCallbacks
  private options: ListeningOptions

  private stream: MediaStream | null = null
  private vad: VadHandle | null = null
  private stt: BrowserStt

  private status: ListeningStatus = 'idle'
  private finalizeTimer: number | null = null
  private expiryTimer: number | null = null

  constructor(callbacks: ListeningCallbacks = {}, options: ListeningOptions = { lang: STT_LANG }) {
    this.callbacks = callbacks
    this.options = options

    this.stt = new BrowserStt(
      {
        onInterim: (text) => this.callbacks.onInterim?.(text),
        onError: (kind, message) => this.handleSttError(kind, message),
      },
      { lang: options.lang },
    )
  }

  get currentStatus(): ListeningStatus {
    return this.status
  }

  get isListening(): boolean {
    return this.status === 'listening'
  }

  /**
   * Stato interno della sessione.
   *
   * Serve a capire *dove* si blocca l'ascolto: permesso concesso ma VAD fermo,
   * VAD attivo ma riconoscimento mai partito, riconoscimento partito ma senza
   * rete. Sono tre guasti diversi con tre rimedi diversi, e l'interfaccia mostra
   * solo messaggi generici.
   */
  probe(): ListeningProbe {
    return {
      supported: isSpeechRecognitionSupported() && isMicrophoneSupported(),
      status: this.status,
      streamActive: (this.stream?.getTracks().filter((t) => t.readyState === 'live').length ?? 0) > 0,
      vadActive: this.vad !== null,
      vadSpeechActive: this.vad?.isSpeechActive ?? false,
      vadThresholdDb: this.vad?.currentThresholdDb ?? Number.NaN,
      vadNoiseFloorDb: this.vad?.noiseFloorDb ?? Number.NaN,
      recognitionActive: this.stt.isActive,
      transcript: this.stt.transcript,
      interim: this.stt.interim,
      starts: this.starts,
      stops: this.stops,
    }
  }

  setOptions(patch: Partial<ListeningOptions>): void {
    this.options = { ...this.options, ...patch }
    this.stt.setOptions({ lang: this.options.lang })
  }

  get isActive(): boolean {
    return this.vad !== null || this.stt.isActive || this.status === 'requesting'
  }

  /**
   * Apre la sessione. Va chiamata da un gesto utente: sia il permesso del
   * microfono sia l'`AudioContext` lo richiedono.
   */
  async start(): Promise<void> {
    if (this.isActive) return

    if (!isMicrophoneSupported()) {
      this.setStatus('unsupported', 'Questo browser non espone l’accesso al microfono.')
      return
    }
    if (!isSpeechRecognitionSupported()) {
      this.setStatus('unsupported', 'Questo browser non supporta il riconoscimento vocale. Serve Chrome o Edge.')
      return
    }

    this.starts += 1
    this.setStatus('requesting')

    try {
      this.stream = await requestMicrophone()
    } catch (error) {
      const denied = error instanceof DOMException && error.name === 'NotAllowedError'
      this.setStatus(denied ? 'denied' : 'error')
      this.callbacks.onError?.(
        denied ? 'not-allowed' : 'unknown',
        denied
          ? 'Permesso del microfono negato. Consenti il microfono per parlare con l’assistente.'
          : 'Impossibile aprire il microfono.',
      )
      return
    }

    // Barge-in: se l'avatar sta parlando, l'utente lo interrompe parlando.
    // Senza questo, il microfono raccoglierebbe la voce dell'avatar e la
    // trascriverebbe come se fosse sua.
    if (speech.isSpeaking) await speech.interrupt()

    this.stt.clear()

    try {
      this.vad = await startVad(this.stream, undefined, {
        onSpeechStart: () => {
          this.armExpiry()
          this.stt.start()
        },
        onSpeechEnd: () => {
          this.scheduleFinalize()
        },
        onLevel: (level) => this.callbacks.onLevel?.(level),
      })
    } catch (error) {
      this.teardown()
      this.setStatus('error')
      this.callbacks.onError?.('unknown', error instanceof Error ? error.message : 'Analisi audio non riuscita.')
      return
    }

    this.setStatus('listening')
  }

  /** Chiude la sessione e restituisce ciò che è stato riconosciuto. */
  stop(): string {
    this.stops += 1
    const text = this.stt.transcript
    this.teardown()
    this.setStatus('idle')
    this.callbacks.onInterim?.('')
    return text
  }

  dispose(): void {
    this.teardown()
  }

  /**
   * Il VAD ha detto che l'utente ha finito. Aspettiamo un istante che il motore
   * finalizzi, poi raccogliamo e chiudiamo.
   */
  private scheduleFinalize(): void {
    if (this.finalizeTimer !== null) return
    this.setStatus('transcribing')

    this.finalizeTimer = window.setTimeout(() => {
      this.finalizeTimer = null
      const text = this.stt.transcript.trim()
      this.teardown()
      this.setStatus('idle')

      if (text) {
        this.callbacks.onUtterance?.(text)
      } else {
        this.callbacks.onError?.('no-speech', 'Non sono riuscito a capire cosa hai detto. Riprova.')
      }
    }, FINALIZE_GRACE_MS)
  }

  private handleSttError(kind: SttErrorKind, message: string): void {
    if (kind === 'no-speech') {
      // Il VAD non ha visto parlato: non è un errore da segnalare, semplicemente
      // nella sessione non è successo niente. Torniamo semplicemente in ascolto.
      if (!this.isActive) this.setStatus('idle')
      return
    }
    if (kind === 'aborted') return

    this.callbacks.onError?.(kind, message)
    if (kind === 'not-allowed' || kind === 'network' || kind === 'language-not-supported') {
      this.teardown()
      this.setStatus(kind === 'not-allowed' ? 'denied' : 'error')
    }
  }

  /** Chiusura di tutto: stream, analisi audio, riconoscimento, timer. */
  private teardown(): void {
    if (this.finalizeTimer !== null) {
      window.clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
    if (this.expiryTimer !== null) {
      window.clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.stt.stop()
    this.vad?.stop()
    this.vad = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
  }

  private setStatus(status: ListeningStatus, detail?: string): void {
    this.status = status
    this.callbacks.onStatus?.(status, detail)
  }

  /**
   * Scadenza di sicurezza.
   *
   * Una sessione dimenticata aperta con il microfono attivo è sgradevole sotto
   * due aspetti: continua a registrare, e prima o poi qualcosa finisce nel
   * transcript. Se l'utente non parla entro `MAX_UTTERANCE_MS` dal primo suono,
   * la sessione si chiude da sola.
   */
  private starts = 0
  private stops = 0

  private armExpiry(): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer)
    this.expiryTimer = window.setTimeout(() => {
      this.expiryTimer = null
      if (!this.isActive) return
      const text = this.stt.transcript.trim()
      this.teardown()
      this.setStatus('idle')
      if (text) this.callbacks.onUtterance?.(text)
    }, MAX_UTTERANCE_MS)
  }
}
