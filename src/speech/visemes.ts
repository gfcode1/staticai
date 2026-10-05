import { VISEME_PRESETS, type VisemePreset } from '../config'

/**
 * Mappa carattere → forma della bocca.
 *
 * Il TTS del browser non restituisce fonemi né timestamp: su Chrome Linux
 * l'evento `boundary` proprio non scatta. L'unica informazione che abbiamo è il
 * testo in pronuncia e il tempo trascorso. Quindi **ricostruiamo l'articolazione
 * dal testo**: quale vocale sta suonando, e se la bocca è chiusa su una
 * labiale.
 *
 * Non è un fonema acustico ma un'approssimazione visiva, e per il viso è
 * sufficiente: quello che si vede è "bocca spalancata su A", "sorriso stretto su
 * I", "cerchietto su U".
 */

export type VisemeWeights = Record<VisemePreset, number>

export const NEUTRAL_WEIGHTS: VisemeWeights = { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 }

/** Vocale → preset. `y` italiana è una vocale e si pronuncia come `i`. */
const VOWELS: Readonly<Record<string, VisemePreset>> = {
  a: 'aa',
  e: 'ee',
  i: 'ih',
  o: 'oh',
  u: 'ou',
  y: 'ih',
}

/**
 * Labiali: durante la loro pronuncia le labbra sono chiuse.
 * `f` e `v` sono escluse di proposito — sono labiodentali, le labbra toccano i
 * denti ma la bocca non si chiude davvero, e una bocca rigidamente chiusa su
 * una "f" si legge come un errore.
 */
const LABIALS = new Set(['m', 'b', 'p'])

/** Plosive: breve chiusura della bocca prima della vocale successiva. */
const PLOSIVES = new Set(['t', 'd', 'k', 'g', 'c', 'q'])

/** Punteggiatura di frase: pausa in cui la bocca torna a riposo. */
const SENTENCE_MARKS = new Set(['.', '!', '?', '…'])

/** Punteggiatura di clausola: pausa breve, la bocca si chiude a metà. */
const CLAUSE_MARKS = new Set([',', ';', ':'])

/**
 * Finestra di ricerca della vocale, in caratteri.
 *
 * Le consonanti non vengono " pronunciate": ciò che le precede o le segue
 * modula la bocca. Guardando qualche posizione attorno troviamo la vocale che
 * il motore sta effettivamente pronunciando.
 */
const WINDOW = 3

/** Quanto cala l'intensità per ogni carattere di distanza dalla vocale. */
const DISTANCE_FALLOFF = 0.14

const WEIGHTS_PER_CHAR = VISEME_PRESETS.length

/**
 * Rimuove i segni diacritici: `à` → `a`, `ù` → `u`.
 * Necessario perché il TTS può ricevere testo accentato o no, e le due forme
 * devono produrre lo stesso viseme.
 */
