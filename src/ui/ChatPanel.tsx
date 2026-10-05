import { useCallback, useEffect, useRef, useState } from 'react'

import { conversation, sendUtterance } from '../ai/session'
import { ChatInput } from './ChatInput'
import { useChatShortcut } from './useChatShortcut'
import { fetchFreeModels } from '../ai/models'
import { setChat, useAppState } from '../store/appStore'

/**
 * Impostazioni del modello e conversazione.
 *
 * La chiave OpenRouter viene chiesta qui, digitata dall'utente, e non esiste
 * da nessuna parte nel progetto. È una scelta con un compromesso: questa è
 * un'applicazione nel browser, quindi la chiave vive in `localStorage`, dove chi
 * usa lo stesso profilo la può leggere. Per un account gratuito con dei limiti
 * va bene; per una chiave con denaro dentro no. Meglio dirlo che farlo scrivere
 * e tacere.
 */
export function ChatPanel() {
  const {
    apiKey,
    chatModel,
    chatStatus,
    chatError,
    chatPartial,
    chatActivity,
    chatMessages,
    freeModels,
    modelsLoading,
    modelsError,
  } = useAppState()

  const [keyDraft, setKeyDraft] = useState(apiKey)
  const [showKey, setShowKey] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useChatShortcut()

  const configured = apiKey.trim() !== ''
  const busy = chatStatus !== 'idle'

  // L'elenco dei modelli gratuiti cambia spesso, quindi si rilegge a ogni avvio
  // invece di essere scritto nel codice.
  const refreshModels = useCallback(async () => {
    setChat({ modelsLoading: true, modelsError: null })
    try {
      const models = await fetchFreeModels()
      // Un modello salvato che non è più gratuito va abbandonato: tenerlo
      // significherebbe pagare senza che nessuno lo abbia deciso.
      const salvato = models.some((m) => m.id === chatModel)
      setChat({ freeModels: models, modelsLoading: false, chatModel: salvato ? chatModel : (models[0]?.id ?? chatModel) })
    } catch (error) {
      setChat({
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : 'Elenco modelli non raggiungibile.',
      })
    }
  }, [chatModel])

  useEffect(() => {
    void refreshModels()
    // Solo all'avvio: ripetere a ogni cambio di modello farebbe rechieste a ogni clic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Il testo che scende segue il fondo: senza, durante una risposta lunga si
  // guarda sempre la prima riga.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, chatPartial])

  const salvataggio = useCallback(() => {
    const chiave = keyDraft.trim()
    if (chiave === apiKey) return
    setChat({ apiKey: chiave, chatError: null })
  }, [apiKey, keyDraft])

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

      {/* Chiave: campo password, mai mostrata in chiaro per comodità. */}
      <div className="space-y-2">
        <div className="flex gap-1.5">
          <input
            type={showKey ? 'text' : 'password'}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={salvataggio}
            onKeyDown={(e) => {
              if (e.key === 'Enter') salvataggio()
            }}
            placeholder="chiave OpenRouter (sk-or-…)"
            aria-label="Chiave OpenRouter"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-white/10 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Nascondi la chiave' : 'Mostra la chiave'}
            className="shrink-0 rounded-md border border-white/10 px-2 text-[10px] text-slate-500 transition hover:text-slate-300"
          >
            {showKey ? 'nascondi' : 'mostra'}
          </button>
        </div>

        {configured && (
          <p className="text-[10px] leading-relaxed text-slate-600">
            Salvata su questo dispositivo, in <code>localStorage</code>. Chi usa lo stesso profilo
            del browser può leggerla: usala solo per un account gratuito.
          </p>
        )}

        {/* Modello: la lista arriva dalla rete, non è scritta qui. */}
        <div className="flex gap-1.5">
          <select
            value={chatModel}
            onChange={(e) => setChat({ chatModel: e.target.value })}
            aria-label="Modello del linguaggio"
            disabled={modelsLoading}
            className="w-full rounded-md border border-white/10 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200 focus:border-sky-500/50 focus:outline-none disabled:opacity-50"
          >
            {freeModels.length === 0 && <option value={chatModel}>{chatModel}</option>}
            {freeModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
                {model.supportsTools ? '' : ' · senza strumenti'}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void refreshModels()}
            disabled={modelsLoading}
            aria-label="Rileggi l'elenco dei modelli gratuiti"
            className="shrink-0 rounded-md border border-white/10 px-2 text-[10px] text-slate-500 transition hover:text-slate-300 disabled:opacity-40"
          >
            {modelsLoading ? '…' : '↻'}
          </button>
        </div>

        <p className="text-[10px] text-slate-600">
          {freeModels.length} modelli gratuiti · context {(freeModels.find((m) => m.id === chatModel)?.contextLength ?? 0).toLocaleString('it-IT')} token
        </p>
        {modelsError !== null && <p className="text-[10px] text-amber-300/80">{modelsError}</p>}
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
            Incolla la chiave OpenRouter qui sopra, poi tieni premuto il microfono. La chiave si
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
          Serve una chiave OpenRouter per usare il campo di testo. Si prende su
          openrouter.ai/settings/keys.
        </p>
      )}
    </div>
  )
}