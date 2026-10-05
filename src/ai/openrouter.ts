/**
 * Client di OpenRouter: chat in streaming.
 *
 * Parla il formato di OpenAI, che OpenRouter implementa, con l'aggiunta che
 * conta per noi è lo streaming: la risposta arriva a pezzi e possiamo far
 * parlare l'avatar mentre il modello scrive, invece di aspettare che finisca.
 *
 * La chiave non entra nel codice: arriva dall'interfaccia e vive solo in
 * `localStorage` su questo dispositivo.
 */

import { HTTP_REFERER, HTTP_TITLE } from './models'

export const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Quanti giri di strumenti prima di rinunciare.
 *
 * Quattro coprono le catene utili (chiedere il meteo, poi l'ora, poi
 * rispondere) e restano abbastanza sotto il punto in cui il ritardo diventa
 * fastidioso.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 4

/**
 * Quanti tentativi per una singola richiesta.
 *
 * Il 429 dei provider gratuiti èrumore, non un rifiuto: torna da solo in un
 * secondo. Fallo morire al primo colpo significa che una frase dell'utente
 * dipende da quanto è trafficato il servizio in quell'istante. Tre tentativi
 * coprono il caso tipico senza far aspettare chi ha parlato.
 */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Attesa di base del backoff esponenziale, in millisecondi. */
export const RETRY_BASE_MS = 500

/**
 * Tetto dell'attesa fra un tentativo e l'altro.
 *
 * Oltre qualche secondo, l'utente smette di distinguere "sta aspettando" da
 * "è impiantata" e ricomincia a premere il pulsante, che è il modo migliore per
 * peggiorare un rate limit già in corso.
 */
export const RETRY_MAX_MS = 8_000

/** Lo status vale la pena di ritentare: il provider è sopraffatto, non la richiesta. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * `Retry-After` del provider, se c'è.
 *
 * Va onorato: è il provider che sa quanto durerà il limite, e indovinare con
 * un backoff proprio durante un 429 significa rimettersi in coda per niente.
 * Accetta i secondi (la forma numerica) e la data HTTP.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null
  const grezzo = header.trim()
  if (grezzo === '') return null

  const secondi = Number(grezzo)
  if (Number.isFinite(secondi) && secondi >= 0) return Math.min(secondi * 1000, RETRY_MAX_MS)

  const quando = Date.parse(grezzo)
  if (Number.isNaN(quando)) return null
  return Math.max(0, Math.min(quando - Date.now(), RETRY_MAX_MS))
}

/**
 * Quanto aspettare prima del tentativo successivo.
 *
 * `retryAfter` vince quando c'è: è un dato, non una stima. Altrimenti crescita
 * esponenziale più un margene casuale — senza, due finestre che hanno ricevuto
 * lo stesso 429 ritentano all'identico millisecondo e il picco si ripete.
 */
export function backoffDelay(
  attempt: number,
  retryAfter: number | null = null,
  random: () => number = Math.random,
): number {
  if (retryAfter !== null) return retryAfter
  const esponenziale = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS)
  return Math.round(esponenziale * (0.7 + 0.6 * random()))
}

/** Attesa che si accorge subito dell'interruzione: durante il barge-in non si aspetta. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = (): DOMException => new DOMException('Attesa interrotta', 'AbortError')

    if (signal?.aborted) {
      reject(aborted())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(aborted())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Una POST che ritenta solo quando ha senso.
 *
 * I 4xx come 401 o 402 non si ritentano: la chiave è sbagliata o mancano
 * crediti, e riprovare tre volte fa solo aspettare l'utente per un errore che
 * non si risolve da solo. Il corpo della risposta non viene toccato finché non
 * si è deciso: `failureFromResponse` lo consuma, e va letto una volta sola.
 */
