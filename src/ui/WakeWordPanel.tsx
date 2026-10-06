import { useCallback, useEffect, useRef, useState } from 'react'

import { sendUtterance } from '../ai/session'
import { ListeningSession } from '../speech/listening'
import { isSpeechRecognitionSupported } from '../speech/stt'
import { speech } from '../speech/speechController'
import { playWakeChime, wakeWord, type WakeDetection } from '../speech/wakeWord'
import {
  WAKE_KEYWORD_LABELS,
  WAKE_KEYWORDS,
  WAKE_THRESHOLD_LIMITS,
} from '../speech/wakeWordConfig'
import { setListening, setWake, setWakeStatus, useAppState } from '../store/appStore'

/**
 * Risveglio vocale locale.
 *
 * Quando il toggle è acceso, un motore ONNX in background ascolta la parola
 * chiave **senza mandare audio in rete**. Al rilevamento suona un bip, ferma
 * il motore (un solo microfono alla volta) e avvia una normale sessione di
 * ascolto, che poi segue il percorso di sempre — VAD, STT di Google, AI.
 */
const HANDS_FREE_TIMEOUT_MS = 12_000

function describeWakeStatus(status: string): string {
  switch (status) {
    case 'loading':
      return 'Carico i modelli locali…'
    case 'listening-local':
      return 'Ti ascolto in locale — dimmi la parola chiave'
    case 'detected':
      return 'Eccomi — parla pure'
    case 'suspended':
      return 'In pausa mentre usi il microfono'
    case 'error':
      return 'Risveglio non riuscito'
    default:
      return 'Spento'
  }
}

