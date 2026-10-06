/**
 * Istanza condivisa del risveglio vocale.
 *
 * Un modulo con una sola istanza, come `speech` in `speechController.ts`: il
 * motore vive fuori da React (ha stream, AudioContext e code ORT) e due mondi
 * — pannello di controllo e sessione di ascolto — devono parlarci senza
 * alzare il livello di indirezione.
 *
 * Regola di convivenza con `ListeningSession`: **un solo microfono alla
 * volta**. Il motore di wake tiene uno stream persistente; la sessione ne
 * apre uno suo. Prima di avviare la sessione il motore va fermato, alla fine
 * va riavviato se il toggle è ancora attivo. Il push-to-talk manuale fa lo
 * stesso attraverso `suspendForManual()` / `resumeIfEnabled()`.
 */

import {
  WAKE_COOLDOWN_MS,
  WAKE_KEYWORDS,
  WAKE_MODEL_FILES,
  defaultWakeBaseUrl,
} from './wakeWordConfig'
import type { WakeKeyword } from './wakeWordConfig'
import type { WakeWordEngine } from './wakeWordEngine'

export type { WakeDetection } from './wakeWordEngine'
import type { WakeDetection } from './wakeWordEngine'

export type WakeStatus =
  | 'off'
  | 'loading'
  | 'listening-local'
  | 'detected'
  | 'suspended'
  | 'error'

export interface WakeWordCallbacks {
  onStatus?: (status: WakeStatus, detail?: string) => void
  onDetect?: (detection: WakeDetection) => void
  onError?: (message: string) => void
}

interface EnableOptions {
  keyword: WakeKeyword
  threshold: number
  base?: string
}

/**
 * Bip di conferma del risveglio, sintetizzato.
 *
 * Niente file audio bundled: due oscillatori brevi bastano a dire "ti ho
 * sentito, parla pure", e non aggiungono peso a `public/`.
 */
export function playWakeChime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const context = new Ctor()
    const at = context.currentTime
    for (const [offset, freq] of [
      [0, 880],
      [0.09, 1318.5],
    ] as const) {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, at + offset)
      gain.gain.exponentialRampToValueAtTime(0.25, at + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + offset + 0.12)
      osc.connect(gain)
      gain.connect(context.destination)
      osc.start(at + offset)
      osc.stop(at + offset + 0.14)
    }
    window.setTimeout(() => {
      void context.close().catch(() => undefined)
    }, 600)
  } catch {
    // Il chime è cortesia, non protocollo: se l'audio non parte, il risveglio resta valido.
  }
}

class WakeWordController {
  private engine: WakeWordEngine | null = null
  private unsubscribers: Array<() => void> = []
  private status: WakeStatus = 'off'
  private wanted = false
  private suspendedForManual = false
  private keyword: WakeKeyword = 'hey_jarvis'
  private threshold = 0.5
  private callbacks: WakeWordCallbacks = {}

  get currentStatus(): WakeStatus {
    return this.status
  }

  get isRunning(): boolean {
    return this.engine?.isRunning ?? false
  }

  setCallbacks(callbacks: WakeWordCallbacks): void {
    this.callbacks = callbacks
  }

  /** Parola e soglia correnti, per riallineare il motore senza ricaricarlo. */
  get activeKeyword(): WakeKeyword {
    return this.keyword
  }

