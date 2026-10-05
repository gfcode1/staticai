/**
 * Frasi pronuncabili estratte da un testo che arriva a pezzi.
 *
 * Lo streaming dà il testo a brandelli: `["Ciao", ", sono", " l'assistente", "."]`.
 * Per far partire la voce prima che il modello finisca, serve una domanda:
 * di questo testo, quanto è già sicuro da pronunciare?
 *
 * La regola è conservare tutto: ciò che esce più ciò che resta deve essere
 * esattamente ciò che è entrato. Perdere una sillaba significa che l'avatar
 * pronuncia una parola diversa da quella scritta, e l'errore è invisibile.
 */

/** Sotto questa lunghezza un periodo non viene pronunciato: suonerebbe a scatti. */
const MIN_SPEAKABLE = 12
/** Oltre questa lunghezza, se non c'è nessun punto, si taglia all'ultima parola. */
const MAX_BUFFERED = 240

/**
 * Abbreviazioni il cui punto **non** chiude la frase.
 *
 * Senza questa lista `Piove a Roma. Domani no.` diventerebbe `Piove a Roma.` +
 * `Domani no.` — che è giusto — ma `Vedi sig. Rossi` diventerebbe `Vedi sig.`
 * + `Rossi`, cioè due frasi al posto di una, con una pausa nel mezzo di un
 * nome.
 */
const ABBREVIATIONS = new Set([
  'sig', 'sig.ra', 'dott', 'dott.ssa', 'ing', 'ing.', 'prof', 'prof.ssa', 'avv',
  'ecc', 'ecc.', 'es', 'es.', 'p.es', 'ca', 'ca.', 'n', 'n.', 'art', 'art.',
  'pag', 'pag.', 'vol', 'vols', 'c.m', 'km', 'kg', 'cm', 'mm', 'tel', 'fax',
  'mr', 'mrs', 'ms', 'dr', 'prof.', 'vs', 'etc', 'sez',
])

export interface Split {
  /** Testo già completo e pronunciabile. */
  speakable: string
  /** Testo rimasto in attesa di altro testo. */
  rest: string
}

/** Il punto è un punto e virgola, non una virgola decimale né un puntino. */
function isSentenceEnd(text: string, index: number): boolean {
  const char = text[index]
  if (char === '\n' || char === '!' || char === '?') return true
  if (char !== '.') return false

  // 3.5, 1.000.000: numero, non fine frase.
  const before = text[index - 1]
  const after = text[index + 1]
  if (before && after && /\d/.test(before) && /\d/.test(after)) return false
  // 1.000: il punto tra due cifre è un separatore di migliaia.
  if (before && after && /\d/.test(before) && after === '.') return false

  // Punti di sospensione: restano col primo periodo.
  if (after === '.') return false

  const wordBefore = /([\p{L}.]+)$/u.exec(text.slice(0, index))?.[1] ?? ''
  const plain = wordBefore.replace(/\.$/, '').toLowerCase()
  if (ABBREVIATIONS.has(plain) || ABBREVIATIONS.has(plain + '.')) return false
  // Una sola lettera prima del punto è un'iniziale: "G. Rossi".
  if (plain.length === 1) return false

  return true
}

/** Quote e parentesi chiuse dopo il punto: `diceva "no."` non deve tagliare dentro. */
function closingRun(text: string, index: number): number {
  let end = index + 1
  while (end < text.length && /["'»”)\]]/.test(text[end] ?? '')) end += 1
  return end
}

/**
 * Divide il testo nel primo periodo abbastanza lungo da essere pronunciabile.
 *
 * Si sceglie il **primo** confine e non l'ultimo. Il testo che entra qui è
 * quello rimasto in attesa, non la risposta completa: appena una frase è
 * finita la si pronuncia, e mergedere più frasi insieme per farne un blocco più
 * lungo farebbe aspettare l'utente senza alcun vantaggio acustico — un punto in
 * più a metà frase è esattamente la pausa che serve a respirare.
 */
export function splitSpeakable(text: string): Split {
  if (text.trim() === '') return { speakable: '', rest: text }

  let end = -1
  for (let i = 0; i < text.length; i += 1) {
    if (isSentenceEnd(text, i)) {
      const candidate = closingRun(text, i)
      if (candidate >= MIN_SPEAKABLE) {
        end = candidate
        break
      }
    }
  }

  // Nessun punto, ma il testo è già lungo: meglio parlare che accumulare.
  if (end === -1 && text.length >= MAX_BUFFERED) {
    const cut = text.lastIndexOf(' ', MAX_BUFFERED)
    if (cut > MIN_SPEAKABLE) end = cut + 1
  }

  if (end === -1) return { speakable: '', rest: text }
  return { speakable: text.slice(0, end), rest: text.slice(end) }
}

/**
 * Accumula il testo in arrivo e restituisce ciò che si può già pronunciare.
 *
 * Lo stato è una semplice stringa: nessun riferimento a React, nessun effetto
 * collaterale, e il componente può usarlo senza preoccuparsi di renderizzare.
 */
export class SpeakableTail {
  private buffer = ''

  /** Aggiunge un pezzo e restituisce il nuovo testo pronunciabile. */
  push(delta: string): string {
    this.buffer += delta
    const { speakable, rest } = splitSpeakable(this.buffer)
    this.buffer = rest
    return speakable
  }

  /** Ultimo pezzo, pronunciato alla fine del flusso. */
  flush(): string {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest
  }

  /** Testo ancora non pronunciato, per l'interfaccia. */
  get pending(): string {
    return this.buffer
  }
}