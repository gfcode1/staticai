/**
 * Motore di wake word nel browser (port di `openwakeword_wasm`).
 *
 * Pipeline interamente locale via `onnxruntime-web`: chunk audio da 80 ms
 * (1280 campioni a 16 kHz) → melspettrogramma → embedding → testata della
 * parola chiave, con il VAD come conferma e non come trigger. L'audio non
 * lascia mai il computer: è il punto dell'intero modulo.
 *
 * Originale: https://github.com/dnavarrom/openwakeword_wasm (MIT), file
 * `src/WakeWordEngine.js`. La logica è invariata; qui è solo tipizzata e
 * adattata agli import ESM/TS del progetto. I passaggi delicati — la
 * normalizzazione mel (`/ 10 + 2`), il buffer di 76 frame con shift di 8, la
 * copia di `.data` (ORT riusa i buffer di output) — sono gli stessi, con il
 * perché nel commento dove conta.
 */

import * as ort from 'onnxruntime-web'

import { inferKeywordWindowSize, resolveWakeAssetUrl } from './wakeWordConfig'
import type { WakeKeyword } from './wakeWordConfig'

export type WakeWordEvent = 'ready' | 'detect' | 'speech-start' | 'speech-end' | 'error'

export interface WakeDetection {
  keyword: string
  score: number
  at: number
}

type EmitterHandler = (payload: never) => void

function createEmitter(): {
  on(event: WakeWordEvent, handler: (payload: never) => void): () => void
  emit(event: WakeWordEvent, payload?: unknown): void
} {
  const listeners = new Map<WakeWordEvent, Set<EmitterHandler>>()
  return {
    on(event, handler) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler as EmitterHandler)
      return () => {
        listeners.get(event)?.delete(handler as EmitterHandler)
      }
    },
    emit(event, payload?: unknown) {
      const set = listeners.get(event)
      if (!set) return
      for (const handler of Array.from(set)) handler(payload as never)
    },
  }
}

const AUDIO_PROCESSOR = `
class AudioProcessor extends AudioWorkletProcessor {
    bufferSize = 1280;
    _buffer = new Float32Array(this.bufferSize);
    _pos = 0;
    process(inputs) {
        const input = inputs[0][0];
        if (input) {
            for (let i = 0; i < input.length; i++) {
                this._buffer[this._pos++] = input[i];
                if (this._pos === this.bufferSize) {
                    this.port.postMessage(this._buffer);
                    this._pos = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('audio-processor', AudioProcessor);
`

export interface WakeWordEngineOptions {
  keywords?: WakeKeyword[]
  baseAssetUrl?: string
  frameSize?: number
  sampleRate?: number
  vadHangoverFrames?: number
  detectionThreshold?: number
  cooldownMs?: number
  executionProviders?: string[]
  embeddingWindowSize?: number
  debug?: boolean
}

interface KeywordState {
  session: ort.InferenceSession
  scores: number[]
  windowSize: number
  history: Float32Array[]
}

export class WakeWordEngine {
  private readonly keywords: WakeKeyword[]
  private readonly modelFiles: Record<string, string>
  private readonly baseAssetUrl: string
  private readonly frameSize: number
  private readonly sampleRate: number
  private readonly vadHangoverFrames: number
  readonly detectionThreshold: number
  private readonly cooldownMs: number
  private readonly executionProviders: string[]
  private readonly debug: boolean

  private readonly emitter = createEmitter()
  private melBuffer: Float32Array[] = []
  private embeddingWindowSize: number
  private activeKeywords: Set<string>
  private vadH: ort.Tensor | null = null
  private vadC: ort.Tensor | null = null
  private isSpeechActive = false
  private vadHangover = 0
  private mediaStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private gainNode: GainNode | null = null
  private processingQueue: Promise<void> = Promise.resolve()
  private coolingDown = false
  private loaded = false

  private melspecModel: ort.InferenceSession | null = null
  private embeddingModel: ort.InferenceSession | null = null
  private vadModel: ort.InferenceSession | null = null
  private keywordModels: Record<string, KeywordState> = {}

  constructor(options: WakeWordEngineOptions = {}, modelFiles: Record<string, string>) {
    this.keywords = options.keywords ?? ['hey_jarvis']
    this.modelFiles = modelFiles
    this.baseAssetUrl = options.baseAssetUrl ?? '/models'
    this.frameSize = options.frameSize ?? 1280
    this.sampleRate = options.sampleRate ?? 16000
    this.vadHangoverFrames = options.vadHangoverFrames ?? 12
    this.detectionThreshold = options.detectionThreshold ?? 0.5
    this.cooldownMs = options.cooldownMs ?? 2000
    // Solo WASM di proposito: i modelli di preprocessing usano custom ops che
    // i backend GPU non supportano, e WASM non richiede header COOP/COEP —
    // che su hosting statico non possiamo impostare.
    this.executionProviders = options.executionProviders ?? ['wasm']
    this.embeddingWindowSize = options.embeddingWindowSize ?? 16
    this.debug = options.debug ?? false
    this.activeKeywords = new Set(this.keywords)
  }

