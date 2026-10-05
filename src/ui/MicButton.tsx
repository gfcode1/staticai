import { useCallback, useEffect, useRef, useState } from 'react'

import { ListeningSession, type ListeningCallbacks } from '../speech/listening'
import { isSpeechRecognitionSupported } from '../speech/stt'
import { isMicrophoneSupported } from '../speech/vad'
import { interruptReply, sendUtterance } from '../ai/session'
import { speech } from '../speech/speechController'
import { setListening, useAppState } from '../store/appStore'

/**
 * Pulsante del microfono.
 *
 * Il livello del segnale **non** passa dallo store React: cambierebbe 50 volte
 * al secondo e farebbe re-renderizzare l'intero albero. Lo scriviamo
 * direttamente in una variabile CSS, che il browser interpola senza alcun
 * lavoro JavaScript.
 */
const LEVEL_PROPERTY = '--mic-level'

/** Come fermare l'ascolto: rilascio del tasto, oppure tocco di nuovo. */
type StopMode = 'release' | 'toggle'

/**
 * C'è una sessione di ascolto attiva?
 *
 * Funzione esterna al componente per due motivi: dentro un `useCallback`
 * l'accesso a `session.isActive` sarebbe un'espressione membro che il lint
 * vuole nelle dipendenze, ma è un getter e non cambia mai — quindi finirebbe
 * per far ricreare il callback a ogni render senza motivo.
 */
function sessionIsActive(session: ListeningSession | null): boolean {
  return session?.isActive ?? false
}

declare global {
  interface Window {
    /** Sessione di ascolto, solo in sviluppo: serve a capire dove si blocca. */
    __listening?: ListeningSession | undefined
  }
}

/**
 * Dove finisce il livello del microfono.
 *
 * Il valore viene scritto come variabile CSS su `:root` invece che passare dallo
 * store React: cambierebbe 50 volte al secondo e farebbe re-renderizzare
 * l'albero. Il browser interpola la variabile senza alcun lavoro JavaScript, e
 * non serve alcun riferimento al nodo DOM da tenere in vita.
 */
function writeMicLevel(level: number): void {
  document.documentElement.style.setProperty(LEVEL_PROPERTY, level.toFixed(3))
}

/**
 * Callback della sessione di ascolto.
 *
 * Vivono fuori dal componente perché non hanno bisogno di nessuno stato di
 * React: `setListening` scrive nel negozio esterno, che è sempre aggiornato.
 * Definirle qui evita sia closure stantie sia ref scritti durante il render.
 */
const SESSION_CALLBACKS: ListeningCallbacks = {
  onStatus: (status) => setListening({ listeningStatus: status }),
  onInterim: (text) => setListening({ interimTranscript: text }),
  onUtterance: (text) => {
    setListening({ lastUtterance: text, interimTranscript: '' })
    sendUtterance(text)
  },
  onError: (_kind, message) => setListening({ listeningError: message }),
  onLevel: writeMicLevel,
}

