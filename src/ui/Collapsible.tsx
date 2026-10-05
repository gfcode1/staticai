import { useId, useState, type ReactNode } from 'react'

/**
 * Pannello che si apre e si chiude.
 *
 * Esiste per un motivo preciso: nello scheletro originale i pannelli erano
 * `<section>` fissi in cima, in un `flex justify-between`. Quando il loro
 * contenuto superava l'altezza utile, la barra inferiore veniva spinta fuori dal
 * viewport e il pulsante del microfono spariva. Il problema non era il testo
 * troppo lungo, era che **niente era comprimibile**: l'utente non aveva modo di
 * rientrare nei limiti senza chiudere il browser.
 *
 * Chiudibile significa che l'altezza la decide l'utente, non il layout.
 */

export interface CollapsibleProps {
  title: string
  /** Testo breve a destra del titolo: stato, conteggio, avviso. */
  badge?: ReactNode
  defaultOpen?: boolean
  /** Controllato: se presente, lo stato viene da fuori. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Ordine di lettura per gli screen reader, quando il pannello è chiuso. */
  hint?: string
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export function Collapsible({
  title,
  badge,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  hint,
  children,
  className = '',
  bodyClassName = '',
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const bodyId = useId()

  const toggle = (): void => {
    const next = !open
    if (!isControlled) setInternalOpen(next)
    onOpenChange?.(next)
  }

  return (
    <section className={`overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70 shadow-2xl backdrop-blur-md ${className}`}>
      <h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
        >
          {/* La freccia ruota: da sola dice in che direzione si apre. */}
          <svg
            viewBox="0 0 20 20"
            aria-hidden
            className={`size-3.5 shrink-0 text-slate-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          >
            <path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>

          <span className="text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</span>

          <span className="ml-auto truncate text-[10px] text-slate-500">{badge}</span>

          {!open && hint !== undefined && <span className="sr-only">{hint}</span>}
        </button>
      </h2>

      {/*
        `hidden` e non solo opacità: un pannello chiuso che occupa spazio e non
        si vede è lo stesso difetto di partenza, solo meno evidente.
      */}
      <div id={bodyId} hidden={!open} className={bodyClassName}>
        {children}
      </div>
    </section>
  )
}