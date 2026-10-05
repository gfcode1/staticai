import { useCallback, useRef, useState } from 'react'

import {
  BUNDLED,
  DEFAULT_AVATAR_ID,
  eliminaModello,
  salvaModello,
  verificaFile,
  MAX_AVATAR_BYTES,
  type UploadedAvatar,
} from '../vrm/avatarLibrary'
import {
  addUploadedAvatar,
  removeUploadedAvatar,
  setAvatar,
  useAppState,
} from '../store/appStore'

/**
 * Scelta dell'avatar: i modelli inclusi o un file dal disco.
 *
 * Il caricamento dal disco è una scelta progettuale, non una comodità. Gli URL
 * remoti quasi non funzionano: un `fetch` su un dominio diverso ha bisogno degli
 * header CORS, e la maggior parte degli host che espone file .vrm non li
 * invia. Il risultato sarebbe un errore che non dice nulla. Un file scelto
 * dall'utente funziona sempre, anche senza rete, e non pone problemi di
 * licenza: il file è suo e resta suo.
 */

const VISUALI = ['aa', 'ee', 'ih', 'oh', 'ou']

export function AvatarPicker() {
  const { avatarId, avatarPhase, availableExpressions, uploadedAvatars } = useAppState()
  const [errore, setErrore] = useState<string | null>(null)
  const [occupato, setOccupato] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const vocali = VISUALI.filter((v) => availableExpressions.includes(v)).length
  const senzaVisemi = avatarPhase === 'ready' && vocali < VISUALI.length

  const carica = useCallback(async (file: File) => {
    setErrore(null)

    if (!/\.vrm$/i.test(file.name)) {
      setErrore('Il file deve chiamarsi .vrm')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setErrore(`Il modello è troppo grande (${Math.round(file.size / 1024 / 1024)} MB). Il limite è ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB.`)
      return
    }

    setOccupato(true)
    try {
      await verificaFile(file)
      const id = `up-${file.name}-${file.size}-${Date.now().toString(36)}`
      await salvaModello(id, file)
      const voce: UploadedAvatar = { id, name: file.name, size: file.size, at: Date.now() }
      addUploadedAvatar(voce)
    } catch (e) {
      setErrore(e instanceof Error ? e.message : 'Salvataggio non riuscito.')
    } finally {
      setOccupato(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [])

  const rimuovi = useCallback(async (id: string) => {
    setErrore(null)
    removeUploadedAvatar(id)
    try {
      await eliminaModello(id)
    } catch (e) {
      setErrore(e instanceof Error ? e.message : 'Rimozione non riuscita.')
    }
  }, [])

  return (
    <div>
      <ul className="space-y-1">
        {BUNDLED.map((avatar) => {
          const attivo = avatar.id === avatarId
          return (
            <li key={avatar.id}>
              <button
                type="button"
                onClick={() => setAvatar(avatar.id)}
                aria-pressed={attivo}
                className={`w-full rounded-lg border px-2.5 py-2 text-left transition focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60 ${
                  attivo
                    ? 'border-sky-400/60 bg-sky-500/10'
                    : 'border-white/5 bg-slate-950/40 hover:border-white/10'
                }`}
              >
                <span className="block text-xs font-medium text-slate-200">{avatar.label}</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">{avatar.note}</span>
              </button>
            </li>
          )
        })}

        {uploadedAvatars.map((avatar) => {
          const attivo = avatar.id === avatarId
          return (
            <li key={avatar.id}>
              <div
                className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                  attivo ? 'border-sky-400/60 bg-sky-500/10' : 'border-white/5 bg-slate-950/40'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setAvatar(avatar.id)}
                  aria-pressed={attivo}
                  className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
                >
                  <span className="block truncate text-xs font-medium text-slate-200">{avatar.name}</span>
                  <span className="block text-[10px] text-slate-500">
                    {(avatar.size / 1024 / 1024).toFixed(1)} MB · dal tuo computer
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void rimuovi(avatar.id)}
                  aria-label={`Rimuovi ${avatar.name}`}
                  className="shrink-0 rounded px-1 text-[11px] text-slate-600 transition hover:text-rose-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
                >
                  ✕
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <label
        className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 px-2.5 py-2 text-[11px] text-slate-400 transition hover:border-sky-400/50 hover:text-slate-300 focus-within:ring-1 focus-within:ring-sky-500/60"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const file = event.dataTransfer.files[0]
          if (file) void carica(file)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".vrm,model/gltf-binary"
          className="sr-only"
          disabled={occupato}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void carica(file)
          }}
        />
        {occupato ? 'carico…' : 'carica un .vrm o trascinalo qui'}
      </label>

      {senzaVisemi && (
        <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/40 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
          Questo modello ha {vocali} vocali su 5. Il lip-sync funzionerà solo in parte: manca
          {vocali === 4 ? ' una vocale' : ` ${5 - vocali} vocali`}.
        </p>
      )}

      {errore !== null && (
        <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/50 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200">
          {errore}
        </p>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        I modelli che carichi restano su questo computer, in IndexedDB, e non passano da nessun
        server. Non vengono inviati da nessuna parte. Attenzione alle licenze: se un modello è
        vietato per la ridistribuzione, puoi usarlo qui ma non pubblicarlo.
      </p>

      {avatarId !== DEFAULT_AVATAR_ID && (
        <button
          type="button"
          onClick={() => setAvatar(DEFAULT_AVATAR_ID)}
          className="mt-2 w-full rounded-lg bg-slate-800 py-1.5 text-[11px] text-slate-300 transition hover:bg-slate-700"
        >
          torna all'avatar predefinito
        </button>
      )}
    </div>
  )
}