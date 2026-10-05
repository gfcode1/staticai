/**
 * Pulizia del testo prima di passarlo alla sintesi vocale.
 *
 * Un modello linguistico scrive per gli occhi: usa markdown, emoji, link e
 * abbreviazioni. Letto ad alta voce diventa un disastro — il motore di sintesi
 * pronuncia "asterisco", "punto e virgola quadrato", oppure legge male il
 * simbolo. Qui ripuliamo tutto, ma **conservando la punteggiatura** (`,` `.` `!`
 * `?`), che è ciò che dà intonazione e ritmo alla voce.
 */

/** Sostituzioni testuali. L'ordine conta: prima le più lunghe. */
const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  // Markdown: immagini e link → solo il testo visibile
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'],
  // Riferimenti markdown [1] e stili residui
  [/\[\^?[^\]]{0,20}\](\([^)]*\))?/g, ''],
  // Tabelle: via i separatori
  [/\n\s*\|[-: |]+\|\s*\n/g, '. '],
  [/\|/g, ', '],
  // Blocchi di codice: togliamo gli spazi di indentazione
  [/`{1,3}[^`]*`{1,3}/g, ' '],
  // Decorazioni: asterischi, underscore e ~~ non si pronunciano mai, quindi si
  // eliminano a ogni livello, non solo alle coppie. Con un modello che ha
  // imparato il markdown dal 2023 è una difesa necessaria, non una pignoleria.
  // La tilde singola resta alla regola "circa": lì indica un'approssimazione.
  [/[~]{2,}/g, ''],
  [/[*_]/g, ''],
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}[-*+]\s+/gm, ''],
  // URL nudi: non si pronunciano
  [/\bhttps?:\/\/\S+/g, ' '],
  [/\bwww\.\S+/g, ' '],
  // Punteggiatura "forte" → la sua pronuncia
  [/[()[\]{}<>]/g, ' '],
  // Simboli che il TTS sbaglia o salta
  [/€/g, ' euro '],
  [/\$/g, ' dollari '],
  [/%/g, ' per cento '],
  [/°/g, ' gradi '],
  [/#/g, ' cancelletto '],
  [/@/g, ' chioccia '],
  [/&/g, ' e '],
  [/[+]/g, ' più '],
  [/~/g, ' circa '],
  [/=/g, ' uguale '],
  [/±/g, ' più meno '],
  [/\//g, ' virgola '],
  [/[–—]/g, ', '],
  [/[""]/g, ''],
  [/['']/g, ''],
]

/**
 * Caratteri di formattazione e combinanti: selettori di variazione (U+FE0F),
 * keycap (U+20E3), zero-width joiner, marchi bidi, BOM.
 *
 * Vanno rimossi **separatamente** dai blocchi di simboli perché sono caratteri
 * combinanti: metterli in un intervallo insieme ablocchi come le emoji dà un
 * risultato illusorio — U+FE0F non è un "blocco", è un modificatore che sparisce
 * da solo e lascia l'emoji o il simbolo spoglio.
 */
const INVISIBLE_AND_COMBINING =
  /[\uFE0E\uFE0F\u20E3\u200B-\u200F\u202A-\u202E\u2060-\u2064\u061C\u2066-\u2069\uFEFF]/gu

/**
 * Blocchi Unicode degli emoji e dei simboli decorativi.
 * Solo intervalli di code point "pieni", nessun carattere combinante.
 */
const SYMBOL_BLOCKS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}]/gu

/** Apostrofi e virgolette tipografiche: le normalizziamo all'ASCII. */
const APOSTROPHES = /[‘’ʼ]/g
const QUOTES = /[“”]/g

/**
 * Rende un testo pronunciabile.
 *
 * Restituisce una stringa vuota se non resta nulla di pronunciabile: è un
 * caso reale, non un errore — un modello può rispondere solo con un blocco di
 * codice o con un elenco puntato.
 */
export function sanitizeForSpeech(input: string): string {
  if (!input) return ''

  let text = input.normalize('NFC')

  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement)

  text = text
    .replace(INVISIBLE_AND_COMBINING, '')
    .replace(SYMBOL_BLOCKS, ' ')
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')

  // Sistemi di scrittura non latin: il TTS li legge in modo erratico o li salta.
  if (/[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text)) {
    text = text.replace(/[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ')
  }

  // Punteggiatura doppia e spazi: il TTS aggiunge le proprie pause.
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*(?=[,.;:!?])/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/([!?])\1+/g, '$1')
    .trim()

  return text
}

/** true se il testo contiene almeno una parola pronunciabile. */
export function hasSpeakableContent(input: string): boolean {
  return /[\p{L}\p{N}]/u.test(sanitizeForSpeech(input))
}
