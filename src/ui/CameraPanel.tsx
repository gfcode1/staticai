import { CAMERA_DISTANCE, CAMERA_TARGET_HEIGHT, FRAMING_LABELS } from '../config'
import { applyFraming, setBlinkWhileSpeaking, setCamera, useAppState } from '../store/appStore'
import type { Framing } from '../vrm/framing'

const FRAMINGS = Object.keys(FRAMING_LABELS) as Framing[]

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-slate-300">
          {label}
        </label>
        <span className="text-xs tabular-nums text-slate-500">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400"
      />
    </div>
  )
}

/**
 * Pannello di inquadratura.
 *
 * I valori di default non sono cablati: `computeFraming` li deriva dal modello
 * caricato, quindi gli stessi cursori funzionano con un avatar alto 1.55 m e con
 * uno alto 1.7 m, o con un modello in T-pose che correggeremo.
 */
export function CameraPanel() {
  const { avatarPhase, camera, framing, framingOptions, voice } = useAppState()
  const ready = avatarPhase === 'ready' && framingOptions !== null

  return (
    <div role="group" aria-label="Inquadratura della camera">
      <div role="group" aria-label="Inquadratura" className="grid grid-cols-3 gap-1 rounded-lg bg-slate-800/60 p-1">
        {FRAMINGS.map((option) => (
          <button
            key={option}
            type="button"
            disabled={!ready}
            onClick={() => applyFraming(option)}
            aria-pressed={framing === option}
            className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              framing === option
                ? 'bg-sky-500/90 text-slate-950'
                : 'text-slate-400 hover:bg-slate-700/70 hover:text-slate-200'
            }`}
          >
            {FRAMING_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        <Slider
          id="camera-distance"
          label="Distanza"
          value={camera.distance}
          min={CAMERA_DISTANCE.min}
          max={CAMERA_DISTANCE.max}
          step={CAMERA_DISTANCE.step}
          format={(value) => `${value.toFixed(2)} m`}
          onChange={(distance) => setCamera({ distance })}
        />

        <Slider
          id="camera-target-height"
          label="Altezza sguardo"
          value={camera.targetHeight}
          min={CAMERA_TARGET_HEIGHT.min}
          max={CAMERA_TARGET_HEIGHT.max}
          step={CAMERA_TARGET_HEIGHT.step}
          format={(value) => `${value.toFixed(2)} m`}
          onChange={(targetHeight) => setCamera({ targetHeight })}
        />
      </div>

      <label
        className={`mt-4 flex items-center gap-2.5 text-xs text-slate-300 ${
          ready ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
        }`}
      >
        <input
          type="checkbox"
          checked={camera.orbitEnabled}
          disabled={!ready}
          onChange={(event) => setCamera({ orbitEnabled: event.target.checked })}
          className="size-3.5 accent-sky-400"
        />
        Rotazione libera col mouse
      </label>

      {/*
        Comportamento, non inquadratura: qui vivono le scelte che cambiano il
        modo in cui l'avatar si muove. Il blink sta in `voice` perché è una
        proprietà di chi parla, non dell'inquadratura — ma il pannello è questo,
        perché è l'unico sempre raggiungibile su schermi stretti.
      */}
      <fieldset className="mt-5 border-t border-white/5 pt-4" disabled={!ready}>
        <legend className="sr-only">Comportamento dell'avatar</legend>
        <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Comportamento
        </p>

        <label className={`flex items-center gap-2.5 text-xs text-slate-300 ${ready ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}>
          <input
            type="checkbox"
            checked={voice.blinkWhileSpeaking}
            onChange={(event) => setBlinkWhileSpeaking(event.target.checked)}
            className="size-3.5 accent-sky-400"
          />
          Lampeggia mentre parla
        </label>

        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          L&apos;avatar guarda verso di te e lampeggia da solo. Le persone
          lampeggiano parlando: disattivarlo lascia il viso immobile per tutta la
          risposta.
        </p>
      </fieldset>

      {camera.orbitEnabled && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Trascina per ruotare, rotella per lo zoom. Disattiva per tornare all'inquadratura frontale.
        </p>
      )}
    </div>
  )
}