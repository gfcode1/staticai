/**
 * Scoperta dei modelli gratuiti di OpenRouter.
 *
 * La lista **non è scritta a mano**, e questo è il punto: gli identificativi
 * gratuiti cambiano di continuo. Un modello viene ritirato, un altro diventa
 * gratuito, e un elenco scritto nel codice invecchia in settimane e si rompe
 * nel modo più fastidioso possibile: nessun errore, solo un modello che non
 * risponde più.
 *
 * Inoltre il suffisso `:free` non è un criterio affidabile. Nella lista reale
 * ci sono modelli gratuiti che non lo portano (`openrouter/free`,
 * `inclusionai/ling-3.1-flash`) e l'unico dato stabile è il prezzo.
 */

/** Endpoint pubblico: non richiede chiave e non ha limiti di uso. */
export const MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** Suffisso raccomandato per le richieste, per attribuzione e statistiche. */
export const HTTP_REFERER = 'https://github.com/vrm-chat'
export const HTTP_TITLE = 'Assistente VRM'

export interface ModelInfo {
  id: string
  name: string
  /** Token disponibili nella finestra di contesto. */
  contextLength: number
  /** Il provider dichiara il supporto agli strumenti? */
  supportsTools: boolean
}

interface RawModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  supported_parameters?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
}

/**
 * Modelli gratuiti che non servono a chattare.
 *
 * Sono endpoint per immagini, musica o moderazione: rispondono, ma non
 * producono una conversazione. Offrirli in un selettore sarebbe un'offerta
 * falsa — l'utente sceglie, preme invio e ricevono una risposta incomprensibile.
 */
const NON_CHAT = /lyria|whisper|tts-1|embedding|moderation|content-safety|guard|rerank|image/i

function isFree(raw: RawModel): boolean {
  const p = raw.pricing
  if (!p) return false
  // Entrambi i lati gratuiti: un modello con l'ingresso gratis e l'uscita a
  // pagamento sembra gratis e poi si paga senza accorgersene.
  return p.prompt === '0' && p.completion === '0'
}

function supportsTools(raw: RawModel): boolean {
  if (!Array.isArray(raw.supported_parameters)) return false
  const params = raw.supported_parameters.filter((p): p is string => typeof p === 'string')
  return params.includes('tools') || params.includes('tool_choice')
}

export function parseFreeModels(payload: unknown): ModelInfo[] {
  if (typeof payload !== 'object' || payload === null) return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []

  const found: ModelInfo[] = []
  for (const raw of data as RawModel[]) {
    if (typeof raw?.id !== 'string' || !isFree(raw) || NON_CHAT.test(raw.id)) continue
    found.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      contextLength: typeof raw.context_length === 'number' ? raw.context_length : 0,
      supportsTools: supportsTools(raw),
    })
  }
  // I modelli con più contesto prima: sono i più adatti a una conversazione
  // lunga, e la lista non deve sembrare arbitraria.
  return found.sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id))
}

/**
 * Modello di riserva se la rete non risponde.
 *
 * Non è una scelta: è il costo di non poter scaricare l'elenco. Se la richiesta
 * fallisce l'app continua a funzionare, e questo alias instrada sempre a un
 * modello gratuito senza che l'utente debba scegliere.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'openrouter/free', name: 'Modello gratuito (automatico)', contextLength: 200000, supportsTools: true },
]

export async function fetchFreeModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const response = await fetch(MODELS_URL, {
    // `null` e non `undefined`: con `exactOptionalPropertyTypes` la differenza
    // non è di stile, è un errore di compilazione.
    signal: signal ?? null,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Elenco modelli non raggiungibile (HTTP ${response.status}).`)
  const models = parseFreeModels(await response.json())
  return models.length > 0 ? models : FALLBACK_MODELS
}