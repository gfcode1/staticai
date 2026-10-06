import { useState } from 'react'

import { describeProfile } from '../memory/memory'
import { formatScadenza, pendingReminders } from '../memory/reminders'
import { cancelReminder, clearMemories, forgetMemory, useAppState } from '../store/appStore'

/**
 * I ricordi e il profilo, in chiaro.
 *
 * Questo pannello esiste per una ragione precisa: **un ricordo che l'utente non
 * può vedere non è un ricordo, è una sorveglianza**. Il pannello della chat dice
 * "ricordato: vivo a Milano" e passa oltre; quello che permette di cancellare è
 * il punto in cui la promessa della Fase 3 — la modalità on-device si spegne da
 * sola perché non è utilizzabile — diventa vera anche per i dati.
 *
 * Perciò qui non c'è "disattiva la memoria". Si vede cosa c'è, si cancella
 * quello che non si vuole più, e il pulsante per dimenticare tutto è il primo in
 * assoluto: se per usarlo bisogna cercarlo, la memoria è già troppo invadente.
 */
export function MemoryPanel() {
  const { memories, profile, reminders } = useAppState()
  const [conferma, setConferma] = useState(false)
  // Solo i futuri, dal più vicino: gli scaduti suonano e spariscono da soli.
  const pendenti = pendingReminders(reminders)

  return (
    <div>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-500">{describeProfile(profile)}</p>

      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-slate-600">
          {memories.length === 0 ? 'nessun ricordo' : `${memories.length} ricordi`}
        </span>
        {memories.length > 0 && (
          <button
            type="button"
            onClick={() => {
              // Due passi, non uno: "dimentica tutto" è irreversibile e capita
              // per errore. Confermare è più rapido che rimpiangere.
              if (conferma) {
                clearMemories()
                setConferma(false)
                return
              }
              setConferma(true)
            }}
            onBlur={() => setConferma(false)}
            className={`rounded-md px-2 py-1 text-[10px] transition focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60 ${
              conferma
                ? 'bg-rose-950 text-rose-200 ring-1 ring-rose-500/40'
                : 'text-slate-500 hover:text-rose-300'
            }`}
          >
            {conferma ? 'confermi? clicca di nuovo' : 'dimentica tutto'}
          </button>
        )}
      </div>

      {memories.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-slate-600">
          Puoi chiedere di ricordare qualcosa a voce: «ricorda che vivo a Milano». Comparirà qui, e
          potrai cancellarlo quando vuoi.
        </p>
      ) : (
        <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto overscroll-contain">
          {memories.map((memory) => (
            <li
              key={memory.id}
              className="group flex items-start gap-2 rounded-lg border border-white/5 bg-slate-950/40 px-2.5 py-2"
            >
              <span className="flex-1 text-[11px] leading-relaxed text-slate-300">{memory.text}</span>
              <button
                type="button"
                onClick={() => forgetMemory(memory.text)}
                aria-label={`Dimentica: ${memory.text}`}
                className="shrink-0 rounded px-1 text-[11px] text-slate-600 transition hover:text-rose-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        I ricordi vivono solo in questo browser ({'localStorage'}) e finiscono nel prompt del modello.
        Non vengono inviati da nessuna parte tranne che a OpenRouter, e puoi cancellarli qui o a voce
        con «dimentica Milano».
      </p>

      <div className="mb-1 mt-3 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-slate-600">
          {pendenti.length === 0 ? 'nessun promemoria' : `${pendenti.length} promemoria`}
        </span>
      </div>

      {pendenti.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-slate-600">
          Puoi chiedere a voce: «ricordami fra dieci minuti di spegnere il forno». Suonerà qui, anche
          se ricarichi la pagina.
        </p>
      ) : (
        <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto overscroll-contain">
          {pendenti.map((reminder) => (
            <li
              key={reminder.id}
              className="group flex items-start gap-2 rounded-lg border border-white/5 bg-slate-950/40 px-2.5 py-2"
            >
              <span className="flex-1 text-[11px] leading-relaxed text-slate-300">
                {reminder.text}
                <span className="block text-[10px] text-slate-500">
                  {formatScadenza(reminder.dueAt)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => cancelReminder(reminder.text)}
                aria-label={`Annulla promemoria: ${reminder.text}`}
                className="shrink-0 rounded px-1 text-[11px] text-slate-600 transition hover:text-rose-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}