/**
 * Strumenti che l'assistente può usare: ora e meteo.
 *
 * Due vincoli hanno guidato ogni scelta qui.
 *
 * Il primo è che **il risultato verrà letto ad alta voce**. Un insieme di dati
 * grezzi tipo `{"temperature_2m":19.6,"weather_code":3}` fa rispondere bene il
 * modello e fa rispondere male l'utente: arriva tutto in italiano, in frasi
 * intere. Ogni strumento qui restituisce una frase già leggibile, perché è il
 * modello a pronunciarla senza doverla riformulare.
 *
 * Il secondo è che **uno strumento può fallire**, e un modello che riceve un
 * errore generico lo riempie di invenzioni. Perciò ogni errore torna come una
 * frase comprensibile: "non ho trovato il paese" è una risposta che l'assistente
 * può pronunciare, un `HTTP 502` no.
 */

import type { ToolCall, ToolSpec } from './openrouter'
import type { Memory } from '../memory/memory'
import { describePending, describeReminderCreated, type Reminder } from '../memory/reminders'

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/* --------------------------------------------------------------- geocodifica */

export interface Place {
  name: string
  region: string | null
  country: string | null
  latitude: number
  longitude: number
  timezone: string
}

/**
 * Il payload reale di Open-Meteo chiama la regione `admin1`, non `region`.
 * Mapparla qui invece che ai call site evita che un nome di campo sbagliato
 * viaggi silenziosamente: `regione` resterebbe `undefined` e la frase
 * direbbe "A Roma" senza mai dire dove.
 */
interface RawPlace {
  name?: unknown
  admin1?: unknown
  country?: unknown
  latitude?: unknown
  longitude?: unknown
  timezone?: unknown
}

function toPlace(raw: RawPlace): Place | null {
  const { name, latitude, longitude, timezone } = raw
  if (
    typeof name !== 'string' ||
    typeof timezone !== 'string' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude)
  ) {
    return null
  }
  return {
    name,
    region: typeof raw.admin1 === 'string' ? raw.admin1 : null,
    country: typeof raw.country === 'string' ? raw.country : null,
    latitude,
    longitude,
    timezone,
  }
}

/**
 * Cerca un luogo per nome.
 *
 * Open-Meteo ordina i risultati per importanza, quindi "Roma" dà prima Roma e
 * poi la Romania. Non si sceglie a caso: si preferisce il risultato dello stesso
 * Paese della lingua dell'utente, e solo in assenza di quello il primo. Chiedere
 * "che tempo fa a Roma" e ricevere il meteo di Botoșani sarebbe corretto dal
 * punto di vista dell'API e sbagliato da quello dell'utente.
 */
