import { useState } from 'react'

import { AvatarStage } from './vrm/AvatarStage'
import { useAvatarUrl } from './ui/useAvatarUrl'
import { AvatarLoader } from './ui/AvatarLoader'
import { AvatarPicker } from './ui/AvatarPicker'
import { CameraPanel } from './ui/CameraPanel'
import { Collapsible } from './ui/Collapsible'
import { ChatPanel } from './ui/ChatPanel'
import { MemoryPanel } from './ui/MemoryPanel'
import { MicButton } from './ui/MicButton'
import { MobilePanelView } from './ui/MobilePanelView'
import { PanelRail } from './ui/PanelRail'
import { StatusBar } from './ui/StatusBar'
import { useWideLayout } from './ui/useMediaQuery'
import { useAppState, setPanel } from './store/appStore'
import { bundledById } from './vrm/avatarLibrary'

/**
 * Scheletro a due zone sovrapposte.
 *
 * Il principio è una sola cosa: **la barra del microfono non sta nel flusso**.
 * Prima stava dentro un `flex justify-between` insieme ai pannelli, e quando
 * quelli crescevano la barra veniva spinta sotto il bordo del viewport, dove
 * `overflow-hidden` la tagliava. Il sintomo era "il pulsante del microfono
 * sparisce", la causa era che nulla limitava l'altezza della colonna dei
 * controlli.
 *
 * Ora la barra è ancorata in assoluto e non ha antenati in grado di spostarla:
 * per quanto si apra, si può chiudere e si scrive, il pulsante resta dov'è.
 */
/** Il nome dell'avatar in uso, per il pannello chiuso. */
function avatarLabel(avatarId: string, caricati: { id: string; name: string }[]): string {
  return bundledById(avatarId)?.label ?? caricati.find((a) => a.id === avatarId)?.name ?? 'dal tuo computer'
}

export default function App() {
  const { panels, memories, avatarId, uploadedAvatars } = useAppState()
  const { url: urlAvatar, error: avatarUrlError } = useAvatarUrl(avatarId)
  const wide = useWideLayout()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Sfondo: gradiente radiale. Le luci della scena incidono sui materiali
          MToon, ma un fondo piatto darebbe all'avatar solo contorno: il
          gradiente mette in gradazione la scena e stacca la figura. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,#1c2333_0%,#0e1119_55%,#08090d_100%)]"
      />

      {/*
        `key` non è un dettaglio: `AvatarStage` crea il renderer e al teardown
        chiama `forceContextLoss()`. Senza un mount nuovo, il renderer successivo
        troverebbe un contesto perso e lo schermo resterebbe nero.
      */}
      {urlAvatar !== null && <AvatarStage key={avatarId} url={urlAvatar} />}
      <AvatarLoader errorOverride={avatarUrlError} />

      {/* Zona superiore: rail a sinistra, nastro dei pannelli a destra. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-4 sm:p-6">
        <div className="pointer-events-auto flex flex-col gap-3">
          <header className="rounded-2xl border border-white/10 bg-slate-900/70 px-4 py-3 shadow-2xl backdrop-blur-md">
            <h1 className="text-sm font-semibold tracking-tight text-slate-100">Assistente VRM</h1>
            <p className="mt-0.5 text-xs text-slate-500">Fase 0–4 · scena 3D, voce, ascolto e chat</p>
          </header>

          {wide && (
            <PanelRail>
              <Collapsible
                title="Avatar"
                open={panels.avatar}
                onOpenChange={(open) => setPanel('avatar', open)}
                badge={panels.avatar ? undefined : avatarLabel(avatarId, uploadedAvatars)}
                bodyClassName="px-4 pb-4"
              >
                <AvatarPicker />
              </Collapsible>

              <Collapsible
                title="Chat"
                open={panels.chat}
                onOpenChange={(open) => setPanel('chat', open)}
                badge={panels.chat ? undefined : 'conversazione'}
                bodyClassName="px-4 pb-4"
              >
                <ChatPanel />
              </Collapsible>

              <Collapsible
                title="Ricordi"
                open={panels.memory}
                onOpenChange={(open) => setPanel('memory', open)}
                badge={panels.memory ? undefined : `${memories.length} ricordi · profilo`}
                bodyClassName="px-4 pb-4"
              >
                <MemoryPanel />
              </Collapsible>

            </PanelRail>
          )}

          {!wide && !mobileOpen && (
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="w-fit rounded-xl border border-white/10 bg-slate-900/80 px-4 py-2.5 text-xs font-medium text-slate-200 shadow-2xl backdrop-blur-md transition hover:bg-slate-800/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60"
            >
              {panels.chat ? 'Chat e impostazioni' : 'Impostazioni'}
            </button>
          )}
        </div>

        {wide && (
          <div className="pointer-events-auto flex w-[min(18rem,calc(100vw-2rem))] flex-col gap-2">
            <Collapsible
              title="Camera"
              open={panels.camera}
              onOpenChange={(open) => setPanel('camera', open)}
              badge={panels.camera ? undefined : 'inquadratura'}
              bodyClassName="px-4 pb-4"
            >
              <CameraPanel />
            </Collapsible>
          </div>
        )}
      </div>

      {!wide && mobileOpen && (
        <MobilePanelView
          chat={<ChatPanel />}
          camera={<CameraPanel />}
          onClose={() => setMobileOpen(false)}
        />
      )}

      {/*
        Barra ancorata. `absolute bottom-0` la mette fuori dal flusso dei
        pannelli: è la ragione per cui il difetto non può tornare.
      */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent px-4 pb-3 pt-12 sm:px-6 sm:pb-4">
        <div className="pointer-events-auto">
          <MicButton />
        </div>
        <div className="flex w-full items-end justify-between gap-4">
          <StatusBar />
          {import.meta.env.DEV && (
            <p className="hidden text-[11px] text-slate-600 sm:block">
              Console: <code className="text-slate-500">window.__avatarDiagnostics</code>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
