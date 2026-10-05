/**
 * Segmentazione del testo in unità brevi da pronunciare una alla volta.
 *
 * Non è un'ottimizzazione ma una necessità: Chrome ha due limiti noti della
 * Web Speech API che si aggirano segmentando.
 *
 *  1. Oltre una certa durata l'enunciato viene **tagliato**. Chunk brevi
 *     (≈ 130 caratteri, poco più di 8 secondi) restano ben dentro il limite.
 *  2. Su Linux e Android l'evento `boundary` **non scatta**, quindi non
 *     arrivano timestamp parola per parola. Senza segmentazione non avremmo
 *     nessun punto di riferimento temporale affidabile: qui usiamo la fine di
 *     ogni chunk come misura reale per calibrare il ritmo del successivo.
 *
 * Segmentare anche a confine di frase, e non solo a lunghezza, ha un vantaggio
 * fonetico: ogni chunk suona come un periodo a sé e il motore di sintesi fa una
 * piccola pausa naturale, che il lip-sync può seguire.
 */

/** Lunghezza massima di un chunk, in caratteri. */
const MAX_CHUNK = 130

/** Sotto questa lunghezza un chunk viene unito al precedente. */
const MIN_CHUNK = 14

/** Confini di frase, con il separatore incluso nell'output. */
const SENTENCE_END = /([.!?…]+["')\]]?)\s*/g

/** Confini più deboli, usati solo se il pezzo è ancora troppo lungo. */
const CLAUSE_END = /([,;:—])\s+/g

export function splitIntoChunks(text: string, maxLength = MAX_CHUNK): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const sentences = splitOn(trimmed, SENTENCE_END)
  const out: string[] = []

  for (const sentence of sentences) {
    if (!sentence) continue
    if (sentence.length <= maxLength) {
      out.push(sentence)
      continue
    }

    for (const piece of splitOn(sentence, CLAUSE_END)) {
      if (!piece) continue
      if (piece.length <= maxLength) {
        out.push(piece)
        continue
      }
      out.push(...wrapByWords(piece, maxLength))
    }
  }

  return mergeTinyChunks(out, MIN_CHUNK)
}

/**
 * Spezza su un separatore conservandolo in coda al pezzo.
 *
 * Con il separatore `([.]+)\s*` applicato a `ciao. mondo` il risultato è
 * `['ciao.', 'mondo']`: il punto resta attaccato alla parola che lo precede.
 */
function splitOn(text: string, pattern: RegExp): string[] {
  const out: string[] = []
  let lastIndex = 0

  pattern.lastIndex = 0
  let match = pattern.exec(text)
  while (match !== null) {
    const end = match.index + match[0].length
    const piece = text.slice(lastIndex, end).trim()
    if (piece) out.push(piece)
    lastIndex = end
    match = pattern.exec(text)
  }

  const tail = text.slice(lastIndex).trim()
  if (tail) out.push(tail)

  return out
}

/** Ultimo risorso: taglia a confine di parola, senza perdere sillabe. */
function wrapByWords(text: string, maxLength: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let current = ''

  for (const word of words) {
    // Una parola più lunga del limite (URL, errore) la spezziamo a forza:
    // è già stata ripulita, e una sillaba troncata meglio di un chunk che non
    // viene pronunciato mai.
    if (word.length > maxLength) {
      if (current) {
        out.push(current)
        current = ''
      }
      for (let i = 0; i < word.length; i += maxLength) out.push(word.slice(i, i + maxLength))
      continue
    }

    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > maxLength) {
      out.push(current)
      current = word
    } else {
      current = candidate
    }
  }

  if (current) out.push(current)
  return out
}

/**
 * Unisce i chunk troppo brevi a quelli precedenti.
 *
 * "Sì." o "Ecco." presi da soli suonano come scatti. Inoltre un chunk cortissimo
 * è sfavorevole per la calibrazione: 6 caratteri in 0.4 secondi è una misura
 * rumorosa per stimare il ritmo.
 */
function mergeTinyChunks(chunks: string[], minLength: number): string[] {
  const out: string[] = []

  for (const chunk of chunks) {
    const previous = out[out.length - 1]
    const isTiny = chunk.length < minLength
    const fitsTogether = previous !== undefined && previous.length + chunk.length + 1 <= MAX_CHUNK

    if (previous !== undefined && isTiny && fitsTogether) {
      out[out.length - 1] = `${previous} ${chunk}`
    } else {
      out.push(chunk)
    }
  }

  return out
}

/**
 * Stima la durata di un chunk, in secondi, dal solo testo.
 *
 * Serve per il **primo** chunk: non abbiamo ancora misurato nulla, e senza una
 * stima non sappiamo dove mettere i visemi. I valori sono tarati su un parlato
 * italiano a velocità normale (circa 15 caratteri al secondo); appena finisce il
 * primo chunk la stima viene sostituita da una misura reale.
 */
export function estimateDuration(text: string, charsPerSecond: number): number {
  const clean = text.trim()
  if (!clean) return 0
  // Le pause interne contano: una virgola aggiunge qualche decimo di secondo.
  const pauses = (clean.match(/[,;:]/g)?.length ?? 0) * 0.18 + (clean.match(/[.!?…]/g)?.length ?? 0) * 0.32
  return clean.length / Math.max(charsPerSecond, 1) + pauses
}