export async function findPlace(query: string, signal?: AbortSignal, locale = 'it'): Promise<Place | null> {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=6&language=${encodeURIComponent(locale)}&format=json`
  // `fetch` rigetta su connessione caduta: senza questa protezione l'errore
  // attraversa e fa fallire l'intero turno, invece di restare una frase che il
  // modello può pronunciare.
  const response = await fetch(url, { signal: signal ?? null }).catch(() => null)
  if (!response || !response.ok) return null

  const body = (await response.json()) as { results?: unknown }

  // Solo i risultati davvero utilizzabili: senza coordinate numeriche finite la
  // richiesta meteo partirebbe con `latitude=undefined` e tornerebbe un errore
  // che l'utente non può interpretare. Meglio dire che il luogo non esiste.
  const results = (Array.isArray(body.results) ? body.results : [])
    .map((r) => toPlace(r as RawPlace))
    .filter((r): r is Place => r !== null)
  if (results.length === 0) return null

  const primo = results[0]
  if (!primo) return null
  return results.find((r) => r.country === primo.country) ?? primo
}

/* ------------------------------------------------------------ codici WMO */

/**
 * Codici meteorologici WMO in italiano.
 *
 * Sono numeri, e un numero non si può pronunciare: senza questa mappa il
 * modello direbbe "weather code 3", che è la definizione di una risposta
 * inutile.
 */
const WMO: Record<number, string> = {
  0: 'sereno',
  1: 'prevalentemente sereno',
  2: 'parzialmente nuvoloso',
  3: 'nuvoloso',
  45: 'nebbia',
  48: 'nebbia con brina',
  51: 'pioviggine leggera',
  53: 'pioviggine',
  55: 'pioviggine intensa',
  56: 'pioviggine gelata',
  57: 'pioviggine gelata intensa',
  61: 'pioggia leggera',
  63: 'pioggia',
  65: 'pioggia forte',
  66: 'pioggia gelata',
  67: 'pioggia gelata forte',
  71: 'neve leggera',
  73: 'neve',
  75: 'neve forte',
  77: 'granelli di neve',
  80: 'piogge brevi',
  81: 'piogge',
  82: 'piogge violente',
  85: 'nevi leggere',
  86: 'nevi forti',
  95: 'temporale',
  96: 'temporale con grandine',
  99: 'temporale con grandine forte',
}

export function describeWeatherCode(code: number | undefined): string {
  if (typeof code !== 'number' || Number.isNaN(code)) return 'condizioni non note'
  return WMO[code] ?? `condizioni non note (codice ${code})`
}

/* -------------------------------------------------------------------- ora */

function zoneOra(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome'
  } catch {
    return 'Europe/Rome'
  }
}

/**
 * Ora locale, detta per come la si dice.
 *
 * "Sono le 14 e 35 di giovedì 4 ottobre" e non "2026-10-04T14:35:00+02:00": il
 * primo si pronuncia, il secondo l'utente lo sente leggere a pezzi.
 */
export function formatOra(timeZone: string, at: Date = new Date()): string {
  try {
    const parti = new Intl.DateTimeFormat('it-IT', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)

    const get = (tipo: string): string => parti.find((p) => p.type === tipo)?.value ?? ''

    // L'ora va a due cifre, e la mezzanotte normalizzata. Senza questo, l'ICU
    // italiano restituisce "0" e l'utente sente "sono le 0 e 30"; altre
    // implementazioni restituiscono "24", che nessuno dice.
    const grezzo = get('hour')
    const ora = grezzo === '24' ? '00' : grezzo.padStart(2, '0')

    const minuti = get('minute')
    return `Sono le ${ora} e ${minuti} di ${get('weekday')} ${get('day')} ${get('month')}.`
  } catch {
    return "Non riesco a stabilire l'ora locale."
  }
}

/* ------------------------------------------------------------------ meteo */

interface Forecast {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    weather_code?: number
    wind_speed_10m?: number
  }
  daily?: {
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
  }
}

/**
 * Previsioni per un luogo.
 *
 * `current` per il tempo adesso, `daily` per i massimi e minimi di oggi e
 * domani: la domanda più comune è "che tempo fa", la seconda è "che tempo farà
 * domani", e con i soli dati attuali la seconda avrebbe una risposta inventata.
 */
export async function getForecast(
  place: Place,
  giorno: 'oggi' | 'domani',
  signal?: AbortSignal,
): Promise<string> {
  const url =
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&forecast_days=2'

  const response = await fetch(url, { signal: signal ?? null }).catch(() => null)
  if (!response || !response.ok) return `Non riesco a raggiungere il servizio meteo per ${place.name}.`

  const dati = (await response.json()) as Forecast
  const dove = place.region ? `${place.name}, ${place.region}` : place.name

  if (giorno === 'domani') {
    const code = dati.daily?.weather_code?.[1]
    const max = dati.daily?.temperature_2m_max?.[1]
    const min = dati.daily?.temperature_2m_min?.[1]
    if (typeof code !== 'number' || typeof max !== 'number' || typeof min !== 'number') {
      return `Non ho la previsione per domani a ${dove}.`
    }
    return `Domani a ${dove} si prevede ${describeWeatherCode(code)}, con temperature da ${Math.round(min)} a ${Math.round(max)} gradi.`
  }

  const c = dati.current
  if (!c || typeof c.temperature_2m !== 'number' || typeof c.weather_code !== 'number') {
    return `Non ho i dati attuali per ${dove}.`
  }

  const parti = [
    `A ${dove} adesso è ${describeWeatherCode(c.weather_code)} e ci sono ${Math.round(c.temperature_2m)} gradi.`,
  ]
  if (typeof c.apparent_temperature === 'number') {
    parti.push(`Però si sente come ${Math.round(c.apparent_temperature)} gradi.`)
  }
  if (typeof c.relative_humidity_2m === 'number') {
    parti.push(`Umidità ${Math.round(c.relative_humidity_2m)} per cento.`)
  }
  if (typeof c.wind_speed_10m === 'number' && c.wind_speed_10m >= 5) {
    parti.push(`Vento a ${Math.round(c.wind_speed_10m)} chilometri orari.`)
  }
  return parti.join(' ')
}

/**
 * Cosa sta facendo lo strumento, in italiano.
 *
 * Serve a riempire i due o tre secondi in cui lo strumento gira. Senza, l'utente
 * vede l'avatar fermo e non sa se l'assistente sta pensando, se la rete è
 * lenta o se è successo qualcosa. Il testo è volutamente grezzo e non viene
 * pronunciato: è un'indicatore, non una risposta.
 */
export function describeToolCall(call: ToolCall): string {
  const testo = (...valori: unknown[]): string =>
    valori.filter((v) => typeof v === 'string').join('').trim()

  if (call.name === TIME_TOOL.name) {
    const zona = testo(call.arguments.zona)
    return zona === '' ? "sta controllando l'ora" : `sta controllando l'ora a ${zona}`
  }
  if (call.name === WEATHER_TOOL.name) {
    const luogo = testo(call.arguments.luogo)
    const quando = call.arguments.quando === 'domani' ? 'domani' : 'adesso'
    return luogo === '' ? 'sta controllando il meteo' : `sta controllando il meteo a ${luogo} ${quando}`
  }
  if (call.name === REMEMBER_TOOL.name) return 'sta registrando un ricordo'
  if (call.name === FORGET_TOOL.name) return 'sta dimenticando qualcosa'
  if (call.name === REMINDER_TOOL.name) {
    const azione = testo(call.arguments.azione)
    if (azione === 'elenca') return 'sta leggendo i promemoria'
    if (azione === 'annulla') return 'sta annullando un promemoria'
    return 'sta impostando un promemoria'
  }
  return `sta usando ${call.name}`
}

