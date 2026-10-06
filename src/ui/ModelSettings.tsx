import { useCallback, useEffect, useState } from 'react'

import { fetchFreeModels } from '../ai/models'
import { getState, setChat, useAppState } from '../store/appStore'

/**
 * Chiave OpenRouter e scelta del modello.
 *
 * Estratto da `ChatPanel`: prima viveva insieme alla cronologia, ora è una
 * sezione del pannello Opzioni. La chiave viene digitata dall'utente e non
 * esiste da nessuna parte nel progetto: vive in `localStorage` su questo
 * dispositivo, dove chi usa lo stesso profilo la può leggere. Per un account
 * gratuito con dei limiti va bene; per una chiave con denaro dentro no.
 */
export function ModelSettings() {
  const { apiKey, chatModel, freeModels, modelsLoading, modelsError } = useAppState()

  const [keyDraft, setKeyDraft] = useState(apiKey)
  const [showKey, setShowKey] = useState(false)

  // Il draft segue la chiave salvata: senza, una modifica da un'altra scheda
  // o da un altro componente lascerebbe il campo con un valore stantio.
  useEffect(() => {
    setKeyDraft(apiKey)
  }, [apiKey])

  const configured = apiKey.trim() !== ''

  // L'elenco dei modelli gratuiti cambia spesso, quindi si rilegge a ogni avvio
  // invece di essere scritto nel codice.
  const refreshModels = useCallback(async () => {
    setChat({ modelsLoading: true, modelsError: null })
    try {
      const models = await fetchFreeModels()
      // Un modello salvato che non è più gratuito va abbandonato: tenerlo
      // significherebbe pagare senza che nessuno lo abbia deciso.
      // Lettura da `getState()` e non dallo scope: il callback è stabile e
      // non si ricrea a ogni cambio di modello.
      const attuale = getState().chatModel
      const salvato = models.some((m) => m.id === attuale)
      setChat({
        freeModels: models,
        modelsLoading: false,
        chatModel: salvato ? attuale : (models[0]?.id ?? attuale),
      })
    } catch (error) {
      setChat({
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : 'Elenco modelli non raggiungibile.',
      })
    }
  }, [])

  useEffect(() => {
    void refreshModels()
    // Solo all'avvio: ripetere a ogni cambio di modello farebbe richieste a ogni clic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const salvataggio = useCallback(() => {
    const chiave = keyDraft.trim()
    if (chiave === apiKey) return
    setChat({ apiKey: chiave, chatError: null })
  }, [apiKey, keyDraft])

  const sporca = keyDraft.trim() !== apiKey

  return (
    <div className="space-y-2">
      {/* Chiave: campo password, mai mostrata in chiaro per comodità. */}
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

      {sporca && (
        <button
          type="button"
          onClick={salvataggio}
          className="w-full rounded-md bg-sky-600 py-1.5 text-[11px] font-medium text-white transition hover:bg-sky-500"
        >
          salva la chiave
        </button>
      )}

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
        {freeModels.length} modelli gratuiti · context{' '}
        {(freeModels.find((m) => m.id === chatModel)?.contextLength ?? 0).toLocaleString('it-IT')}{' '}
        token
      </p>
      {modelsError !== null && <p className="text-[10px] text-amber-300/80">{modelsError}</p>}
    </div>
  )
}
