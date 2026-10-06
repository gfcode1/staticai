/**
 * Promemoria locali.
 *
 * Zero rete, zero chiavi: un promemoria è un testo con una scadenza,
 * salvato in `localStorage` come i ricordi. La scadenza si esprime in
 * italiano ("fra 10 minuti", "alle 18:30") e viene risolta in un timestamp
 * qui, in modo puro e verificabile — il modello passa la frase originale,
 * non un calcolo fatto a memoria.
 *
 * Come i ricordi, il testo è **una riga sola**: finisce in un messaggio
 * pronunciato ad alta voce, e un ritorno a capo aprirebbe la porta a
 * contenuti con l'aspetto di istruzioni.
 */

import { STORAGE_KEYS } from '../config'
import { readJson, writeJson } from '../store/persistence'

export interface Reminder {
  id: string
  /** Cosa ricordare, in breve e su una riga. */
  text: string
  /** Scadenza in millisecondi epoch. */
  dueAt: number
  /** Quando è stato creato, per ordinarlo. */
  createdAt: number
}

/** Oltre, l'elenco dei promemoria diventa un'agenda: non è questo il suo lavoro. */
export const MAX_REMINDERS = 20
/** Un singolo promemoria che riempie la frase è un errore, non un promemoria. */
const MAX_REMINDER_CHARS = 200
/** Oltre i 30 giorni la scadenza è quasi sempre un fraintendimento ("fra un anno"). */
const MAX_AHEAD_MS = 30 * 86_400_000

export const EMPTY_REMINDERS: Reminder[] = []

let counter = 0

/** Identificatore unico senza `crypto`: basta, e funziona anche su contesti non sicuri. */
function newId(): string {
  counter += 1
  return `r${Date.now().toString(36)}${counter.toString(36)}`
}

/** Il testo è una riga sola, come i ricordi: stessa minaccia, stesso oblò. */
export function cleanReminderText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_REMINDER_CHARS)
}

export function parseReminders(raw: unknown): Reminder[] | null {
  if (!Array.isArray(raw)) return null
  const out: Reminder[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Partial<Reminder>
    if (typeof r.id !== 'string' || typeof r.text !== 'string') continue
    if (typeof r.dueAt !== 'number' || !Number.isFinite(r.dueAt) || r.dueAt <= 0) continue
    const text = cleanReminderText(r.text)
    if (text === '') continue
    out.push({ id: r.id, text, dueAt: r.dueAt, createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0 })
  }
  return out.length > 0 ? out.slice(-MAX_REMINDERS) : null
}

export function loadReminders(): Reminder[] {
  return readJson(STORAGE_KEYS.reminders, parseReminders, EMPTY_REMINDERS)
}

export function saveReminders(reminders: Reminder[]): void {
  writeJson(STORAGE_KEYS.reminders, reminders.slice(-MAX_REMINDERS))
}

/* ------------------------------------------------------- risoluzione di "quando" */

/**
 * Risolve un'espressione italiana di scadenza in un timestamp.
 *
 * Capisce due forme, che coprono quasi tutto l'uso reale:
 * - relativa: "fra 10 minuti", "tra un'ora", "fra mezz'ora", "tra poco";
 * - assoluta: "alle 18", "alle 18:30", "domani alle 9", "alle 8 di sera".
 *
 * Un orario già passato oggi scatta domani: "alle 8" detto alle 9 non può
 * significare "un'ora fa". Restituisce `null` se non capisce — il chiamante
 * chiede di riformulare invece di inventare una scadenza.
 */
