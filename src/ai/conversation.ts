/**
 * Il turno di conversazione: dalla frase ascoltata alla voce dell'avatar.
 *
 * Qui vivono le tre cose che devono accadere in ordine ma non possono stare
 * in una sola funzione:
 *
 *  1. la richiesta al modello arriva in streaming;
 *  2. ogni frase finita viene **subito** pronunciata, senza aspettare la fine;
 *  3. le frasi si parlano una dopo l'altra, mai sovrapposte.
 *
 * Il punto 3 è il motivo di questo modulo. `SpeechController.speak` chiama
 * `speechSynthesis.cancel()` prima di ogni frase, quindi due chiamate
 * contemporanee non si accodano: si cancellano a vicenda e l'utente sente
 * l'ultima parte, perde le precedenti. La coda è una catena di promise, e la
 * serializzazione è gratis.
 */

import { streamChat, ChatError, FAILURE_MESSAGES, type ChatMessage, type ToolSpec } from './openrouter'
import { SpeakableTail } from './speakQueue'
import { describeToolCall, runMemoryTool, runTool, TOOLS } from './tools'
import type { ToolCall } from './openrouter'
import { speech } from '../speech/speechController'
import type { VoiceSettings } from '../speech/tts'
import { buildMessages, buildSystemPrompt } from '../memory/memory'
import { bumpProfile, forgetMemory, getState, rememberMemory } from '../store/appStore'
import type { ModelInfo } from './models'

export type ChatStatus = 'idle' | 'thinking' | 'streaming' | 'speaking'

export interface ChatCallbacks {
  onMessages: (messages: ChatMessage[]) => void
  onStatus: (status: ChatStatus) => void
  /** Testo della risposta mentre arriva, per mostrarlo subito a schermo. */
  onPartial: (text: string) => void
  onError: (message: string) => void
  /** Riempie le pause: "sta controllando il meteo". */
  onActivity: (activity: string | null) => void
  /** Aggiornato quando l'elenco dei modelli viene ricaricato. */
  onModels?: (models: ModelInfo[]) => void
}

/** Quanti messaggi di conversazione tenere. Oltre, il modello dimentica il contesto. */
const MAX_HISTORY = 20

export interface Session {
  /** Frase ascoltata da mandare al modello. */
  submit(text: string, apiKey: string, model: string, voice: VoiceSettings): Promise<void>
  /** Interrompe tutto: stream in corso e frasi in coda. */
  abort(): void
  /** Svuota la conversazione. */
  reset(): void
  /** È in corso qualcosa che va interrotto? */
  readonly busy: boolean
}

export function createConversation(callbacks: ChatCallbacks): Session {
  let history: ChatMessage[] = []
  /** Messaggi già mostrati, inclusi quelli dell'utente appena arrivati. */
  let stream: AbortController | null = null
  /** Coda di frasi da pronunciare: la testa è quella in corso di sintesi. */
  let queue: Promise<void> = Promise.resolve()

  const publish = (): void => callbacks.onMessages([...history])

  function abort(): void {
    stream?.abort()
    stream = null
    // La coda non si può annullare a metà: si svuota e si lascia finire la frase
    // in corso, che interromperebbe a metà una sillaba.
    queue = Promise.resolve()
    callbacks.onStatus('idle')
  }

  async function submit(
    text: string,
    apiKey: string,
    model: string,
    voice: VoiceSettings,
  ): Promise<void> {
    const frase = text.trim()
    if (frase === '') return
    if (stream) abort()

    history = [...history, { role: 'user', content: frase, at: Date.now() }]
    publish()

    // La cronologia si accorcia a MAX_HISTORY. Senza, una conversazione lunga
    // fa crescere la richiesta finché il modello la rifiuta per contesto
    // esaurito, e il rimedio (ricominciare) arriva nel momento peggiore.
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY)

    // Il prompt di sistema non entra nella cronologia: è un'istruzione
    // permanente, non un turno. Si ricostruisce a ogni invio perché i ricordi
    // possono essere cambiati dall'utente nel mezzo della conversazione.
    const { memories } = getState()
    const messages = buildMessages(
      history,
      buildSystemPrompt({ memories, now: new Date(), isFirstTurn: history.length === 1 }),
    )

    const controller = new AbortController()
    stream = controller
    callbacks.onStatus('thinking')

    let partial = ''
    // L'ultimo strumento avviato: `suTool` lo confronta nel `finally` per non
    // azzerare l'indicatore mentre un altro strumento sta ancora girando.
    let lastToolName: string | null = null
    const tail = new SpeakableTail()

    // Mentre il modello chiama uno strumento non c'è ancora testo da dire: lo
    // stato resta "thinking" perché è quello che sta succedendo davvero, e
    // fingerspellare un "sta controllando il meteo" inventato sarebbe rumore.
    const suTool = async (call: ToolCall): Promise<string> => {
      callbacks.onActivity(describeToolCall(call))
      try {
        if (call.name === 'ricorda' || call.name === 'dimentica') {
          return await runMemoryTool(call, {
            add: async (text) => {
              const esito = rememberMemory(text)
              return { memories: getState().memories, added: esito.added, memory: esito.memory }
            },
            remove: async (query) => {
              const removed = forgetMemory(query)
              return { memories: getState().memories, removed }
            },
          })
        }
        return await runTool(call, navigator.language || 'it')
      } finally {
        // Si azzera solo se nessun altro strumento è subentrato: gli strumenti
        // possono essere chiamati in parallelo e l'ultimo parla per tutti.
        if (call.name === lastToolName) callbacks.onActivity(null)
      }
    }

    const say = (fraseDaParlare: string): void => {
      if (fraseDaParlare.trim() === '') return
      queue = queue
        .then(() => speech.speak(fraseDaParlare, voice))
        .catch(() => {
          /* una frase non pronunciabile non deve fermare la conversazione */
        })
    }

    try {
      const result = await streamChat({
        apiKey,
        model,
        messages,
        tools: TOOLS,
        signal: controller.signal,
        onToolCall: suTool,
        onDelta: (delta) => {
          partial += delta
          callbacks.onPartial(partial)
          const coda = tail.push(delta)
          if (coda !== '') {
            callbacks.onStatus('speaking')
            say(coda)
          } else if (partial !== '') {
            callbacks.onStatus('streaming')
          }
        },
      })

      if (controller.signal.aborted) return

      const resto = tail.flush()
      if (resto !== '') say(resto)

      const finale = result.text.trim()
      if (finale !== '') {
        history = [...history, { role: 'assistant', content: finale, at: Date.now() }]
        publish()
      } else {
        callbacks.onError('Il modello ha risposto senza testo. Riprova con un altro modello.')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const message =
        error instanceof ChatError ? error.message : FAILURE_MESSAGES.server
      callbacks.onError(message)
      // La frase dell'utente resta nella cronologia: se si riprova non si
      // perderebbe quello che è stato detto.
    } finally {
      callbacks.onActivity(null)
      if (stream === controller) {
        stream = null
        if (speech.isSpeaking) callbacks.onStatus('speaking')
        else callbacks.onStatus('idle')
      }
    }
  }

  return {
    submit,
    abort,
    reset: () => {
      abort()
      // Una conversazione iniziata vale un punto nel profilo. Si conta qui e non
      // a ogni messaggio, altrimenti il numero racconterebbe quante frasi sono
      // state scambiate, non quante conversazioni sono avvenute.
      if (history.length > 0) bumpProfile('conversations')
      history = []
      publish()
    },
    get busy() {
      return stream !== null
    },
  }
}

export type { ToolSpec }