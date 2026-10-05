import type { ExpressionRig } from '../vrm/expressionRig'
import { BLINK_WHILE_SPEAKING, SPEAKING_MOOD } from '../config'
import { splitIntoChunks } from './chunks'
import { DEFAULT_CHARS_PER_SECOND, TimedLipSync } from './lipSync'
import { sanitizeForSpeech } from './sanitize'
import { BrowserTts, cancelGrace, nowMs, type VoiceSettings } from './tts'
import { mouthOpenness, type VisemeWeights } from './visemes'

export type SpeechStatus = 'idle' | 'preparing' | 'speaking' | 'interrupted' | 'error'

export interface SpeechCallbacks {
  onStatus?: (status: SpeechStatus, detail?: string) => void
  /** Aggiornato a ogni frame durante la pronuncia. */
  onVisemes?: (weights: VisemeWeights) => void
  /** Un chunk è iniziato: testo, indice, durata prevista. */
  onChunk?: (index: number, total: number, text: string, predictedMs: number) => void
  /** Fine di tutto. */
  onFinished?: (interrupted: boolean) => void
}

/**
 * Orchestrazione di sintesi vocale e lip-sync.
 *
 * Tiene insieme tre cose che devono restare allineate:
 *  - il motore di sintesi, che dice solo *quando* inizia e finisce un chunk;
 *  - la timeline dei visemi, ricostruita dal testo;
 *  - il rig di espressioni, che va interrogato una volta per frame.
 *
 * Il nodo delicato è proprio la calibrazione: il primo chunk viene pronunciato
 * con una stima del ritmo, e dalla sua durata reale ricaviamo il ritmo per il
 * secondo, e così via.
 */
export class SpeechController {
  private readonly tts = new BrowserTts()
  private readonly lipSync = new TimedLipSync()

  private rig: ExpressionRig | null = null
  private status: SpeechStatus = 'idle'
  private chunkIndex = 0
  private chunkCount = 0
  private pendingCallbacks: SpeechCallbacks = {}

  /** Voci disponibili, ricaricate quando il browser le pubblica. */

  private lastWeights: VisemeWeights = { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 }
  private spoken: { text: string; at: number }[] = []

  /**
   * Se true l'avatar continua a lampeggiare mentre pronuncia.
   *
   * Il default viene da `config.ts` e non da qui: la casella del pannello e il
   * motore devono per forza concordare, altrimenti la casella direbbe "acceso"
   * mentre il motore sospende il blink, e nessuno dei due lo segnalerebbe. Se i
   * due valori vivessero in due posti, la verifica più onesta sarebbe accorgersi
   * che un utente con la casella accesa non vede l'avatar lampeggiare.
   */
  blinkWhileSpeaking = BLINK_WHILE_SPEAKING

  /**
   * true se siamo noi ad aver spento il blink automatico.
   * Se l'utente lo aveva già disattivato a mano, non lo riaccendiamo.
   */
  private blinkSuppressedByUs = false

  attachRig(rig: ExpressionRig): void {
    this.rig = rig
  }

  detachRig(rig: ExpressionRig): void {
    if (this.rig === rig) this.rig = null
  }

  get isSupported(): boolean {
    return this.tts.isSupported
  }

  get currentStatus(): SpeechStatus {
    return this.status
  }

  get isSpeaking(): boolean {
    return this.status === 'speaking' || this.status === 'preparing'
  }

  get currentVisemes(): VisemeWeights {
    return this.lastWeights
  }

  get calibrationCharsPerSecond(): number {
    return this.lipSync.currentCharsPerSecond
  }

  get chunkProgress(): { index: number; total: number } {
    return { index: this.chunkIndex, total: this.chunkCount }
  }

  /** Sblocca la sintesi: va chiamato da un clic o un tasto. */
  unlock(): void {
    this.tts.unlock()
  }

  /**
   * Pronuncia un testo, ripulendolo prima.
   *
   * Il testo può arrivare dalla risposta di un modello: markdown, elenchi,
   * emoji. `sanitizeForSpeech` lo rende pronunciabile, `splitIntoChunks` lo
   * divide in unità che Chrome riesce a pronunciare per intero.
   */
  async speak(rawText: string, settings: VoiceSettings, callbacks: SpeechCallbacks = {}): Promise<void> {
    if (!this.tts.isSupported) {
      callbacks.onStatus?.('error', 'Questo browser non supporta la sintesi vocale.')
      return
    }

    // Una nuova richiesta annulla la precedente in modo pulito.
    if (this.isSpeaking) await this.interrupt()

    const clean = sanitizeForSpeech(rawText)
    const chunks = splitIntoChunks(clean)
    // Registrata qui e non dopo l'attesa: `chunks` è ciò che il motore pronuncerebbe
    // davvero, che è la cosa da verificare.
    this.spoken.push({ text: clean, at: Date.now() })

    if (chunks.length === 0) {
      callbacks.onStatus?.('error', 'Non c\'è nulla di pronunciabile in questa risposta.')
      callbacks.onFinished?.(false)
      return
    }

    // La velocità impostata dall'utente scala il ritmo atteso: `rate` 1.2
    // significa circa il 20% di caratteri in più al secondo.
    this.lipSync.seedRate(DEFAULT_CHARS_PER_SECOND * settings.rate)

    this.pendingCallbacks = callbacks
    this.chunkIndex = 0
    this.chunkCount = chunks.length
    this.setStatus('preparing', callbacks)

    this.beginBlinkSuppression()
    // Un lampo di espressione all'attacco della frase: le sopracciglia che
    // salgono di qualche istante prima della prima parola. Costa una riga e
    // toglie l'effetto "attesa del computer" tra il testo e la voce.
    this.rig?.greetingFlash()

    await this.tts.speakChunks(chunks, settings, {
      onChunkStart: (text, index, atMs) => {
        this.chunkIndex = index
        // Il chunk corrente parte con la stima corrente, che a questo punto è
        // già calibrata sui chunk precedenti (o sulla velocità predefinita).
        this.lipSync.start(text, atMs)
        const predictedMs = estimateChunkMs(text, this.lipSync.currentCharsPerSecond)
        this.setStatus('speaking', callbacks)
        callbacks.onChunk?.(index, this.chunkCount, text, predictedMs)
      },
      onChunkEnd: (_text, _index, durationMs) => {
        this.lipSync.end(durationMs)
      },
      onIdle: () => {
        this.finish(false, callbacks)
      },
      onError: (message) => {
        this.finish(true, callbacks, message)
      },
    })

    // `speakChunks` può tornare per un'interruzione senza aver chiamato `onIdle`.
    if (this.status === 'preparing' || this.status === 'speaking') {
      this.finish(this.tts.wasCancelled, callbacks)
    }
  }