export function parseQuando(expr: string, now: Date = new Date()): number | null {
  const s = expr.trim().toLowerCase().replace(/\s+/g, ' ')
  if (s === '') return null
  const base = now.getTime()

  if (/^(tra poco|fra poco)$/.test(s)) return base + 5 * 60_000
  if (/un quarto d'ora/.test(s)) return base + 15 * 60_000
  if (/mezz.?ora/.test(s)) return base + 30 * 60_000

  const fra = s.match(/^(?:fra|tra)\s+(.+)$/)
  if (fra) {
    const resto = fra[1] ?? ''
    const m = resto.match(/^(un'|un|una|uno|\d+)\s*(secondo|secondi|minuto|minuti|ora|ore|giorno|giorni|settimana|settimane)\b/)
    if (!m) return null
    const quanto = m[1]
    const numero = quanto === "un'" || quanto === 'un' || quanto === 'una' || quanto === 'uno' ? 1 : Number.parseInt(quanto ?? '', 10)
    if (!Number.isFinite(numero) || numero <= 0 || numero > 10_000) return null
    const unita = m[2] ?? ''
    const fattore = unita.startsWith('second')
      ? 1_000
      : unita.startsWith('minut')
        ? 60_000
        : unita === 'ora' || unita === 'ore'
          ? 3_600_000
          : unita.startsWith('giorn')
            ? 86_400_000
            : 7 * 86_400_000
    const avanti = numero * fattore
    if (avanti > MAX_AHEAD_MS) return null
    return base + avanti
  }

  if (/^a\s+mezzogiorno\b/.test(s)) return alleOre(12, 0, s.includes('domani'), now)
  if (/^a\s+mezzanotte\b/.test(s)) {
    const domani = new Date(now)
    domani.setDate(domani.getDate() + 1)
    domani.setHours(0, 0, 0, 0)
    return domani.getTime()
  }
  {
    const una = s.match(/^(?:all'una|all una)\s*(di\s+mattina|di\s+pomeriggio|di\s+sera|di\s+notte|mattina|pomeriggio|sera|notte)?\s*(domani|oggi)?$/)
    if (una) {
      const meridiano = una[1] ?? ''
      const ore = /pomeriggio|sera|notte/.test(meridiano) ? 13 : 1
      return alleOre(ore, 0, (una[2] ?? '').includes('domani'), now)
    }
  }
  {
    const alle = s.match(/^(?:domani\s+)?alle\s+(\d{1,2})(?::(\d{2}))?\s*(di\s+mattina|di\s+pomeriggio|di\s+sera|di\s+notte|mattina|pomeriggio|sera|notte)?\s*(domani|oggi)?$/)
    if (alle) {
      let ore = Number.parseInt(alle[1] ?? '', 10)
      const minuti = alle[2] !== undefined ? Number.parseInt(alle[2], 10) : 0
      if (!Number.isFinite(ore) || ore > 23 || !Number.isFinite(minuti) || minuti > 59) return null
      const meridiano = alle[3] ?? ''
      if ((/pomeriggio|sera|notte/.test(meridiano)) && ore < 12) ore += 12
      const domani = s.startsWith('domani ') || (alle[4] ?? '') === 'domani'
      return alleOre(ore, minuti, domani, now)
    }
  }

  return null
}

/** Oggi a quell'ora, o domani se è già passata (o se chiesto esplicitamente). */
function alleOre(ore: number, minuti: number, domani: boolean, now: Date): number {
  const data = new Date(now)
  data.setHours(ore, minuti, 0, 0)
  if (domani || data.getTime() <= now.getTime()) data.setDate(data.getDate() + 1)
  return data.getTime()
}

/* ---------------------------------------------------------------- operazioni */

export interface AddOutcome {
  reminders: Reminder[]
  reminder?: Reminder | undefined
  /** Spiegazione parlabile quando non si è potuto creare. */
  error?: string | undefined
}

/**
 * Crea un promemoria.
 *
 * La scadenza si risolve qui, non nel modello: se non si capisce, l'errore
 * è una frase che chiede di riformulare — non un'eccezione e non un orario
 * inventato.
 */
export function addReminder(
  text: string,
  quandoExpr: string,
  existing: Reminder[],
  now: Date = new Date(),
): AddOutcome {
  const pulito = cleanReminderText(text)
  if (pulito === '') return { reminders: existing, error: 'Non so cosa devo ricordarti: dimmi il messaggio del promemoria.' }
  const dueAt = parseQuando(quandoExpr, now)
  if (dueAt === null) {
    return {
      reminders: existing,
      error: 'Non ho capito quando: dimmi per esempio "fra 10 minuti" oppure "alle 18:30".',
    }
  }
  if (existing.length >= MAX_REMINDERS) {
    return { reminders: existing, error: 'Hai già troppi promemoria in attesa: cancellane prima qualcuno.' }
  }
  const reminder: Reminder = { id: newId(), text: pulito, dueAt, createdAt: now.getTime() }
  return { reminders: [...existing, reminder], reminder }
}

/**
 * Cancella per somiglianza, come `forgetMemories`: l'utente dice "annulla il
 * promemoria del forno", non ripete il testo esatto. Con "tutto" li cancella tutti.
 */
export function cancelReminders(query: string, existing: Reminder[]): { reminders: Reminder[]; removed: number } {
  const q = query.trim().toLowerCase()
  if (q === '') return { reminders: existing, removed: 0 }
  if (q === 'tutto' || q === 'tutti') return { reminders: [], removed: existing.length }
  const rimasti = existing.filter((r) => !r.text.toLowerCase().includes(q))
  return { reminders: rimasti, removed: existing.length - rimasti.length }
}

/** Promemoria ancora futuri, dal più vicino. */
export function pendingReminders(existing: Reminder[], nowMs: number = Date.now()): Reminder[] {
  return existing.filter((r) => r.dueAt > nowMs).sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt)
}

/**
 * Separa gli scaduti dal resto. Gli scaduti escono dall'elenco: un promemoria
 * suona una volta sola, e al ricaricamento quelli rimasti indietro suonano
 * subito invece di perdersi in silenzio.
 */
export function popDue(existing: Reminder[], nowMs: number = Date.now()): { due: Reminder[]; rest: Reminder[] } {
  const due = existing.filter((r) => r.dueAt <= nowMs).sort((a, b) => a.dueAt - b.dueAt)
  if (due.length === 0) return { due, rest: existing }
  const ids = new Set(due.map((r) => r.id))
  return { due, rest: existing.filter((r) => !ids.has(r.id)) }
}

/* --------------------------------------------------------------- frasi parlate */

/** "fra 10 minuti", "alle 18:30", "domani alle 9": mai un timestamp ISO. */
export function formatScadenza(dueAt: number, nowMs: number = Date.now()): string {
  const diff = dueAt - nowMs
  if (diff <= 0) return 'adesso'
  if (diff < 60_000) return 'fra pochi secondi'
  if (diff < 60 * 60_000) {
    const minuti = Math.round(diff / 60_000)
    return minuti <= 1 ? 'fra un minuto' : `fra ${minuti} minuti`
  }
  const data = new Date(dueAt)
  const ora = data.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
  const oggi = new Date(nowMs)
  const stessoGiorno = data.getFullYear() === oggi.getFullYear() && data.getMonth() === oggi.getMonth() && data.getDate() === oggi.getDate()
  if (diff < 24 * 3_600_000 && stessoGiorno) return `alle ${ora}`
  const domani = new Date(oggi)
  domani.setDate(domani.getDate() + 1)
  const isDomani = data.getFullYear() === domani.getFullYear() && data.getMonth() === domani.getMonth() && data.getDate() === domani.getDate()
  if (isDomani) return `domani alle ${ora}`
  const giorno = data.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
  return `il ${giorno} alle ${ora}`
}

/** Conferma di creazione, già parlabile. */
export function describeReminderCreated(reminder: Reminder, nowMs: number = Date.now()): string {
  return `Promemoria impostato ${formatScadenza(reminder.dueAt, nowMs)}: ${reminder.text}.`
}

/** Elenco parlabile dei promemoria in attesa. */
export function describePending(pending: Reminder[], nowMs: number = Date.now()): string {
  if (pending.length === 0) return 'Non hai promemoria in attesa.'
  if (pending.length === 1) {
    const primo = pending[0]
    if (!primo) return 'Non hai promemoria in attesa.'
    return `Hai un promemoria ${formatScadenza(primo.dueAt, nowMs)}: ${primo.text}.`
  }
  const voci = pending.map((r) => `${r.text} (${formatScadenza(r.dueAt, nowMs)})`).join('; ')
  return `Hai ${pending.length} promemoria: ${voci}.`
}

/** Frase pronunciata alla scadenza: uno o più promemoria insieme. */
export function describeDue(due: Reminder[]): string {
  if (due.length === 0) return ''
  if (due.length === 1) return `Promemoria: ${due[0]?.text ?? ''}.`
  return `Hai ${due.length} promemoria: ${due.map((r) => r.text).join('; ')}.`
}

/* ---------------------------------------------------------------- scheduler */

/**
 * Controlla le scadenze a intervalli e consegna gli scaduti.
 *
 * Il `consume` fornito dal chiamante svuota gli scaduti dallo stato; `onDue`
 * li pronuncia e li mostra. Il primo controllo è immediato: così i promemoria
 * rimasti indietro durante la notte (o un ricaricamento) suonano subito.
 */
export function startReminderLoop(
  consume: () => Reminder[],
  onDue: (due: Reminder[]) => void,
  intervalMs = 15_000,
): () => void {
  const check = (): void => {
    const due = consume()
    if (due.length > 0) onDue(due)
  }
  check()
  const id = setInterval(check, intervalMs)
  return () => clearInterval(id)
}