function baseLetter(char: string): string {
  return char
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/**
 * Vocale più vicina entro la finestra, con l'intensità già attenuata dalla
 * distanza. `null` se nella finestra non c'è nessuna vocale.
 */
function nearestVowel(
  letters: readonly string[],
  index: number,
): { preset: VisemePreset; strength: number } | null {
  let best: { preset: VisemePreset; strength: number } | null = null

  for (let offset = 1; offset <= WINDOW; offset += 1) {
    for (const position of [index - offset, index + offset]) {
      const letter = letters[position]
      if (letter === undefined) continue
      const preset = VOWELS[letter]
      if (!preset) continue
      const strength = 0.95 - offset * DISTANCE_FALLOFF
      if (!best || strength > best.strength) best = { preset, strength }
    }
  }

  return best
}

/**
 * Pesi della bocca per **un** carattere del testo.
 *
 * L'ordine dei casi è importante: le regole esplicite sul carattere corrente
 * hanno la precedenza, e solo le posizioni " neutre" (consonanti non chiuse,
 * spazi, cifre) cercano la vocale vicina.
 */
export function weightsForChar(letters: readonly string[], index: number): VisemeWeights {
  const weights: VisemeWeights = { ...NEUTRAL_WEIGHTS }
  const letter = letters[index]
  if (letter === undefined) return weights

  const vowel = VOWELS[letter]
  if (vowel) {
    weights[vowel] = 0.95
    return weights
  }

  if (SENTENCE_MARKS.has(letter)) return weights // pausa: bocca chiusa

  const near = nearestVowel(letters, index)

  if (CLAUSE_MARKS.has(letter)) {
    if (near) weights[near.preset] = near.strength * 0.45
    return weights
  }

  if (LABIALS.has(letter)) {
    // Bocca chiusa, ma non rigida: un filo di apertura evita lo scatto a zero.
    weights.aa = 0.03
    return weights
  }

  if (PLOSIVES.has(letter)) {
    weights.aa = 0.05
    return weights
  }

  if (letter === 'f' || letter === 'v') {
    // Labiodentali: apertura minima ma reale.
    weights.aa = 0.22
    return weights
  }

  if (near) {
    weights[near.preset] = near.strength
    return weights
  }

  // Cifre, spazi, consonanti isolate: bocca appena socchiusa. Il valore basso ma
  // non nullo mantiene l'avatar vivo anche in una frase senza vocali vicine.
  weights.aa = 0.1
  return weights
}

/**
 * Timeline dei visemi per un chunk di testo.
 *
 * Precalcoliamo un vettore piatto di `caratteri × 5` pesi: in questo modo il
 * render loop non deve più decodificare il testo a ogni frame, deve solo
 * interpolare due indici.
 */
export function buildVisemeTimeline(text: string): Float32Array {
  const letters = splitLetters(text)
  const timeline = new Float32Array(letters.length * WEIGHTS_PER_CHAR)

  for (let i = 0; i < letters.length; i += 1) {
    const weights = weightsForChar(letters, i)
    const base = i * WEIGHTS_PER_CHAR
    for (let v = 0; v < WEIGHTS_PER_CHAR; v += 1) {
      const preset = VISEME_PRESETS[v]
      if (preset === undefined) continue
      timeline[base + v] = weights[preset]
    }
  }

  return timeline
}

/**
 * Decompone il testo in unità vocali.
 *
 * Le lettere con segni diacritici contano come **un solo** carattere: `à` deve
 * occupare lo stesso tempo di `a`, altrimenti l'articolazione rallenterebbe
 * sulle vocali accentate, che in italiano sono frequenti.
 */
function splitLetters(text: string): string[] {
  const out: string[] = []
  for (const char of text) {
    const base = baseLetter(char)
    if (base.length === 0) continue
    out.push(base)
  }
  return out
}

/** Numero di posizioni nella timeline, cioè i caratteri effettivi. */
export function timelineLength(timeline: Float32Array): number {
  return Math.floor(timeline.length / WEIGHTS_PER_CHAR)
}

/**
 * Interpola la timeline a una posizione carattere frazionaria.
 *
 * `charPosition` può essere frazionaria perché il tempo per carattere non è
 * un numero intero di frame: interpolare evita il gradino a 60 fps.
 */
export function sampleTimeline(timeline: Float32Array, charPosition: number): VisemeWeights {
  const length = timelineLength(timeline)
  if (length === 0) return { ...NEUTRAL_WEIGHTS }

  const clamped = charPosition < 0 ? 0 : charPosition > length - 1 ? length - 1 : charPosition
  const lower = Math.floor(clamped)
  const upper = Math.min(lower + 1, length - 1)
  const t = clamped - lower

  const weights: VisemeWeights = { ...NEUTRAL_WEIGHTS }
  for (let v = 0; v < WEIGHTS_PER_CHAR; v += 1) {
    const preset = VISEME_PRESETS[v]
    if (preset === undefined) continue
    const a = timeline[lower * WEIGHTS_PER_CHAR + v] ?? 0
    const b = timeline[upper * WEIGHTS_PER_CHAR + v] ?? 0
    weights[preset] = a + (b - a) * t
  }
  return weights
}

/** Il preset con il peso maggiore: serve alla diagnostica e al meter della UI. */
export function dominantViseme(weights: VisemeWeights): VisemePreset | null {
  let best: VisemePreset | null = null
  let bestValue = 0.15 // sotto questa soglia la bocca è considerata chiusa
  for (const preset of VISEME_PRESETS) {
    const value = weights[preset]
    if (value > bestValue) {
      best = preset
      bestValue = value
    }
  }
  return best
}

/** Somma dei pesi: proxy dell'apertura totale della bocca. */
export function mouthOpenness(weights: VisemeWeights): number {
  let total = 0
  for (const preset of VISEME_PRESETS) total += weights[preset]
  return Math.min(total, 1)
}