  on(event: 'detect', handler: (detection: WakeDetection) => void): () => void
  on(event: 'error', handler: (error: unknown) => void): () => void
  on(event: 'ready' | 'speech-start' | 'speech-end', handler: () => void): () => void
  on(event: WakeWordEvent, handler: (payload: never) => void): () => void {
    return this.emitter.on(event, handler)
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  get isRunning(): boolean {
    return this.workletNode !== null
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: this.executionProviders,
    }
    const resolve = (file: string): string => resolveWakeAssetUrl(this.baseAssetUrl, file)
    this.log('carico i modelli', sessionOptions)

    this.melspecModel = await ort.InferenceSession.create(resolve('melspectrogram.onnx'), sessionOptions)
    this.embeddingModel = await ort.InferenceSession.create(resolve('embedding_model.onnx'), sessionOptions)
    this.vadModel = await ort.InferenceSession.create(resolve('silero_vad.onnx'), sessionOptions)

    let maxWindowSize = this.embeddingWindowSize
    for (const keyword of this.keywords) {
      const file = this.modelFiles[keyword]
      if (!file) throw new Error(`Nessun modello configurato per "${keyword}".`)
      const session = await ort.InferenceSession.create(resolve(file), sessionOptions)
      const windowSize = inferKeywordWindowSize(session) ?? this.embeddingWindowSize
      maxWindowSize = Math.max(maxWindowSize, windowSize)
      const history: Float32Array[] = []
      for (let i = 0; i < windowSize; i += 1) history.push(new Float32Array(96).fill(0))
      this.keywordModels[keyword] = { session, scores: new Array<number>(50).fill(0), windowSize, history }
      this.log('modello parola chiave caricato', { keyword, file, windowSize })
    }
    this.embeddingWindowSize = maxWindowSize
    this.resetState()
    this.loaded = true
    this.emitter.emit('ready')
  }

