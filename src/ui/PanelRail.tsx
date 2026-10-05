import type { ReactNode } from 'react'

import { useAppState, setAllPanels } from '../store/appStore'

/**
 * Colonna dei pannelli, ancorata a sinistra.
 *
 * Ha un'altezza massima e scorre **da sola**. È il punto in cui il difetto di
 * partenza trova una soluzione strutturale: quando i pannelli aperti non
 * entrano, a scorrere è questa colonna, non la pagina. La barra inferiore sta
 * fuori da questo flusso, quindi non la tocca.
 *
 * L'altezza usa `dvh` invece di `vh`: sui browser mobili `100vh` include la
 * barra degli indirizzi e il fondo della colonna finirebbe sotto la barra di
 * sistema, irraggiungibile col dito.
 */
export function PanelRail({ children }: { children: ReactNode }) {
  const { panels } = useAppState()
  const aperti = Object.values(panels).filter(Boolean).length

  return (
    <div className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 2xl:w-80">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[10px] uppercase tracking-widest text-slate-600">
          {/* Il singolare conta: "1 pannelli aperti" è il tipo di dettaglio che
              fa credere che nessuno abbia riletto la schermata. */}
          {aperti === 0
            ? 'nessun pannello aperto'
            : `${aperti} ${aperti === 1 ? 'pannello aperto' : 'pannelli aperti'}`}
        </span>
        {aperti > 0 && (
          <button
            type="button"
            onClick={() => setAllPanels(false)}
            className="rounded-md px-2 py-1 text-[10px] text-slate-500 transition hover:text-slate-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
          >
            chiudi tutto
          </button>
        )}
      </div>

      {/*
        `shrink-0` sui figli è indispensabile, non decorativo. In un contenitore
        `flex-col` i figli si comprimono per entrare nello spazio disponibile: il
        pannello verrebbe schiacciato invece di traboccare, `scrollHeight`
        resterebbe uguale a `clientHeight` e lo scorrimento non si attiverebbe
        mai. Con `shrink-0` i pannelli tengono la loro altezza naturale ed è la
        colonna a scorrere.
      */}
      <div className="pointer-events-auto flex max-h-[calc(100dvh-11rem)] flex-col gap-2 overflow-y-auto overscroll-contain pr-0.5 [&>*]:shrink-0">
        {children}
      </div>
    </div>
  )
}