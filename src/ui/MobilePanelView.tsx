import { useState, type ReactNode } from 'react'

/**
 * Vista a schermo intero con schede, per viewport stretti.
 *
 * Sotto i 1024px due colonne da 20rem non ci stanno: si sommano a 640px e
 * schiacciano l'avatar. Un cassetto laterale risolverebbe la larghezza ma non
 * l'altezza — i pannelli sono alti, e su un telefono in verticale ruberebbero
 * comunque quasi tutto. Perciò schermo intero: si configura con tutte le
 * dimensioni, e si torna all'avatar chiudendo.
 *
 * Intestazione e schede sono fuori dall'area che scorre: è il contenuto a
 * essere alto, non la barra su cui si cambia vista.
 */
export interface MobilePanelViewProps {
  chat: ReactNode
  camera: ReactNode
  onClose: () => void
}

export function MobilePanelView({ chat, camera, onClose }: MobilePanelViewProps) {
  const tabs = [
    { id: 'chat', label: 'Chat', content: chat },
    { id: 'camera', label: 'Camera', content: camera },
  ] as const
  const [active, setActive] = useState<(typeof tabs)[number]['id']>('chat')
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-slate-950/95 backdrop-blur-md lg:hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-slate-200">Impostazioni</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi e torna all'avatar"
          className="ml-auto rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
        >
          chiudi
        </button>
      </header>

      <div role="tablist" aria-label="Pannelli" className="flex shrink-0 gap-1 border-b border-white/10 px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            aria-controls={`tab-${t.id}`}
            id={`tabbtn-${t.id}`}
            onClick={() => setActive(t.id)}
            className={`-mb-px border-b-2 px-3 py-2.5 text-xs font-medium transition focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60 ${
              active === t.id
                ? 'border-sky-400 text-sky-200'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`tab-${tab.id}`}
        aria-labelledby={`tabbtn-${tab.id}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
      >
        {tab.content}
      </div>
    </div>
  )
}