async function postWithRetry(
  model: string,
  init: RequestInit,
  attempts: number,
  signal?: AbortSignal,
): Promise<Response> {
  const tentativi = Math.max(1, attempts)

  for (let tentativo = 1; ; tentativo += 1) {
    const ultimo = tentativo >= tentativi

    let response: Response
    try {
      response = await fetch(CHAT_URL, init).catch((error: unknown) => {
        // Un'interruzione volontaria non è un errore di rete: va propagata com'è,
        // altrimenti l'interfaccia mostrerebbe "connessione persa" a ogni barge-in.
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw new ChatError('network', FAILURE_MESSAGES.network)
      })
    } catch (error) {
      // Solo la rete si ritenta: un errore di programmazione va in faccia subito.
      if (!(error instanceof ChatError) || ultimo) throw error
      await sleep(backoffDelay(tentativo), signal)
      continue
    }

    if (response.ok) return response

    if (!ultimo && isRetryableStatus(response.status)) {
      await sleep(backoffDelay(tentativo, parseRetryAfter(response.headers.get('retry-after'))), signal)
      continue
    }

    throw await failureFromResponse(response, model)
  }
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
  /**
   * Quando è stato scritto. Serve solo all'interfaccia e non viene mai inviato:
   * il provider non lo conosce, e mandarlo sarebbe rumore nella richiesta.
   */
  at?: number | undefined
  /** Nome dello strumento, per i messaggi di tipo `tool`. */
  name?: string
  /** Identificatore della chiamata, per collegare la risposta alla richiesta. */
  toolCallId?: string
  /** Chiamate agli strumenti richieste dal modello. */
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  /** Argomenti già decodificati. */
  arguments: Record<string, unknown>
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ChatFailure =
  | 'no-key'
  | 'bad-key'
  | 'no-credits'
  | 'rate-limited'
  | 'model-gone'
  | 'network'
  | 'server'

/** Errore con una causa distinguibile: l'interfaccia non deve indovinare dal testo. */
export class ChatError extends Error {
  readonly failure: ChatFailure

  constructor(failure: ChatFailure, message: string) {
    super(message)
    this.name = 'ChatError'
    this.failure = failure
  }
}

export const FAILURE_MESSAGES: Record<ChatFailure, string> = {
  'no-key': 'Serve una chiave OpenRouter per chattare. Apri le impostazioni in alto a sinistra.',
  'bad-key': 'La chiave OpenRouter non è valida. Controlla di averla copiata per intero.',
  'no-credits': 'OpenRouter dice che non ci sono crediti disponibili. Le richieste gratuite possono essere bloccate per il tuo account.',
  'rate-limited': 'Troppe richieste in poco tempo. Aspetta qualche secondo e riprova.',
  'model-gone': 'Questo modello non è più disponibile. Scegline un altro dalla lista.',
  network: 'Impossibile raggiungere OpenRouter. Controlla la connessione.',
  server: 'OpenRouter ha risposto con un errore. Riprova tra un momento.',
}

/**
 * Traduce lo status HTTP in una causa.
 *
 * OpenRouter risponde 400 anche quando è il modello a non esistere più, quindi
 * il corpo del messaggio va letto: è l'unico posto dove lo distingue.
 */
export async function failureFromResponse(response: Response, model: string): Promise<ChatError> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    /* il corpo non era JSON: il messaggiobelow resta vuoto */
  }

  if (response.status === 401) return new ChatError('bad-key', FAILURE_MESSAGES['bad-key'])
  if (response.status === 402) return new ChatError('no-credits', FAILURE_MESSAGES['no-credits'])
  if (response.status === 429) return new ChatError('rate-limited', FAILURE_MESSAGES['rate-limited'])
  if (response.status === 404) return new ChatError('model-gone', FAILURE_MESSAGES['model-gone'])
  if (/model/i.test(detail) && (response.status === 400 || response.status === 404)) {
    return new ChatError('model-gone', `Il modello ${model} non è disponibile: ${detail || 'verifica la lista.'}`)
  }
  if (response.status >= 500) return new ChatError('server', FAILURE_MESSAGES.server)
  return new ChatError('server', detail || `OpenRouter ha risposto con HTTP ${response.status}.`)
}

export interface StreamOptions {
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  signal?: AbortSignal
  /** Chiamato per ogni pezzo di testo. */
  onDelta?: (text: string) => void
  /** Restituisce il risultato di uno strumento, se il modello ne ha usato. */
  onToolCall?: (call: ToolCall) => Promise<string> | string
  /**
   * Quanti giri di strumenti consentire.
   *
   * Serve a fermare il caso in cui il modello non smette di chiedere strumenti:
   * ogni giro reinvia la cronologia, il modello risponde con un'altra chiamata e
   * il ciclo si ripete all'infinito, consumando crediti e memoria. Un limite
   * esplicito è l'unica protezione reale: fidarsi che il modello si fermi da
   * solo non funziona.
   */
  maxToolRounds?: number
  /**
   * Quanti tentativi per richiesta quando il provider è sopraffatto.
   *
   * Da notare che si sommano ai giri di strumenti: il tetto complessivo di
   * richieste per un turno è `maxAttempts × (maxToolRounds + 1)`, non il solo
   * `maxToolRounds`.
   */
  maxAttempts?: number
}

export interface StreamResult {
  text: string
  toolCalls: ToolCall[]
  /** Motivo della fine, se il flusso si è interrotto. */
  finishReason: string | null
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
}