  /**
   * Accende l'ascolto in background. Il caricamento dei modelli (~10 MB) e
   * di `onnxruntime-web` avviene qui, alla prima attivazione — mai all'avvio
   * dell'app — tramite import dinamico.
   */
  async enable(options: EnableOptions): Promise<void> {
    this.keyword = options.keyword
    this.threshold = options.threshold
    this.wanted = true
    this.suspendedForManual = false
    if (this.engine?.isRunning) {
      this.engine.setActiveKeywords([this.keyword])
      this.setStatus('listening-local')
      return
    }
    this.setStatus('loading')
    try {
      if (!this.engine) {
        const { WakeWordEngine } = await import('./wakeWordEngine')
        const baseAssetUrl = options.base ?? defaultWakeBaseUrl(import.meta.env.BASE_URL)
        this.engine = new WakeWordEngine(
          {
            keywords: [...WAKE_KEYWORDS],
            baseAssetUrl,
            detectionThreshold: this.threshold,
            cooldownMs: WAKE_COOLDOWN_MS,
            executionProviders: ['wasm'],
          },
          { ...WAKE_MODEL_FILES },
        )
        // La soglia vive nel costruttore: se cambia, il motore va ricreato.
        // La parola invece si commuta a caldo.
        this.attachEvents()
        await this.engine.load()
      } else {
        // Motore già caricato con un'altra soglia: lo ricreiamo per applicarla.
        await this.restartWithThreshold(options.base)
      }
      this.engine.setActiveKeywords([this.keyword])
      await this.engine.start()
      this.setStatus('listening-local')
    } catch (error) {
      this.wanted = false
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Permesso del microfono negato. Consenti il microfono per il risveglio vocale.'
          : error instanceof Error
            ? error.message
            : 'Risveglio vocale non avviato.'
      this.setStatus('error', message)
      this.callbacks.onError?.(message)
    }
  }

  async disable(): Promise<void> {
    this.wanted = false
    this.suspendedForManual = false
    await this.engine?.stop()
    this.setStatus('off')
  }

  /**
   * Il push-to-talk manuale sospende il background: due stream dal microfono
   * significherebbero due prompt e due contesti audio.
   */
  async suspendForManual(): Promise<void> {
    if (!this.wanted || !this.engine?.isRunning) return
    this.suspendedForManual = true
    await this.engine.stop()
    this.setStatus('suspended')
  }

  async resumeIfEnabled(): Promise<void> {
    if (!this.wanted || !this.suspendedForManual) return
    this.suspendedForManual = false
    try {
      await this.engine?.start()
      this.setStatus('listening-local')
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : 'Riavvio non riuscito.')
    }
  }

  /**
   * Ferma il motore prima di avviare la `ListeningSession` hands-free, senza
   * spegnere il toggle: alla fine dell'utterance il chiamante richiama
   * `resumeAfterUtterance()`.
   */
  async pauseForUtterance(): Promise<void> {
    await this.engine?.stop()
    this.setStatus('detected')
  }

  async resumeAfterUtterance(): Promise<void> {
    if (!this.wanted) {
      this.setStatus('off')
      return
    }
    try {
      await this.engine?.start()
      this.setStatus('listening-local')
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : 'Riavvio non riuscito.')
    }
  }

  setKeyword(keyword: WakeKeyword): void {
    this.keyword = keyword
    this.engine?.setActiveKeywords([keyword])
  }

  private async restartWithThreshold(base: string | undefined): Promise<void> {
    await this.engine?.stop()
    this.detachEvents()
    const { WakeWordEngine } = await import('./wakeWordEngine')
    const baseAssetUrl = base ?? defaultWakeBaseUrl(import.meta.env.BASE_URL)
    this.engine = new WakeWordEngine(
      {
        keywords: [...WAKE_KEYWORDS],
        baseAssetUrl,
        detectionThreshold: this.threshold,
        cooldownMs: WAKE_COOLDOWN_MS,
        executionProviders: ['wasm'],
      },
      { ...WAKE_MODEL_FILES },
    )
    this.attachEvents()
    await this.engine.load()
  }

  private attachEvents(): void {
    if (!this.engine) return
    this.unsubscribers = [
      this.engine.on('detect', (detection) => {
        this.callbacks.onDetect?.(detection)
      }),
      this.engine.on('error', (error) => {
        const message = error instanceof Error ? error.message : 'Errore del risveglio vocale.'
        this.callbacks.onError?.(message)
      }),
    ]
  }

  private detachEvents(): void {
    for (const unsub of this.unsubscribers) unsub()
    this.unsubscribers = []
  }

  private setStatus(status: WakeStatus, detail?: string): void {
    this.status = status
    this.callbacks.onStatus?.(status, detail)
  }
}

export const wakeWord = new WakeWordController()