export function WakeWordPanel() {
  const { wake, wakeStatus, wakeError, sttLang } = useAppState()
  const [busy, setBusy] = useState(false)

  // La sessione hands-free vive fuori da React come quella del push-to-talk.
  const [session] = useState(
    () =>
      new ListeningSession(
        {
          onStatus: (status) => setListening({ listeningStatus: status }),
          onInterim: (text) => setListening({ interimTranscript: text }),
          onUtterance: (text) => {
            clearSafetyTimer()
            setListening({ lastUtterance: text, interimTranscript: '' })
            sendUtterance(text)
            void wakeWord.resumeAfterUtterance()
          },
          onError: (_kind, message) => {
            clearSafetyTimer()
            setListening({ listeningError: message })
            void wakeWord.resumeAfterUtterance()
          },
          onLevel: () => undefined,
        },
        { lang: sttLang },
      ),
  )
  const sessionRef = useRef(session)
  sessionRef.current = session

  const safetyTimer = useRef<number | null>(null)
  function clearSafetyTimer(): void {
    if (safetyTimer.current !== null) {
      window.clearTimeout(safetyTimer.current)
      safetyTimer.current = null
    }
  }

  const handleDetect = useCallback(async (detection: WakeDetection) => {
    setWakeStatus({
      wakeStatus: 'detected',
      wakeLastDetect: { keyword: detection.keyword, score: detection.score, at: detection.at },
    })
    // Un solo microfono alla volta: il motore locale si ferma, la sessione parte.
    await wakeWord.pauseForUtterance()
    playWakeChime()
    // Barge-in: se l'avatar sta parlando, il risveglio lo interrompe.
    if (speech.isSpeaking) await speech.interrupt()
    clearSafetyTimer()
    safetyTimer.current = window.setTimeout(() => {
      safetyTimer.current = null
      sessionRef.current.stop()
      setListening({ interimTranscript: '' })
      void wakeWord.resumeAfterUtterance()
    }, HANDS_FREE_TIMEOUT_MS)
    await sessionRef.current.start()
  }, [])

  // Collega il controller allo store una volta sola. Il toggle resta l'unico
  // proprietario di enable/disable: lo smontaggio non spegne nulla, altrimenti
  // lo StrictMode in dev spegnerebbe il motore a ogni doppio mount.
  useEffect(() => {
    wakeWord.setCallbacks({
      onStatus: (status, detail) =>
        setWakeStatus({ wakeStatus: status, wakeError: detail ?? null }),
      onDetect: (detection) => {
        void handleDetect(detection)
      },
      onError: (message) => setWakeStatus({ wakeStatus: 'error', wakeError: message }),
    })
    return () => {
      clearSafetyTimer()
    }
  }, [handleDetect])

  useEffect(() => {
    session.setOptions({ lang: sttLang })
  }, [session, sttLang])

  const toggle = useCallback(async () => {
    if (busy) return
    if (wake.enabled) {
      setWake({ enabled: false })
      setBusy(true)
      try {
        await wakeWord.disable()
      } finally {
        setBusy(false)
      }
      return
    }
    if (!isSpeechRecognitionSupported()) {
      setWakeStatus({
        wakeStatus: 'error',
        wakeError: 'Il risveglio hands-free ha bisogno del riconoscimento vocale: serve Chrome o Edge.',
      })
      return
    }
    setWake({ enabled: true })
    setWakeStatus({ wakeStatus: 'loading', wakeError: null })
    setBusy(true)
    try {
      await wakeWord.enable({ keyword: wake.keyword, threshold: wake.threshold })
    } finally {
      setBusy(false)
    }
  }, [busy, wake.enabled, wake.keyword, wake.threshold])

  const active = wake.enabled && (wakeStatus === 'listening-local' || wakeStatus === 'detected')

  return (
    <div role="group" aria-label="Risveglio vocale">
      <label className="flex cursor-pointer items-center gap-2.5 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={wake.enabled}
          disabled={busy}
          onChange={() => {
            void toggle()
          }}
          className="size-3.5 accent-sky-400"
        />
        Risveglio vocale in locale
      </label>

      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500" aria-live="polite">
        {busy ? 'Accendo il motore locale…' : describeWakeStatus(wakeStatus)}
        {wake.enabled && wakeStatus === 'listening-local'
          ? ` (“${WAKE_KEYWORD_LABELS[wake.keyword]}”)`
          : ''}
      </p>

      {wakeError && (
        <p className="mt-1.5 rounded-lg border border-rose-500/30 bg-rose-950/50 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-200">
          {wakeError}
        </p>
      )}

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-slate-400">
          Parola chiave
          <select
            value={wake.keyword}
            onChange={(event) => {
              const next = event.target.value
              if (next === wake.keyword) return
              setWake({ keyword: next as typeof wake.keyword })
              wakeWord.setKeyword(next as typeof wake.keyword)
            }}
            className="mt-1 w-full rounded-lg border border-white/10 bg-slate-800/80 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
          >
            {WAKE_KEYWORDS.map((keyword) => (
              <option key={keyword} value={keyword}>
                {WAKE_KEYWORD_LABELS[keyword]}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <label htmlFor="wake-threshold" className="text-[11px] text-slate-400">
              Soglia
            </label>
            <span className="text-[11px] tabular-nums text-slate-500">
              {wake.threshold.toFixed(2)}
            </span>
          </div>
          <input
            id="wake-threshold"
            type="range"
            min={WAKE_THRESHOLD_LIMITS.min}
            max={WAKE_THRESHOLD_LIMITS.max}
            step={WAKE_THRESHOLD_LIMITS.step}
            value={wake.threshold}
            onChange={(event) => {
              // La soglia si applica alla prossima accensione: ricostruire il
              // motore a ogni tacca del cursore costerebbe un reload dei modelli.
              setWake({ threshold: Number(event.target.value) })
            }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400"
          />
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        L&apos;ascolto della parola chiave avviene tutto nel browser: finché non
        la sente, nessun audio lascia il computer. Quando risponde, la frase
        successiva usa il riconoscimento di Google come il microfono.
        {active ? ' Il microfono resta acceso finché è attivo.' : ''}
      </p>
    </div>
  )
}