  /**
   * Avvia il microfono dedicato alla wake word. Va chiamato da un gesto
   * utente: sia il permesso sia l'`AudioContext` lo richiedono.
   */
  async start({ deviceId, gain = 1.0 }: { deviceId?: string; gain?: number } = {}): Promise<void> {
    if (!this.loaded) throw new Error('Chiamare load() prima di start().')
    if (this.workletNode) return

    this.resetState()
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    })

    this.audioContext = new AudioContext({ sampleRate: this.sampleRate })
    const source = this.audioContext.createMediaStreamSource(this.mediaStream)
    this.gainNode = this.audioContext.createGain()
    this.gainNode.gain.value = gain

    const blob = new Blob([AUDIO_PROCESSOR], { type: 'application/javascript' })
    const workletUrl = URL.createObjectURL(blob)
    try {
      await this.audioContext.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }
    this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor')
    const node = this.workletNode

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data
      if (!chunk) return
      this.processingQueue = this.processingQueue
        .then(() => this.processChunk(chunk))
        .catch((error: unknown) => {
          this.emitter.emit('error', error)
        })
    }

    source.connect(this.gainNode)
    this.gainNode.connect(node)
    // Il worklet deve restare connesso alla destination per essere eseguito,
    // anche se non vogliamo sentire nulla: il gain è sul mic, non sugli altoparlanti.
    node.connect(this.audioContext.destination)
    this.log('microfono wake word avviato', { deviceId: deviceId ?? 'default', gain })
  }

  async stop(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      this.workletNode.disconnect()
      this.workletNode = null
    }
    if (this.gainNode) {
      this.gainNode.disconnect()
      this.gainNode = null
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close()
    }
    this.audioContext = null
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop()
      this.mediaStream = null
    }
    this.coolingDown = false
    this.log('motore fermato, microfono rilasciato')
  }

  /** Quali parole possono emettere `detect` senza ricaricare i modelli. */
  setActiveKeywords(keywords: string[]): void {
    const next = Array.isArray(keywords) && keywords.length > 0 ? keywords : this.keywords
    this.activeKeywords = new Set(next)
    this.log('parole attive aggiornate', Array.from(this.activeKeywords))
  }

  private resetState(): void {
    this.melBuffer = []
    const vadShape = [2, 1, 64]
    if (!this.vadH || !this.vadC) {
      this.vadH = new ort.Tensor('float32', new Float32Array(128).fill(0), vadShape)
      this.vadC = new ort.Tensor('float32', new Float32Array(128).fill(0), vadShape)
    } else {
      ;(this.vadH.data as Float32Array).fill(0)
      ;(this.vadC.data as Float32Array).fill(0)
    }
    this.isSpeechActive = false
    this.vadHangover = 0
    this.coolingDown = false
    for (const keyword of Object.keys(this.keywordModels)) {
      const state = this.keywordModels[keyword]
      state?.scores.fill(0)
      for (const vec of state?.history ?? []) vec.fill(0)
    }
  }

  private async processChunk(chunk: Float32Array, emitEvents = true): Promise<void> {
    const vadTriggered = await this.runVad(chunk)
    if (vadTriggered) {
      if (!this.isSpeechActive && emitEvents) this.emitter.emit('speech-start')
      this.isSpeechActive = true
      this.vadHangover = this.vadHangoverFrames
    } else if (this.isSpeechActive) {
      this.vadHangover -= 1
      if (this.vadHangover <= 0) {
        this.isSpeechActive = false
        if (emitEvents) this.emitter.emit('speech-end')
      }
    }

    await this.runInference(chunk, this.isSpeechActive, emitEvents)
  }

  private async runVad(chunk: Float32Array): Promise<boolean> {
    try {
      if (!this.vadModel || !this.vadH || !this.vadC) return false
      const tensor = new ort.Tensor('float32', chunk, [1, chunk.length])
      const sr = new ort.Tensor('int64', [BigInt(this.sampleRate)], [])
      const res = await this.vadModel.run({ input: tensor, sr, h: this.vadH, c: this.vadC })
      this.vadH = res['hn'] as ort.Tensor
      this.vadC = res['cn'] as ort.Tensor
      const output = res['output']
      const confidence = output?.data[0] as number | undefined
      if (typeof confidence === 'number') this.log('VAD', { confidence: Number(confidence.toFixed(3)) })
      return (confidence ?? 0) > 0.5
    } catch (error) {
      this.emitter.emit('error', error)
      return false
    }
  }

  private async runInference(chunk: Float32Array, isSpeechActive: boolean, emitEvents: boolean): Promise<void> {
    if (!this.melspecModel || !this.embeddingModel) return
    const melspecTensor = new ort.Tensor('float32', chunk, [1, this.frameSize])
    const melspecResults = await this.melspecModel.run({
      [this.melspecModel.inputNames[0] ?? 'input']: melspecTensor,
    })
    const melOutput = melspecResults[this.melspecModel.outputNames[0] ?? '']
    if (!melOutput) return
    // Normalizzazione del training: senza, i punteggi restano a zero anche
    // con audio perfetto. È il dettaglio che upstream documenta come critico.
    const newMelData = melOutput.data as Float32Array
    for (let j = 0; j < newMelData.length; j += 1) {
      newMelData[j] = newMelData[j]! / 10.0 + 2.0
    }
    for (let j = 0; j < 5; j += 1) {
      this.melBuffer.push(new Float32Array(newMelData.subarray(j * 32, (j + 1) * 32)))
    }

    while (this.melBuffer.length >= 76) {
      const windowFrames = this.melBuffer.slice(0, 76)
      const flattenedMel = new Float32Array(76 * 32)
      for (let j = 0; j < windowFrames.length; j += 1) {
        flattenedMel.set(windowFrames[j]!, j * 32)
      }

      const embeddingInputName = this.embeddingModel.inputNames[0] ?? 'input'
      const embeddingOut = await this.embeddingModel.run({
        [embeddingInputName]: new ort.Tensor('float32', flattenedMel, [1, 76, 32, 1]),
      })
      const embeddingOutput = embeddingOut[this.embeddingModel.outputNames[0] ?? '']
      if (!embeddingOutput) {
        this.melBuffer.splice(0, 8)
        continue
      }
      // ORT riusa i buffer di output fra le run: senza copia, la history
      // conterrebbe N volte lo stesso vettore e i punteggi sarebbero fermi.
      const embeddingVector = new Float32Array(embeddingOutput.data as Float32Array)

      for (const name of Object.keys(this.keywordModels)) {
        const keywordModel = this.keywordModels[name]
        if (!keywordModel) continue
        keywordModel.history.shift()
        keywordModel.history.push(embeddingVector)

        const flattenedEmbeddings = new Float32Array(keywordModel.windowSize * 96)
        for (let j = 0; j < keywordModel.history.length; j += 1) {
          flattenedEmbeddings.set(keywordModel.history[j]!, j * 96)
        }
        const keywordInputName = keywordModel.session.inputNames[0] ?? 'input'
        const results = await keywordModel.session.run({
          [keywordInputName]: new ort.Tensor('float32', flattenedEmbeddings, [
            1,
            keywordModel.windowSize,
            96,
          ]),
        })
        const scoreOutput = results[keywordModel.session.outputNames[0] ?? '']
        const score = (scoreOutput?.data[0] as number | undefined) ?? 0
        keywordModel.scores.shift()
        keywordModel.scores.push(score)

        const keywordActive = this.activeKeywords.has(name)
        if (
          emitEvents &&
          keywordActive &&
          score > this.detectionThreshold &&
          isSpeechActive &&
          !this.coolingDown
        ) {
          this.coolingDown = true
          this.emitter.emit('detect', { keyword: name, score, at: performance.now() })
          window.setTimeout(() => {
            this.coolingDown = false
          }, this.cooldownMs)
        }
      }
      // Finestra di training a passi di 8 frame, non 76: senza shift la
      // parola a cavallo di due finestre non verrebbe mai vista intera.
      this.melBuffer.splice(0, 8)
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.debug('[WakeWordEngine]', ...args)
  }
}
