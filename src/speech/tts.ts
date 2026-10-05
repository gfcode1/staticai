/**
 * Sintesi vocale del browser.
 *
 * `window.speechSynthesis` sembra semplice e non lo è: sotto c'è una lista di
 * difetti noti di Chrome che vanno gestiti uno per uno, o la sintesi si blocca
 * a metà, non parte, o parte e si ferma. Sono tutti documentati qui, con il
 * rimedio accanto.
 */

/**
 * Ordina le voci per utilità, non per ordine di arrivo.
 *
 * `getVoices()` restituisce le voci nell'ordine in cui il sistema le
 * dichiara, che cambia da browser a browser e da macchina a macchina. Prendere
 * la prima è una scommessa: su Linux con `espeak-ng` installato si sente
 * `it+f3`, che è la voce più metallica disponibile, solo perché capita per
 * prima.
 *
 * L'ordine qui dentro è una gerarchia di merito, e ogni criterio ha un motivo:
 *
 * 1. **lingua esatta** (`it-IT`) davanti a una variante (`it-IT-fem`, `it`): è
 *    l'unico criterio che riguarda direttamente la pronuncia;
 * 2. **locale prima di online**: questo progetto tiene alla privacy e
 *    funziona offline, e una voce locale non invia il testo a nessun server.
 *    Non è però un criterio dominante — vedi il terzo punto;
 * 3. **il `default` del sistema** come spareggio: è un segnale debole ma
 *    l'unico che il browser ci dà sulla sua fiducia in una voce;
 * 4. **il nome**, come ultimo spareggio e solo fra voci altrimenti equivalenti.
 *    È una regola pragmatica, non una verità: i nomi cambiano da un motore
 *    all'altro, quindi non può decidere nulla da solo.
 */
export function rankVoices(
  voices: readonly SpeechSynthesisVoice[],
  settings: Pick<VoiceSettings, 'lang'>,
): SpeechSynthesisVoice[] {
  const richiesta = settings.lang.toLowerCase()
  const base = richiesta.split('-')[0] ?? richiesta

  const pertinenti = voices.filter((voice) => {
    const lang = voice.lang.toLowerCase()
    return lang === base || lang.startsWith(`${base}-`) || lang === richiesta
  })
  if (pertinenti.length === 0) return []

  const punteggio = (voice: SpeechSynthesisVoice): number => {
    let valore = 0
    const lang = voice.lang.toLowerCase()

    // Coincidenza esatta con la lingua richiesta: la voce sa di essere italiana
    // dell'Italia, non "italiana generica".
    if (lang === richiesta) valore += 100
    else if (lang.startsWith(`${richiesta}-`)) valore += 60
    else if (lang === base) valore += 40

    if (voice.localService) valore += 20
    if (voice.default) valore += 5

    return valore
  }

  const punteggi = new Map<SpeechSynthesisVoice, number>()
  for (const voice of pertinenti) punteggi.set(voice, punteggio(voice))

  // Pareggio: l'array è stabile, quindi a parità di merito resta la prima voce
  // **nella lingua esatta** — che è l'unico caso in cui l'ordine conta davvero.
  return [...pertinenti].sort((a, b) => (punteggi.get(b) ?? 0) - (punteggi.get(a) ?? 0))
}

/**
 * Una-voce-per-riga: i motori di sintesi possono esporre molte varianti della
 * stessa lingua (`it`, `it+f3`, `it+f4`), e attaccarle tutte al nome le rende
 * indistinguibili. Dice invece da dove arriva e se funziona senza rete.
 */
export function voiceLabel(voice: SpeechSynthesisVoice): string {
  const nome = voice.name.replace(/\s*\(.*?\)\s*$/, '').trim()
  const dove = voice.localService ? 'locale' : 'online'
  return `${nome} · ${voice.lang} · ${dove}`
}

export interface VoiceSettings {
  /** `name` della voce preferita; se assente si sceglie dalla lingua. */
  voiceName: string | null
  /** Lingua desiderata, es. `it-IT`. */
  lang: string
  /** Velocità di pronuncia. 1 è normale. */
  rate: number
  /** Timbro. 1 è normale. */
  pitch: number
  volume: number
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceName: null,
  lang: 'it-IT',
  rate: 1,
  pitch: 1,
  volume: 1,
}

export interface SpeakHandlers {
  /** Un chunk entra in pronuncia. `atMs` è lo stesso orologio di `now()`. */
  onChunkStart?: (chunk: string, index: number, atMs: number) => void
  /** Un chunk è finito. `durationMs` è la durata **reale** misurata. */
  onChunkEnd?: (chunk: string, index: number, durationMs: number) => void
  /** Tutti i chunk sono finiti. */
  onIdle?: () => void
  /** Errore reale (non un'interruzione volontaria). */
  onError?: (message: string) => void
}

/**
 * Chrome smette di parlare se la coda resta in silenzio. Il rimedio è
 * chiamare periodicamente `pause()` + `resume()`: forziamo il motore a
 * ricontrollare lo stato.
 */
const WATCHDOG_INTERVAL_MS = 10_000