/* ----------------------------------------------------------- definizioni */

export const TIME_TOOL: ToolSpec = {
  name: 'ora',
  description:
    "Ora e data attuali. Usalo per 'che ore sono', 'che giorno è', 'che data è'. Non serve per cronometri o fusi orari.",
  parameters: {
    type: 'object',
    properties: {
      zona: {
        type: 'string',
        description:
          'Nome della città o fuso orario, es. "Roma" o "Europe/Rome". Ometti per usare il fuso orario del dispositivo.',
      },
    },
    required: [],
  },
}

export const WEATHER_TOOL: ToolSpec = {
  name: 'meteo',
  description:
    "Tempo attuale e previsioni per una città. Usalo per 'che tempo fa', 'che tempo farà domani', 'piove a ...'. Non prevedere il tempo senza chiamare questo strumento.",
  parameters: {
    type: 'object',
    properties: {
      luogo: { type: 'string', description: 'Nome della città, es. "Roma" o "Milano".' },
      quando: {
        type: 'string',
        enum: ['oggi', 'domani'],
        description: 'Oggi o domani. Se omesso, oggi.',
      },
    },
    required: ['luogo'],
  },
}

export const REMEMBER_TOOL: ToolSpec = {
  name: 'ricorda',
  description:
    "Salva un fatto che l'utente chiede di ricordare in futuro. Usalo solo quando l'utente dice esplicitamente 'ricorda che...' o 'ricordati di...'. Non usarlo per fatti che già hai nella cronologia di questa conversazione, e non usarlo per salvare cose che non sono fatti (per esempio 'sta piovendo').",
  parameters: {
    type: 'object',
    properties: {
      fatto: {
        type: 'string',
        description:
          "Il fatto in terza persona singolare e breve, es. 'vive a Milano', 'si chiama Giulia', 'preferisce risposte in breve'.",
      },
    },
    required: ['fatto'],
  },
}