/**
 * Accorpa i frammenti di uno strumento.
 *
 * In streaming gli argomenti di una chiamata arrivano a pezzi, divisi a metà
 * parole: `{"città":"` poi `Roma"}`. Vanno tenuti da parte e riuniti, altrimenti
 * ogni pezzo sembrerebbe JSON rotto.
 */
class ToolCallAccumulator {
  private readonly parts = new Map<number, { id: string; name: string; args: string }>()

  add(index: number, id?: string, name?: string, args?: string): void {
    const entry = this.parts.get(index) ?? { id: '', name: '', args: '' }
    if (id) entry.id = id
    if (name) entry.name = name
    if (args) entry.args += args
    this.parts.set(index, entry)
  }

  /** Testo da mettere nel messaggio dell'assistente per far proseguire il modello. */
  toMessage(): ToolCall[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, entry]) => ({
        id: entry.id || `call_${index}`,
        name: entry.name,
        arguments: parseArguments(entry.args),
      }))
  }
}

/** Gli argomenti possono essere arrivi a metà: JSON non valido non deve far cadere la risposta. */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Legge un flusso SSE e ricava i pezzi di testo.
 *
 * `fetch` non è un flusso di righe: un singolo `read()` può contenere mezzo
 * evento o tre eventi insieme. Per questo il buffer accumula e si divide solo
 * sui separatori `\n\n`, che sono i veri confini degli eventi.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        // Gli eventi possono arrivare come `data: {...}` su più righe.
        const payload = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (payload !== '') onEvent(payload)
        boundary = buffer.indexOf('\n\n')
      }
    }
    // Un flusso interrotto può lasciare un evento senza il separatore finale.
    const tail = buffer.trim()
    if (tail.startsWith('data:')) onEvent(tail.slice(5).trim())
  } finally {
    reader.releaseLock()
  }
}

/**
 * Esegue un turno di conversazione.
 *
 * `onDelta` riceve ogni pezzo di testo; la funzione risolve quando il modello
 * ha finito la risposta **o** quando ha chiesto uno strumento, nel qual caso
 * esegue `onToolCall` e rimanda il turno con il risultato.
 */
export async function streamChat(
  options: StreamOptions,
  /** Giro corrente: interno, serve solo al limite. */
  round = 0,
): Promise<StreamResult> {
  const { apiKey, model, messages, tools, signal, onDelta, onToolCall } = options
  const maxRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS

  if (apiKey.trim() === '') throw new ChatError('no-key', FAILURE_MESSAGES['no-key'])

  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => toWireMessage(m)),
    stream: true,
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  const response = await postWithRetry(
    model,
    {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': HTTP_REFERER,
        'X-Title': HTTP_TITLE,
      },
      body: JSON.stringify(body),
    },
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    signal,
  )

  if (!response.body) throw new ChatError('server', 'OpenRouter ha risposto senza corpo.')

  let text = ''
  let finishReason: string | null = null
  const calls = new ToolCallAccumulator()

  await readEventStream(response.body, (payload) => {
    if (payload === '[DONE]') return
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(payload) as StreamChunk
    } catch {
      // Righe che non sono JSON (banner, avvisi) non devono interrompere il flusso.
      return
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta !== '') {
      text += delta
      onDelta?.(delta)
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      calls.add(call.index ?? 0, call.id, call.function?.name, call.function?.arguments)
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
  })

  const toolCalls = calls.toMessage()

  // Il modello vuole uno strumento: lo eseguiamo e gli rimandiamo il risultato.
  if (toolCalls.length > 0 && onToolCall) {
    if (round >= maxRounds) {
      throw new ChatError(
        'server',
        `Il modello ha usato strumenti per ${maxRounds} giri di fila senza arrivare a una risposta. Interrompo qui.`,
      )
    }
    const history: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: text, toolCalls },
      ...(await Promise.all(
        toolCalls.map(async (call) => ({
          role: 'tool' as const,
          content: String(await onToolCall(call)),
          name: call.name,
          toolCallId: call.id,
        })),
      )),
    ]
    return streamChat({ ...options, messages: history }, round + 1)
  }

  return { text, toolCalls, finishReason }
}

/**
 * Riduce un messaggio al formato che il provider accetta.
 *
 * Non è un semplice passaggio: `at` esiste per l'interfaccia e non deve
 * finire sulla rete, e `toolCalls` va riscritto perché da oggetto diventa la
 * forma con gli argomenti serializzati come stringa.
 */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.name) wire.name = message.name
  if (message.toolCallId) wire.tool_call_id = message.toolCallId
  const calls = message.toolCalls
  if (calls && calls.length > 0) {
    wire.tool_calls = calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }))
  }
  return wire
}