export function MicButton() {
  const { listeningStatus, interimTranscript, lastUtterance, listeningError, sttLang } = useAppState()

  const [supported] = useState(
    () => typeof window !== 'undefined' && isMicrophoneSupported() && isSpeechRecognitionSupported(),
  )

  const listening = listeningStatus === 'listening' || listeningStatus === 'transcribing'
  const busy = listeningStatus === 'requesting'

  // La sessione vive fuori da React: sopravvive ai re-render. `useState` con
  // inizializzatore pigro è il modo dichiarato dalla React per creare un
  // oggetto una volta sola senza scrivere un ref durante il render.
  const [session] = useState(() =>
    supported ? new ListeningSession(SESSION_CALLBACKS, { lang: sttLang }) : null,
  )

  useEffect(() => {
    session?.setOptions({ lang: sttLang })
    if (import.meta.env.DEV) window.__listening = session ?? undefined
  }, [session, sttLang])

  useEffect(() => () => session?.dispose(), [session])

  // L'intenzione dell'utente vive in ref, non nello stato di React.
  //
  // `begin` è asincrono: fra il `pointerdown` e l'avvio della sessione passa
  // l'attesa del permesso, durante la quale nessun render è garantito. Se il
  // rilascio leggesse lo stato di React troverebbe `listening === false`,
  // ignorerebbe il rilascio, e il microfono resterebbe acceso per sempre. Le
  // ref aggiornano il contatore di intenzione immediatamente, senza aspettare
  // nessun render.
  const holdingRef = useRef(false)
  /** Modalità alternanza: l'ascolto continua finché non si tocca di nuovo. */
  const latchedRef = useRef(false)

  // ------------------------------------------------------------------ azioni
  const begin = useCallback(async () => {
    setListening({ listeningError: null, interimTranscript: '' })
    const ok = await session?.start()
    // L'utente potrebbe aver già rilasciato mentre chiedevamo il permesso.
    // Senza questo controllo la sessione resterebbe accesa: il rilascio è già
    // passato e non arriverà nessun altro evento a spegnerla.
    if (ok && !holdingRef.current && !latchedRef.current) {
      const text = session?.stop() ?? ''
      if (text) sendUtterance(text)
    }
  }, [session])

  const end = useCallback(
    (mode: StopMode) => {
      if (!session) return
      const text = session.stop()
      if (mode === 'release' && text) {
        setListening({ lastUtterance: text, interimTranscript: '' })
        sendUtterance(text)
      }
    },
    [session],
  )

  const toggle = useCallback(() => {
    if (latchedRef.current || sessionIsActive(session)) {
      latchedRef.current = false
      end('toggle')
      return
    }
    latchedRef.current = true
    void begin()
  }, [begin, end, session])

  if (!supported) {
    return (
      <div className="pointer-events-none rounded-2xl border border-amber-500/30 bg-amber-950/60 px-4 py-3 text-xs text-amber-200">
        Riconoscimento vocale non disponibile in questo browser. Serve Chrome o Edge.
      </div>
    )
  }

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-3">
      {/* Trascrizione corrente */}
      <div className="max-w-md text-center">
        {interimTranscript ? (
          <p className="rounded-2xl border border-sky-500/25 bg-slate-900/80 px-4 py-2.5 text-sm leading-relaxed text-slate-100 backdrop-blur-md">
            {interimTranscript}
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-sky-300 align-middle" />
          </p>
        ) : lastUtterance && !listeningError ? (
          <p className="rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-2 text-xs text-slate-400 backdrop-blur-md">
            «{lastUtterance}»
          </p>
        ) : null}
      </div>

      {listeningError && (
        <p className="max-w-md rounded-xl border border-rose-500/30 bg-rose-950/50 px-3 py-2 text-center text-[11px] leading-relaxed text-rose-200 backdrop-blur-md">
          {listeningError}
        </p>
      )}

      {/* Pulsante: tieni premuto, o tocca per alternare */}
      <div className="relative grid place-items-center">
        {/* Anello del livello: il valore arriva da `--mic-level` su `:root`.
            `pointer-events-none` è essenziale: l'anello è posizionato in assoluto
            sopra il pulsante e, senza, ne ruberebbe i clic — l'anello è decorativo,
            ma l'utente preme il pulsante. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-3 rounded-full ring-2 ring-sky-400/70 transition-opacity duration-150"
          style={{
            opacity: listening ? 'calc(0.25 + var(--mic-level, 0) * 0.75)' : 0,
            transform: 'scale(calc(1 + var(--mic-level, 0) * 0.35))',
          }}
        />
        <button
          type="button"
          onPointerDown={(event) => {
            // Chiunque parli interrompe: una risposta lunga che continua
            // mentre l'utente sta parlando è solo rumore.
            interruptReply()
            // Sblocca la sintesi vocale. Va fatto in un gesto utente: senza,
            // Chrome può rifiutare di parlare e il difetto è invisibile — il
            // lip-sync si muove, il testo scorre, e non esce suono.
            speech.unlock()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            // Il pulsante resta utilizzabile durante `requesting`: disabilitarlo
            // sopprimerebbe il `pointerup` e lascerebbe il microfono acceso.
            if (busy) return
            holdingRef.current = true
            void begin()
          }}
          onPointerUp={() => {
            holdingRef.current = false
            if (sessionIsActive(session)) end('release')
          }}
          onPointerCancel={() => {
            holdingRef.current = false
            if (sessionIsActive(session)) end('release')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggle()
            }
          }}
          disabled={busy}
          aria-busy={busy}
          aria-pressed={listening}
          aria-label={listening ? 'Rilascia per ascoltare' : 'Tieni premuto per parlare'}
          className={`grid size-16 place-items-center rounded-full border shadow-2xl transition disabled:opacity-50 ${
            listening
              ? 'border-sky-300 bg-sky-500/90'
              : 'border-white/15 bg-slate-900/80 hover:border-sky-400/60 hover:bg-slate-800/80'
          }`}
        >
          <svg viewBox="0 0 24 24" className="size-6 text-slate-100" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" strokeLinecap="round" />
            <path d="M12 18v3" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="text-[11px] font-medium text-slate-300">
        {busy
          ? 'Chiedo il microfono…'
          : listeningStatus === 'transcribing'
            ? 'Trascrivo…'
            : listening
              ? 'Ti ascolto — rilascia quando hai finito'
              : 'Tieni premuto e parla'}
      </p>

    </div>
  )
}