export const FORGET_TOOL: ToolSpec = {
  name: 'dimentica',
  description:
    "Cancella un ricordo che l'utente non vuole più. Usalo quando dice 'dimentica...', 'non ricordare più...'. Con 'tutto' cancella ogni ricordo.",
  parameters: {
    type: 'object',
    properties: {
      cosa: {
        type: 'string',
        description:
          "Parte del ricordo da cancellare, es. 'Milano'. Scrivi 'tutto' per cancellarli tutti.",
      },
    },
    required: ['cosa'],
  },
}

export const REMINDER_TOOL: ToolSpec = {
  name: 'promemoria',
  description:
    "Imposta un promemoria che suonerà più tardi. Usalo quando l'utente dice 'ricordami fra...' o 'ricordami alle...'. Con azione 'elenca' mostra i promemoria in attesa, con 'annulla' li cancella. Non calcolare mai tu la scadenza: passa la frase originale in 'quando'.",
  parameters: {
    type: 'object',
    properties: {
      azione: {
        type: 'string',
        enum: ['crea', 'elenca', 'annulla'],
        description: 'Crea, elenca o annulla. Se omessa, crea.',
      },
      testo: {
        type: 'string',
        description: 'Cosa ricordare, es. "spegnere il forno". Serve per creare.',
      },
      quando: {
        type: 'string',
        description:
          'Quando, così come l\'ha detto l\'utente, es. "fra 10 minuti" o "alle 18:30". Serve per creare.',
      },
      cosa: {
        type: 'string',
        description: 'Parte del promemoria da annullare, es. "forno". Scrivi \'tutto\' per annullarli tutti.',
      },
    },
    required: [],
  },
}

export const TOOLS: ToolSpec[] = [TIME_TOOL, WEATHER_TOOL, REMEMBER_TOOL, FORGET_TOOL, REMINDER_TOOL]

/* -------------------------------------------------------------- esecuzione */

/**
 * Esegue uno strumento e restituisce testo da passare al modello.
 *
 * Il `try` non è pignolo: uno strumento che solleva un'eccezione porta via
 * l'intero turno, anche la parte di conversazione che è andata bene. Meglio una
 * frase di scuse pronunciabile che una risposta persa.
 */
export async function runTool(call: ToolCall, locale = 'it'): Promise<string> {
  try {
    return await esegui(call, locale)
  } catch {
    return `Non sono riuscito a usare lo strumento "${call.name}". Prova a chiedermelo in un altro modo.`
  }
}

async function esegui(call: ToolCall, locale: string): Promise<string> {
  if (call.name === TIME_TOOL.name) {
    const zona = typeof call.arguments.zona === 'string' ? call.arguments.zona.trim() : ''
    if (zona === '') return formatOra(zoneOra())

    if (zona.includes('/')) return formatOra(zona)

    const place = await findPlace(zona, undefined, locale).catch(() => null)
    if (!place) return `Non sono riuscito a trovare "${zona}".`
    return formatOra(place.timezone)
  }

  if (call.name === WEATHER_TOOL.name) {
    const luogo = typeof call.arguments.luogo === 'string' ? call.arguments.luogo.trim() : ''
    if (luogo === '') return 'Devo sapere il luogo: chiedi all\'utente di ripetere.'
    const quando = call.arguments.quando === 'domani' ? 'domani' : 'oggi'

    const place = await findPlace(luogo, undefined, locale).catch(() => null)
    if (!place) return `Non ho trovato "${luogo}". Prova con il nome della città.`
    return getForecast(place, quando)
  }

  return `Strumento sconosciuto: ${call.name}.`
}

