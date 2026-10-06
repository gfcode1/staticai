import { useEffect, useRef } from 'react'

import { conversation, sendUtterance } from '../ai/session'
import { ChatInput } from './ChatInput'
import { useChatShortcut } from './useChatShortcut'
import { useAppState } from '../store/appStore'

/**
 * Conversazione.
 *
 * Solo cronologia e campo di testo: chiave e modello vivono nel pannello
 * Opzioni (`ModelSettings`). Resta il controllo su `apiKey` per disabilitare
 * l'invio finché non c'è una chiave.
 */
export function ChatPanel() {
  const { apiKey, chatStatus, chatError, chatPartial, chatActivity, chatMessages } = useAppState()

  const scrollRef = useRef<HTMLDivElement>(null)

  useChatShortcut()

  const configured = apiKey.trim() !== ''
  const busy = chatStatus !== 'idle'

  // Il testo che scende segue il fondo: senza, durante una risposta lunga si
  // guarda sempre la prima riga.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, chatPartial])

  return (
    <div>
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          onClick={() => conversation.reset()}
          disabled={chatMessages.length === 0 || busy}
          className="rounded-md px-2 py-1 text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-40"
        >
          nuova conversazione
        </button>
      </div>

      {/*
        Cronologia.
        `min-h-0` è ciò che permette a un figlio flex di poter scorrere: senza,
        l'elemento si rifiuta di scendere sotto l'altezza del contenuto e cresce
        invece di rimpicciolirsi — cioè spinge fuori il resto del pannello. Il
        massimo è legato al viewport (`dvh`), non a un numero fisso: la stessa
        altezza su un telefono e su un monitor è sbagliata in entrambi i sensi.
      */}
      <div
        ref={scrollRef}
        aria-live="polite"
        aria-label="Conversazione"
        className="mt-3 flex min-h-24 max-h-[min(46dvh,26rem)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl border border-white/5 bg-slate-950/40 p-2.5 text-xs leading-relaxed"
      >
        {!configured && chatMessages.length === 0 && (
          <p className="text-slate-600">
            Incolla la chiave OpenRouter nelle Opzioni, poi tieni premuto il microfono. La chiave si
            prende su openrouter.ai/settings/keys.
          </p>
        )}

        {chatMessages.map((message, index) => (
          <div key={index} className="group/message">
            <p
              className={
                message.role === 'user'
                  ? 'text-slate-300 [&_b]:font-semibold'
                  : 'text-sky-200/90 [&_b]:font-semibold'
              }
            >
              <b>{message.role === 'user' ? 'tu' : 'ari'}</b> {message.content}
            </p>
            <p className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-700">
              {message.at !== undefined && <span>{new Date(message.at).toLocaleTimeString('it-IT')}</span>}
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(message.content)}
                aria-label="Copia il messaggio"
                className="opacity-0 transition group-hover/message:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
              >
                copia
              </button>
            </p>
          </div>
        ))}

        {chatPartial !== '' && chatMessages[chatMessages.length - 1]?.role !== 'assistant' && (
          <p className="text-sky-200/60">
            <b>ari</b> {chatPartial}
          </p>
        )}

        {chatStatus !== 'idle' && chatPartial === '' && (
          <p className="text-slate-500">
            {/* L'attività dello strumento è più utile di "sto pensando": dice il
                perché della pausa, invece di ripetere che l'attesa c'è. */}
            {chatActivity ?? (chatStatus === 'thinking' ? 'sto pensando…' : 'sto parlando…')}
          </p>
        )}
      </div>

      <ChatInput
        disabled={!configured}
        error={chatError}
        busy={busy}
        onSend={sendUtterance}
        onInterrupt={() => conversation.abort()}
      />

      {!configured && (
        <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
          Serve una chiave OpenRouter per usare il campo di testo: la trovi nel pannello Opzioni.
        </p>
      )}
    </div>
  )
}
