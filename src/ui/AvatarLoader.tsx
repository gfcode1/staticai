import { useAppState } from '../store/appStore'

/**
 * Sovrapposizione mostrata mentre il modello viene scaricato e analizzato.
 * Scompare con una transizione quando l'avatar è pronto.
 */
/**
 * @param errorOverride Errore arrivato prima ancora che il caricamento parta —
 *   per un modello scelto dall'utente che non esiste più. Senza, la schermata
 *   resterebbe su "caricamento" all'infinito senza dire perché.
 */
export function AvatarLoader({ errorOverride = null }: { errorOverride?: string | null }) {
  const { avatarPhase, avatarProgress, avatarError } = useAppState()

  const errore = errorOverride ?? avatarError

  // Senza modello da caricare non c'è nemmeno il pulsante "riprova": ricaricare
  // la pagina risolverebbe lo stesso identico errore.
  if (errorOverride !== null) {
    return (
      <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/85 p-6 backdrop-blur-sm">
        <div className="max-w-md rounded-2xl border border-rose-500/30 bg-rose-950/40 p-6 text-center">
          <h2 className="text-lg font-semibold text-rose-200">Modello non disponibile</h2>
          <p className="mt-2 text-sm text-rose-100/70">{errorOverride}</p>
          <p className="mt-3 text-xs text-rose-100/50">
            Se il file era stato caricato dal disco, potrebbe essere stato rimosso. Scegli un altro
            avatar dalla lista.
          </p>
          <p className="mt-3 text-xs text-rose-100/50">
            Nota: un modello caricato dal disco vive solo in questo browser e su questo computer.
          </p>
        </div>
      </div>
    )
  }

  if (avatarPhase === 'ready') return null

  if (avatarPhase === 'error') {
    return (
      <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/85 p-6 backdrop-blur-sm">
        <div className="max-w-md rounded-2xl border border-rose-500/30 bg-rose-950/40 p-6 text-center">
          <h2 className="text-lg font-semibold text-rose-200">Impossibile caricare l'avatar</h2>
          <p className="mt-2 text-sm text-rose-100/70">
            {errore ?? 'Errore sconosciuto durante il caricamento del modello.'}
          </p>
          <p className="mt-3 text-xs text-rose-100/50">
            Verifica che il file del modello esista in{' '}
            <code className="text-rose-200/80">public/models/</code> e che il server di sviluppo sia avviato
            con <code className="text-rose-200/80">npm run dev</code>.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-lg bg-rose-400/90 px-4 py-2 text-sm font-medium text-rose-950 transition hover:bg-rose-300"
          >
            Riprova
          </button>
        </div>
      </div>
    )
  }

  const percent = Math.round(avatarProgress * 100)

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/80 p-6 backdrop-blur-sm">
      <div className="w-full max-w-xs text-center">
        <div className="mx-auto mb-5 size-16 animate-pulse rounded-full border-2 border-sky-400/30 border-t-sky-300" />
        <p className="text-sm font-medium text-slate-200">Caricamento dell'avatar…</p>

        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={avatarProgress > 0 ? percent : undefined}
          aria-label="Avanzamento del caricamento del modello"
        >
          {avatarProgress > 0 ? (
            <div
              className="h-full rounded-full bg-sky-400 transition-[width] duration-200 ease-out"
              style={{ width: `${percent}%` }}
            />
          ) : (
            // Senza Content-Length il server non può dirci la percentuale:
            // mostriamo un tratto indeterminato invece di fingere uno zero.
            <div className="h-full w-1/3 animate-[loading_1.4s_ease-in-out_infinite] rounded-full bg-sky-400/70" />
          )}
        </div>

        <p className="mt-3 text-xs tabular-nums text-slate-400">
          {avatarProgress > 0 ? `${percent}%` : 'Avvio in corso…'}
        </p>
      </div>
    </div>
  )
}