/**
 * Come vengono eseguiti gli strumenti di memoria.
 *
 * Sono gli unici due che **scrivono** stato, quindi ricevono un'implementazione
 * di scrittura: senza, sarebbero strumenti che rispondono "fatto" senza fare
 * niente, che è peggio che non averli.
 */
export interface MemoryActions {
  add: (text: string) => Promise<{ memories: Memory[]; added: boolean; memory?: Memory | undefined }>
  remove: (query: string) => Promise<{ memories: Memory[]; removed: number }>
}

export async function runMemoryTool(
  call: ToolCall,
  actions: MemoryActions,
): Promise<string> {
  if (call.name === REMEMBER_TOOL.name) {
    const fatto = typeof call.arguments.fatto === 'string' ? call.arguments.fatto.trim() : ''
    if (fatto === '') return 'Non so che cosa ricordare: chiedi all\'utente di chiarire.'
    const esito = await actions.add(fatto)
    if (!esito.added) return `Lo ricordo già: "${fatto}".`
    return `Ricordato: ${fatto}.`
  }

  if (call.name === FORGET_TOOL.name) {
    const cosa = typeof call.arguments.cosa === 'string' ? call.arguments.cosa.trim() : ''
    if (cosa === '') return 'Non so che cosa dimenticare: chiedi all\'utente di chiarire.'
    const esito = await actions.remove(cosa)
    if (esito.removed === 0) return `Non avevo memorizzato niente su "${cosa}".`
    if (esito.removed === 1) return `Dimenticato: ${cosa}.`
    return `Dimenticati ${esito.removed} ricordi su "${cosa}".`
  }

  return `Strumento sconosciuto: ${call.name}.`
}

/**
 * Come vengono eseguiti i promemoria.
 *
 * Come gli strumenti di memoria, sono gli unici altri che **scrivono** stato
 * (l'elenco dei promemoria), quindi ricevono un'implementazione di scrittura:
 * senza, risponderebbero "fatto" senza aver impostato niente.
 */
export interface ReminderActions {
  add: (text: string, quando: string) => Promise<{ reminders: Reminder[]; reminder?: Reminder | undefined; error?: string | undefined }>
  remove: (query: string) => Promise<{ reminders: Reminder[]; removed: number }>
  list: () => Promise<{ reminders: Reminder[] }>
}

export async function runReminderTool(
  call: ToolCall,
  actions: ReminderActions,
): Promise<string> {
  const azione = typeof call.arguments.azione === 'string' ? call.arguments.azione.trim() : 'crea'

  if (azione === 'elenca') {
    const esito = await actions.list()
    return describePending(
      esito.reminders.filter((r) => r.dueAt > Date.now()).sort((a, b) => a.dueAt - b.dueAt),
    )
  }

  if (azione === 'annulla') {
    const cosa = typeof call.arguments.cosa === 'string' ? call.arguments.cosa.trim() : ''
    if (cosa === '') return 'Non so quale promemoria annullare: chiedi all\'utente di chiarire.'
    const esito = await actions.remove(cosa)
    if (esito.removed === 0) return `Non avevo nessun promemoria su "${cosa}".`
    if (esito.removed === 1) return `Promemoria annullato: ${cosa}.`
    return `Annullati ${esito.removed} promemoria su "${cosa}".`
  }

  const testo = typeof call.arguments.testo === 'string' ? call.arguments.testo.trim() : ''
  const quando = typeof call.arguments.quando === 'string' ? call.arguments.quando.trim() : ''
  if (testo === '' || quando === '') {
    return 'Mi serve cosa ricordare e quando: per esempio "ricordami fra 10 minuti di spegnere il forno".'
  }
  const esito = await actions.add(testo, quando)
  if (esito.error !== undefined || esito.reminder === undefined) {
    return esito.error ?? 'Non sono riuscito a impostare il promemoria.'
  }
  return describeReminderCreated(esito.reminder)
}