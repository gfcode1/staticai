import { useAppState, type AvatarPhase } from '../store/appStore'

const PHASE_META: Record<AvatarPhase, { label: string; dot: string; text: string }> = {
  idle: { label: 'In attesa', dot: 'bg-slate-500', text: 'text-slate-400' },
  loading: { label: 'Caricamento', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
  ready: { label: 'Pronto', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  error: { label: 'Errore', dot: 'bg-rose-500', text: 'text-rose-300' },
}

export function StatusBar() {
  const { avatarPhase, availableExpressions } = useAppState()
  const meta = PHASE_META[avatarPhase]

  const vowels = ['aa', 'ee', 'ih', 'oh', 'ou'].filter((name) => availableExpressions.includes(name)).length
  const lipSyncReady = vowels === 5

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <span className={`inline-flex items-center gap-2 ${meta.text}`}>
        <span className={`size-1.5 rounded-full ${meta.dot}`} aria-hidden />
        {meta.label}
      </span>

      {avatarPhase === 'ready' && (
        <>
          <span className="text-slate-600">·</span>
          <span className="text-slate-500">
            {availableExpressions.length} espressioni
            <span className="text-slate-600"> · </span>
            {lipSyncReady ? (
              <span className="text-emerald-400/80">lip-sync pronto</span>
            ) : (
              <span className="text-amber-400/80">
                {vowels}/5 vocali — il lip-sync andrà pilotato sui morph target
              </span>
            )}
          </span>
        </>
      )}
    </footer>
  )
}