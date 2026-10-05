import { estimateDuration } from './chunks'
import {
  buildVisemeTimeline,
  sampleTimeline,
  timelineLength,
  type VisemeWeights,
} from './visemes'

/**
 * Velocità di pronuncia iniziale, in caratteri al secondo.
 *
 * Non è una misura ma una **stima di partenza**, necessaria solo per il primo
 * chunk: dal secondo in poi il ritmo è calibrato su durate reali. Il valore
 * corrisponde a un parlato italiano a velocità normale (TTS `rate = 1`).
 */
export const DEFAULT_CHARS_PER_SECOND = 15

/**
 * Quante durate reali teniamo per la stima centrale.
 *
 * Una sola misura è fragile: se un chunk contiene una frase lunga o una
 * ripetizione, il ritmo calcolato da solo sbaglia e il lip-sync di quel chunk
 * deraglia. La mediana di più campioni scarta i valori anomali.
 */
const RATE_SAMPLES = 3

/** Quanto pesa la misura più recente sulla media: 0.5 = media pesata. */
const RATE_BLEND = 0.5

export interface LipSyncCalibration {
  charsPerSecond: number
  /** true se il ritmo è già stato misurato su chunk reali. */
  measured: boolean
  /** Numero di chunk finora cronometrati. */
  samples: number
}

/**
 * Guida i visemi nel tempo durante la pronuncia di un chunk.
 *
 * Il problema che risolve: il TTS del browser non dice *quando* arriva ogni
 * parola. Sappiamo quando inizia e quando finisce un chunk, e da lì stimiamo
 * dove siamo dentro il testo. Ogni chunk reale ci dà una misura del ritmo che
 * rende la stima successiva più precisa.
 */
export class TimedLipSync {
  private timeline: Float32Array = new Float32Array(0)
  private text = ''
  private startedAtMs = 0
  private durationMs = 0

  private charsPerSecond = DEFAULT_CHARS_PER_SECOND
  private readonly recentRates: number[] = []

  /** true se il ritmo deriva già da una durata realmente misurata. */
  private measured = false
  private samples = 0

  /** Attivo finché c'è un chunk in pronuncia. */
  private active = false

  /**
   * Prepara un chunk. `startMs` è lo stesso orologio usato poi in `sample()`.
   */
  start(text: string, startMs: number, predictedDurationMs?: number): void {
    this.text = text
    this.timeline = buildVisemeTimeline(text)
    this.startedAtMs = startMs

    const predicted = predictedDurationMs ?? estimateDuration(text, this.charsPerSecond) * 1000
    this.durationMs = Math.max(predicted, 1)
    this.active = true
  }

  /** Segnala la fine del chunk e calibra il ritmo sulla durata reale. */
  end(actualDurationMs: number): void {
    if (this.text.length > 0 && actualDurationMs > 150) {
      // Sotto 150 ms la misura è dominata dalla latenza di avvio del motore, non
      // dalla pronuncia: la ignoriamo.
      const measured = (this.text.length / actualDurationMs) * 1000
      this.recentRates.push(measured)
      if (this.recentRates.length > RATE_SAMPLES) this.recentRates.shift()
      this.charsPerSecond = this.recentRates.reduce((sum, rate) => sum + rate, 0) / this.recentRates.length
      this.measured = true
      this.samples += 1
    }
    this.text = ''
    this.timeline = new Float32Array(0)
    this.active = false
  }

  stop(): void {
    this.text = ''
    this.timeline = new Float32Array(0)
    this.active = false
  }

  get isActive(): boolean {
    return this.active
  }

  /**
   * Posizione nel testo, in caratteri, al tempo `nowMs`.
   *
   * Quando la durata prevista si rivela sbagliata — e succede quasi sempre sul
   * primo chunk — la posizione esce dall'intervallo [0, len]. La blocchiamo
   * agli estremi: oltre la fine la bocca si chiude, e un'alternativa sarebbe
   * ripartire da capo, che produrrebbe un tremito.
   */
  charPositionAt(nowMs: number): number {
    const length = timelineLength(this.timeline)
    if (length === 0) return 0
    const elapsedSeconds = Math.max(0, nowMs - this.startedAtMs) / 1000
    const position = elapsedSeconds * this.charsPerSecond
    return Math.min(position, length - 1)
  }

  /** 0 → 1 attraverso il chunk in pronuncia. */
  progressAt(nowMs: number): number {
    const length = timelineLength(this.timeline)
    if (length === 0 || this.durationMs <= 0) return 1
    return Math.min(1, Math.max(0, (nowMs - this.startedAtMs) / this.durationMs))
  }

  sample(nowMs: number): VisemeWeights {
    if (!this.active) return { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 }
    return sampleTimeline(this.timeline, this.charPositionAt(nowMs))
  }

  get currentCharsPerSecond(): number {
    return this.charsPerSecond
  }

  get calibration(): LipSyncCalibration {
    return { charsPerSecond: this.charsPerSecond, measured: this.measured, samples: this.samples }
  }

  /** Il testo del chunk in pronuncia, per la diagnostica. */
  get currentText(): string {
    return this.text
  }

  /** Riazzera la calibrazione: quando cambia voce o velocità. */
  resetCalibration(): void {
    this.recentRates.length = 0
    this.charsPerSecond = DEFAULT_CHARS_PER_SECOND
    this.measured = false
    this.samples = 0
  }

  /** Ricalibra a partire da un ritmo noto (per la velocità impostata a mano). */
  seedRate(charsPerSecond: number): void {
    if (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0) return
    this.charsPerSecond = charsPerSecond
    this.recentRates.length = 0
  }

  /** Mescola una nuova misura con la stima corrente (usata dai test). */
  static blend(base: number, measured: number): number {
    return base * (1 - RATE_BLEND) + measured * RATE_BLEND
  }
}
