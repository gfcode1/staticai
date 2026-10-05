import { useCallback, useEffect, useRef } from 'react'

import { MAX_INPUT_CHARS } from '../config'

/**
 * Campo di testo della conversazione.
 *
 * È il pezzo che mancava più di tutti, ed è quello che sembrava facoltativo: un
 * assistente vocale si usa parlando, ma ci sono momenti in cui non si può o non
 * si vuole parlare. Una stanza rumorosa, una riunione, un problema di voce, la
 * semplice voglia di non disturbare chi sta intorno. Senza un campo di testo,
 * in tutti quei casi l'applicazione è inutilizzabile.
 *
 * Sta anche il motivo per cui i messaggi scritti arrivano alla chat esattamente
 * come quelli parlati: stessa coda, stesso modello, stessa voce.
 */

export interface ChatInputProps {
  disabled?: boolean
  /** Messaggio di errore da riprodurre sotto il campo. */
  error?: string | null
  onSend: (text: string) => void
  onInterrupt: () => void
  /** Il modello sta rispondendo: cambia l'aspetto e la scorciatoia. */
  busy?: boolean
}

const MAX_ROWS_PX = 120

export function ChatInput({ disabled = false, error, onSend, onInterrupt, busy = false }: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  /**
   * Il riquadro cresce con il testo fino a un tetto, poi scorre.
   *
   * Senza, un messaggio lungo occuperebbe tutta la cronologia e la casella
   * spingerebbe via il resto del pannello — lo stesso difetto geométrico del
   * pulsante del microfono, un'altra volta e in un'altra forma.
   */
  const adatta = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`
  }, [])

  useEffect(adatta, [adatta])

  const invia = useCallback(() => {
    const testo = ref.current?.value.trim() ?? ''
    if (testo === '' || disabled) return
    onSend(testo)
    if (ref.current) {
      ref.current.value = ''
      adatta()
    }
  }, [adatta, disabled, onSend])

  return (
    <div className="mt-2">
      <div
        className={`flex items-end gap-1.5 rounded-xl border bg-slate-950/60 px-2 py-1.5 transition focus-within:border-sky-500/50 ${
          disabled ? 'border-white/5 opacity-50' : 'border-white/10'
        }`}
      >
        <label htmlFor="chat-input" className="sr-only">
          Scrivi un messaggio all&apos;assistente
        </label>
        <textarea
          id="chat-input"
          ref={ref}
          rows={1}
          maxLength={MAX_INPUT_CHARS}
          disabled={disabled}
          placeholder={busy ? 'Ari sta rispondendo…' : 'Scrivi un messaggio, o tieni premuto il microfono'}
          onChange={adatta}
          onKeyDown={(event) => {
            // Invio con Invio, a capo con Maiusc+Invio: è la convenzione che
            // chi scrive in chat si aspetta, e invertire le due è sempre
            // fastidioso.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              invia()
              return
            }
            if (event.key === 'Escape' && busy) {
              event.preventDefault()
              onInterrupt()
            }
          }}
          className="max-h-[7.5rem] min-h-[1.5rem] flex-1 resize-none bg-transparent py-0.5 text-xs leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={invia}
          disabled={disabled}
          aria-label="Invia il messaggio"
          className="shrink-0 rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-600"
        >
          invia
        </button>
      </div>

      {/*
        Istruzioni brevi. In un'applicazione vocale la tastiera è il percorso
        secondario, e senza un accenno l'utente prova Invio, vede che non
        succede niente e crede sia rotto.
      */}
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
        <kbd className="rounded bg-white/5 px-1 text-slate-500">Invio</kbd> invia ·{' '}
        <kbd className="rounded bg-white/5 px-1 text-slate-500">Maiusc+Invio</kbd> va a capo
        {busy && ' · Esc interrompe'}
      </p>

      {error !== undefined && error !== null && (
        <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/50 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200">
          {error}
        </p>
      )}
    </div>
  )
}