/**
 * Dopo `cancel()` Chrome scarta la `speak()` successiva se arriva troppo presto.
 * Una pausa brevissima è il prezzo per non perdere la prima parola.
 */
const CANCEL_GRACE_MS = 60

/**
 * Se l'evento `end` non arriva, la coda si bloccherebbe per sempre: capita che
 * Chrome lo perda. Questo margine garantisce che si prosegua comunque.
 */
const CHUNK_TIMEOUT_SLACK_MS = 3_000

/**
 * Raggio di stima pessimisticamente lenta, in caratteri al secondo, usato solo
 * per il tetto di sicurezza. Non serve accurata: deve essere abbastanza alta da
 * non tagliare mai una frase a metà.
 */
const GUARD_CHARS_PER_SECOND = 12

/** Attesa iniziale per le voci: su Android arriva al secondo tentativo. */
const VOICES_TIMEOUT_MS = 2_500

export function nowMs(): number {
  return performance.now()
}

export class BrowserTts {
  private readonly synth: SpeechSynthesis
  private watchdog: number | null = null
  private cancelRequested = false
  private unlocked = false

  constructor() {
    this.synth = window.speechSynthesis
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  /** true se il browser espone la Web Speech API. */
  get isSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  /**
   * Voci disponibili.
   *
   * Su Chrome la prima restituzione è **sempre vuota**: le voci arrivano dopo.
   * Per questo `waitForVoices()` esiste e va usata al posto di questa.
   */
  get voices(): SpeechSynthesisVoice[] {
    if (!this.isSupported) return []
    return this.synth.getVoices()
  }

  /**
   * Attende che l'elenco delle voci sia popolato.
   *
   * Non basta l'evento `voiceschanged`: su alcune piatforme non arriva mai, e
   * senza polling l'app resta muta per sempre.
   */
  async waitForVoices(timeoutMs = VOICES_TIMEOUT_MS): Promise<SpeechSynthesisVoice[]> {
    if (!this.isSupported) return []

    const immediate = this.synth.getVoices()
    if (immediate.length > 0) return immediate

    return new Promise((resolve) => {
      let settled = false

      const finish = (voices: SpeechSynthesisVoice[]) => {
        if (settled) return
        settled = true
        this.synth.removeEventListener('voiceschanged', onChanged)
        window.clearInterval(poll)
        window.clearTimeout(timer)
        resolve(voices)
      }

      const onChanged = () => {
        const voices = this.synth.getVoices()
        if (voices.length > 0) finish(voices)
      }

      this.synth.addEventListener('voiceschanged', onChanged)

      const poll = window.setInterval(onChanged, 150)
      const timer = window.setTimeout(() => finish(this.synth.getVoices()), timeoutMs)

      onChanged()
    })
  }

  /**
   * Sceglie la voce: quella scelta dall'utente se esiste, altrimenti la prima
   * che corrisponde alla lingua, con preferenza per le voci locali.
   *
   * Le voci locali sono preferite perché le remote hanno latenza di rete e a
   * volte si interrompono a metà frase.
   */
  resolveVoice(voices: readonly SpeechSynthesisVoice[], settings: VoiceSettings): SpeechSynthesisVoice | null {
    if (voices.length === 0) return null

    if (settings.voiceName) {
      const exact = voices.find((voice) => voice.name === settings.voiceName)
      if (exact) return exact
    }

    return rankVoices(voices, settings)[0] ?? null
  }

  /**
   * Sblocca la sintesi con un gesto dell'utente.
   *
   * Alcuni browser rifiutano `speak()` se non c'è stata un'interazione con la
   * pagina. Un enunciato di una sola spazio, immediatamente annullato, basta a
   * segnalare l'intenzione senza emettere suono.
   */
  unlock(): void {
    if (!this.isSupported || this.unlocked) return
    this.unlocked = true
    try {
      const utterance = new SpeechSynthesisUtterance(' ')
      utterance.volume = 0
      this.synth.speak(utterance)
      this.synth.cancel()
    } catch {
      /* Su alcuni browser lo sblocco non è necessario: nessun problema */
    }
  }

  get isSpeaking(): boolean {
    return this.isSupported && (this.synth.speaking || this.synth.pending)
  }

  /** Sospende la pronuncia, mantenendo la posizione nella coda. */
  pause(): void {
    if (this.isSupported && this.synth.speaking) this.synth.pause()
  }

  resume(): void {
    if (this.isSupported && this.synth.paused) this.synth.resume()
  }

  /**
   * Pronuncia una sequenza di chunk, uno alla volta.
   *
   * Restituisce una promise risolta quando finisce tutto. Va sempre usata al
   * posto di chiamare `speak()` a raffica: Chrome tronca gli enunciati lunghi e
   * non è affidabile con la coda interna.
   */
  async speakChunks(
    chunks: readonly string[],
    settings: VoiceSettings,
    handlers: SpeakHandlers = {},
  ): Promise<void> {
    if (!this.isSupported || chunks.length === 0) return

    const voices = await this.waitForVoices()
    const voice = this.resolveVoice(voices, settings)

    if (voices.length === 0) {
      // Caso silenziosamente peggiore di tutti: nessuna voce installata. Dire
      // solo "non funziona" sarebbe inutilizzabile, quindi diamo la causa e il
      // rimedio.
      handlers.onError?.(
        'Nessuna voce installata nel sistema. Su Linux servono i moduli di ' +
          '`speech-dispatcher` (verifica con `spd-say "prova"`); su Windows le voci ' +
          'sono in Impostazioni → Tempo e lingua → Voce.',
      )
      return
    }

    if (voice === null) {
      const disponibili = [...new Set(voices.map((entry) => entry.lang))].join(', ')
      handlers.onError?.(
        `Nessuna voce per la lingua ${settings.lang}. Lingue presenti: ${disponibili}.`,
      )
      return
    }

    this.cancelRequested = false
    this.startWatchdog()

    for (const [index, chunk] of chunks.entries()) {
      if (this.cancelRequested) break
      const spoken = chunk.trim()
      // Chrome ignora silenziosamente un enunciato vuoto: non emetterebbe mai
      // `end` e la coda si bloccherebbe.
      if (!spoken) continue

      const ok = await this.speakOne(spoken, voice, settings, index, handlers)
      if (!ok) break
    }

    this.stopWatchdog()

    if (!this.cancelRequested) handlers.onIdle?.()
  }

  /** Interrompe tutto. Le chiamate successive non ripartono da sole. */
  interrupt(): void {
    if (!this.isSupported) return
    this.cancelRequested = true
    this.stopWatchdog()
    try {
      this.synth.cancel()
    } catch {
      /* already idle */
    }
  }

  dispose(): void {
    this.interrupt()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
  }

  /** true se l'ultimo `interrupt` è stato richiesto (e non un errore reale). */
  get wasCancelled(): boolean {
    return this.cancelRequested
  }

  private speakOne(
    text: string,
    voice: SpeechSynthesisVoice | null,
    settings: VoiceSettings,
    index: number,
    handlers: SpeakHandlers,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = voice?.lang ?? settings.lang
      if (voice) utterance.voice = voice
      utterance.rate = settings.rate
      utterance.pitch = settings.pitch
      utterance.volume = settings.volume

      let startMark = 0
      let finished = false

      const settle = (ok: boolean) => {
        if (finished) return
        finished = true
        window.clearTimeout(guard)
        resolve(ok)
      }

      // Rete di sicurezza contro l'evento `end` che non arriva mai.
      const guard = window.setTimeout(() => {
        if (finished) return
        try {
          this.synth.cancel()
        } catch {
          /* nothing to cancel */
        }
        // Proseguiamo con il chunk successivo invece di restare bloccati.
        settle(!this.cancelRequested)
      }, this.chunkTimeoutMs(text))

      utterance.onstart = () => {
        startMark = nowMs()
        handlers.onChunkStart?.(text, index, startMark)
      }

      utterance.onend = () => {
        if (finished) return
        const duration = startMark > 0 ? nowMs() - startMark : 0
        handlers.onChunkEnd?.(text, index, duration)
        settle(!this.cancelRequested)
      }

      utterance.onerror = (event) => {
        if (finished) return
        const reason = (event as SpeechSynthesisErrorEvent).error
        // `interrupted` e `canceled` sono la conseguenza di un nostro
        // interrupt(): non sono errori e non vanno segnalati all'utente.
        if (reason === 'interrupted' || reason === 'canceled') {
          settle(false)
          return
        }
        handlers.onError?.(`Sintesi vocale interrotta (${reason}).`)
        settle(false)
      }

      try {
        this.synth.speak(utterance)
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error.message : 'Errore di sintesi vocale.')
        settle(false)
      }
    })
  }

  /**
   * Tetto massimo per un chunk, in millisecondi.
   *
   * Volutamente generoso: se il tetto scatta troppo presto la frase verrebbe
   * tagliata a metà, il danno è immediatamente visibile e udibile. Se invece
   * scatta tardi, il costo è un piccolo ritardo di cui nessuno si accorge.
   */
  private chunkTimeoutMs(text: string): number {
    return (text.length / GUARD_CHARS_PER_SECOND) * 1000 + CHUNK_TIMEOUT_SLACK_MS
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = window.setInterval(() => {
      if (!this.synth.speaking || this.synth.paused || this.cancelRequested) return
      try {
        // Il ciclo pause/resume è ciò che sblocca Chrome dopo un silenzio.
        this.synth.pause()
        this.synth.resume()
      } catch {
        /* il watchdog non deve mai far cadere la sintesi */
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  private stopWatchdog(): void {
    if (this.watchdog === null) return
    window.clearInterval(this.watchdog)
    this.watchdog = null
  }

  private readonly onVisibilityChange = (): void => {
    // Chrome sospende la sintesi quando la scheda non è visibile e spesso non
    // la riprende al ritorno.
    if (document.visibilityState === 'visible' && this.synth.paused) this.synth.resume()
  }
}

/**
 * Attesa dopo un `cancel()`.
 *
 * Va usata solo quando si deve parlare subito dopo un'interruzione: è il
 * rimedio al fatto che Chrome scarta la `speak()` successiva.
 */
export function cancelGrace(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, CANCEL_GRACE_MS))
}
