/**
 * Helper di persistenza su localStorage.
 * Tutte le letture sono difensive: JSON corrotto o storage non disponibile
 * (modalità privata, quota esaurita) non devono mai far crashare l'app.
 */

/**
 * Legge da `localStorage` con ripiego.
 *
 * Distingue due failure che sembrano uguali e non lo sono: **dati corrotti** e
 * **codice rotto**. Un `try` che avvolge tutto ritorna al ripiego anche quando a
 * lanciare è una `ReferenceError` — per esempio una costante usata prima della
 * sua dichiarazione — e il risultato è che il bug sparisce e l'applicazione
 * riparte semplicemente vuota, senza un solo errore in console.
 *
 * Quindi il `try` copre solo lo storage e il JSON; il parser sta fuori. Se
 * lui lancia, è un difetto, e deve emergere.
 */
export function readJson<T>(key: string, parse: (raw: unknown) => T | null, fallback: T): T {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(key)
  } catch {
    // Modalità privata o storage negato.
    return fallback
  }
  if (raw === null) return fallback

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    // JSON non valido: dato corrotto, ripiego legittimo.
    return fallback
  }

  const parsed = parse(decoded)
  return parsed ?? fallback
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota esaurita o storage negato: la preferenza non viene salvata, pazienza */
  }
}

/** Accoda `save` e invialo al massimo una volta ogni `wait` ms. */
export function debounce(save: () => void, wait: number): () => void {
  let timer: number | undefined
  return () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(save, wait)
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}