  /**
   * Da chiamare **una volta per frame** dal render loop.
   *
   * Ordine rispetto a `vrm.update()`: il lip-sync va impostato prima, così i
   * pesi entrano nei morph target nello stesso frame in cui vengono calcolati.
   */
  update(): void {
    if (!this.rig) return
    // Il sorriso di fondo segue l'attività della voce: presente mentre parla,
    // assente appena tace. Fuori dal parlato il viso resta neutro, che è la
    // posizione giusta per un'assistente in attesa.
    this.rig.setSpeakingMood(this.lipSync.isActive ? SPEAKING_MOOD.weight : 0)

    if (!this.lipSync.isActive) {
      this.lastWeights = { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 }
      return
    }

    const weights = this.lipSync.sample(nowMs())
    this.lastWeights = weights
    this.rig.setVisemes(weights)
    this.pendingCallbacks.onVisemes?.(weights)
  }

  /** Apertura della bocca, 0 → 1. Serve al meter della UI. */
  get openness(): number {
    return mouthOpenness(this.lastWeights)
  }

  /** Sospende la pronuncia, conservando la posizione. */
  pause(): void {
    this.tts.pause()
  }

  resume(): void {
    this.tts.resume()
  }

  /** Interrompe subito: usato dal barge-in quando l'utente inizia a parlare. */
  async interrupt(): Promise<void> {
    if (!this.isSpeaking) return
    this.tts.interrupt()
    this.lipSync.stop()
    // Chrome scarta la `speak()` successiva se arriva subito dopo `cancel()`.
    await cancelGrace()
    this.finish(true, this.pendingCallbacks)
  }

  /**
   * Frasi pronunciate fin dall'avvio, con il testo.
   *
   * In un browser di test non c'è audio da ascoltare, ma la coda di frasi si
   * può comunque verificare: è il punto in cui uno streaming mal segmentato
   * diventerebbe voce spezzata, e non si vede guardando il testo a video.
   */
  get spokenLog(): { text: string; at: number }[] {
    return this.spoken
  }

  dispose(): void {
    this.tts.interrupt()
    this.tts.dispose()
    this.lipSync.stop()
  }

  private setStatus(status: SpeechStatus, callbacks: SpeechCallbacks): void {
    this.status = status
    callbacks.onStatus?.(status)
  }

  private finish(interrupted: boolean, callbacks: SpeechCallbacks, error?: string): void {
    this.lipSync.stop()
    this.rig?.silence()
    this.endBlinkSuppression()
    this.status = interrupted ? 'interrupted' : 'idle'
    callbacks.onStatus?.(this.status, error)
    callbacks.onFinished?.(interrupted)
    this.pendingCallbacks = {}
  }

  /**
   * Sospende il blink automatico mentre l'avatar parla, se l'utente l'ha chiesto.
   *
   * Lampeggiare a metà frase distrae qualcuno, quindi l'opzione esiste. Ma solo
   * se l'utente non lo aveva già disattivato a mano: se lo spegne lui, resta
   * spento anche al termine della frase.
   */
  private beginBlinkSuppression(): void {
    if (this.blinkWhileSpeaking || !this.rig) return
    this.blinkSuppressedByUs = this.rig.isAutoBlinkEnabled
    if (this.blinkSuppressedByUs) this.rig.setAutoBlink(false)
  }

  private endBlinkSuppression(): void {
    if (!this.blinkSuppressedByUs || !this.rig) return
    this.rig.setAutoBlink(true)
    this.blinkSuppressedByUs = false
  }
}

function estimateChunkMs(text: string, charsPerSecond: number): number {
  return (text.length / Math.max(charsPerSecond, 1)) * 1000
}

/**
 * Istanza condivisa.
 *
 * Il controller unisce TTS e rig di espressioni, che vive dentro il render loop
 * di three.js: due mondi che non hanno un punto d'incontro naturale. Un modulo
 * con una sola istanza è il modo più semplice per collegarli senza alzare il
 * livello di indirezione.
 */
export const speech = new SpeechController()
