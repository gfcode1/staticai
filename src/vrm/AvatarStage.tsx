import { useEffect, useRef } from 'react'
import {
  ACESFilmicToneMapping,
  Box3,
  Clock,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'
import type { VRM } from '@pixiv/three-vrm'

import { CAMERA_FOV } from '../config'
import { applyFraming, getState, setState, subscribe } from '../store/appStore'
import { CameraRig } from './cameraRig'
import { ExpressionRig } from './expressionRig'
import { computeFraming, locateFace, measureModel, relaxPose } from './framing'
import { IdleMotion } from './idleMotion'
import { disposeObject3D, loadAvatar } from './loadVrm'
import { speech } from '../speech/speechController'

/** Quante volte al secondo al massimo aggiorniamo la barra di progresso. */
const PROGRESS_THROTTLE_HZ = 12

export interface AvatarDiagnostics {
  specVersion: '0' | '1'
  expressions: string[]
  unlit: boolean
  hasSecondaryAnimation: boolean
  animatedBoneCount: number
  relaxedBones: number
  armVerticalityBefore: number
  modelHeight: number
  modelSpan: number
  eyeHeight: number
  faceWidth: number | null
  faceHeight: number | null
  faceBoxHeight: number | null
  mouthTravel: number
  drawCalls: number
  triangles: number
  /**
   * Frame per secondo misurati in media mobile.
   *
   * Utile soprattutto sui modelli con spring bone: sono loro che costano, e
   * senza un numero non si distingue "pesante" da "va bene".
   */
  fps: number
}

/** Dopo quanti frame il valore di fps viene ricalcolato da zero. */
const FPS_SAMPLE_FRAMES = 60

declare global {
  interface Window {
    /** Esposto per ispezionare il VRM dalla console del browser. */
    __avatarDiagnostics?: AvatarDiagnostics
    /**
     * Maniglie sui rig interni, disponibili SOLO in sviluppo
     * (`import.meta.env.DEV`): servono a verificare visemi e micro-movimenti dalla
     * console e a misurare il lip-sync nelle fasi successive. Non entra mai nella
     * build.
     */
    __avatar?: { vrm: VRM; expressions: ExpressionRig; idle: IdleMotion }
    /** Controller del linguaggio: permette di pilotare il lip-sync a mano. */
    __speech?: typeof import('../speech/speechController').speech
  }
}

/**
 * @param url Indirizzo già risolto del modello. Il componente va rimontato con
 *   `key={avatarId}`: tutto il setup Three.js nasce qui dentro e il teardown
 *   chiama `forceContextLoss()`. Senza un elemento nuovo, il renderer
 *   successivo troverebbe un contesto già perso e lo schermo resterebbe nero.
 */
export function AvatarStage({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Il canvas nasce qui e non nel JSX: React StrictMode monta due volte in
    // sviluppo, e riusare lo stesso elemento significa dare a WebGLRenderer un
    // contesto già perso dal `forceContextLoss()` del teardown precedente.
    // Un elemento fresco per ogni mount, rimosso insieme al suo contesto.
    const canvas = document.createElement('canvas')
    canvas.className = 'h-full w-full'
    container.appendChild(canvas)

    const abort = new AbortController()
    let disposed = false

    // ---------------------------------------------------------------- renderer
    const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05

    const scene = new Scene()

    // Le luci incidono sul risultato: i tre modelli inclusi sono MToon, e
    // three-vrm elimina `KHR_materials_unlit` dai materiali che lo dichiarano
    // insieme a MToon. Teniamo le luci per il modellaggio del viso e per
    // eventuali avatar con materiali diversi.
    const keyLight = new DirectionalLight(0xffffff, Math.PI)
    keyLight.position.set(1, 1.6, 1).normalize()
    scene.add(keyLight)
    scene.add(new HemisphereLight(0xbfd4ff, 0x30283a, Math.PI * 0.9))

    const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.01, 100)
    const cameraRig = new CameraRig(camera, canvas, getState().camera)

    // ---------------------------------------------------------------- look-at
    /**
     * Lo sguardo non insegue il puntatore.
     *
     * Qui non c'è nessun `pointermove`: il lookAt punta a un oggetto **fermo**
     * davanti al viso, quindi gli occhi guardano chi ascolta. La motivazione è
     * che un avatar che ti segue col mouse smette di sembrare una persona: ti
     * guarda solo quando passi sopra la sua testa.
     *
     * L'altezza la troviamo dal modello (`eyeHeight`), non dalla camera: con
     * l'inquadratura "bust" il punto inquadrato sta some decine di centimetri
     * sotto il viso, e usare quello farebbe guardare l'avatar verso il basso.
     */
    const lookAtTarget = new Object3D()
    /** Metri davanti al viso a cui puntano gli occhi. */
    const LOOK_AT_DISTANCE = 1
    scene.add(lookAtTarget)

    // ----------------------------------------------------------------- resize
    const resize = () => {
      const { clientWidth, clientHeight } = container
      if (clientWidth === 0 || clientHeight === 0) return
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / clientHeight
      camera.updateProjectionMatrix()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    resize()

    // ------------------------------------------------------------- diagnostica
    // Compilata al caricamento e pubblicata sul primo render valido.
    const diagnosticsRef: Omit<AvatarDiagnostics, 'drawCalls' | 'triangles'> = {
      specVersion: '1',
      expressions: [],
      unlit: false,
      hasSecondaryAnimation: false,
      animatedBoneCount: 0,
      relaxedBones: 0,
      armVerticalityBefore: 1,
      modelHeight: 0,
      modelSpan: 0,
      eyeHeight: 0,
      faceWidth: null,
      faceHeight: null,
      faceBoxHeight: null,
      mouthTravel: 0,
      fps: 60,
    }
    let avatarLoaded = false
    let diagnosticsReady = false

    // ------------------------------------------------------------ render loop
    let frameId = 0
    const clock = new Clock()
    let vrm: VRM | null = null
    let expressionRig: ExpressionRig | null = null
    let idleMotion: IdleMotion | null = null
    let framesRendered = 0
    let fps = 60

    const renderFrame = () => {
      frameId = window.requestAnimationFrame(renderFrame)
      const delta = Math.min(clock.getDelta(), 0.1)

      // L'ordine dei tre passaggi non è decorativo:
      //
      // 1. expressionRig imposta i PESI delle espressioni. `setValue` non scrive
      //    sui morph target: deposita solo il peso sull'oggetto espressione.
      //    Chi imposta i pesi qui dentro, in ordine:
      //      a) il lip-sync e il sorriso di fondo, se l'avatar sta parlando
      //      b) il blink automatico, sempre
      //    Sopracciglia, occhi e bocca si muovono insieme: è quello che fa
      //    sembrare vivo un viso.
      // 2. vrm.update() è l'unico che spinge quei pesi dentro
      //    `morphTargetInfluences`, e fa anche `humanoid.update()`, il lookAt e
      //    i spring bone. Senza questo passaggio i visemi non muovono nulla, gli
      //    occhi non guardano e capelli e vestiti restano rigidi.
      // 3. idleMotion agisce sulle ossa RAW dopo `humanoid.update()`, che le
      //    risincronizza dai ossa normalizzate: se lo precedessimo, il nostro
      //    micro-movimento verrebbe sovrascritto.
      speech.update()
      expressionRig?.update(delta)
      vrm?.update(delta)
      idleMotion?.update(delta)

      renderer.render(scene, camera)
      framesRendered += 1

      // I contatori del renderer sono validi solo DOPO il primo render che
      // include il modello: leggerli subito dopo scene.add() dà sempre zero.
      if (avatarLoaded && !diagnosticsReady) {
        diagnosticsReady = true
        window.__avatarDiagnostics = {
          ...diagnosticsRef,
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          fps: Math.round(fps),
        }
      }

      // Media mobile su un secondo. Serve a misurare il costo dei spring bone:
      // senza un numero, "sembra lento" e "va bene" si confondono.
      if (delta > 0) {
        const instant = 1 / delta
        fps = framesRendered % FPS_SAMPLE_FRAMES === 0 ? instant : fps + (instant - fps) * 0.05
      }
    }

    frameId = window.requestAnimationFrame(renderFrame)

    // ----------------------------------------------------------------- avatar
    let lastProgressAt = 0
    setState({ avatarPhase: 'loading', avatarProgress: 0, avatarError: null })

    loadAvatar(url, {
      signal: abort.signal,
      onProgress: (ratio) => {
        const now = performance.now()
        if (now - lastProgressAt < 1000 / PROGRESS_THROTTLE_HZ) return
        lastProgressAt = now
        if (!disposed) setState({ avatarProgress: ratio })
      },
    })
      .then((loaded) => {
        if (disposed || abort.signal.aborted) {
          disposeObject3D(loaded.vrm.scene)
          return
        }

        vrm = loaded.vrm

        // La T-pose dei VRM 0.0 va corretta PRIMA di catturare le pose base:
        // IdleMotion deve costruire i micro-movimenti sulla posa rilassata.
        const pose = relaxPose(vrm)
        vrm.scene.updateMatrixWorld(true)

        scene.add(vrm.scene)
        if (vrm.lookAt) vrm.lookAt.target = lookAtTarget

        expressionRig = new ExpressionRig(vrm)
        idleMotion = new IdleMotion(vrm)
        // Il controller del linguaggio deve poter scrivere sui visemi: gli
        // passiamo il riferimento al rig appena creato.
        speech.attachRig(expressionRig)
        if (import.meta.env.DEV && idleMotion) {
          window.__avatar = { vrm, expressions: expressionRig, idle: idleMotion }
          window.__speech = speech
        }

        // L'inquadratura si calcola sul modello reale: i default cablati finirebbero
        // dentro la faccia o taglierebbero la testa a seconda dell'avatar.
        const framingOptions = computeFraming(vrm, camera.fov, camera.aspect)
        const metrics = measureModel(vrm)
        const face = locateFace(vrm)

        setState({ framingOptions })
        // Se l'utente non ha ancora toccato i cursori, applichiamo il default del modello.
        if (!getState().cameraCustomized) applyFraming(getState().framing)

        // Il punto su cui puntano gli occhi: davanti al viso, non davanti alla
        // camera. Con il viso localizzato usiamo la sua altezza reale; in sua
        // assenza ripieghiamo sulla stima degli occhi.
        lookAtTarget.position.set(0, face?.center.y ?? metrics.eyeHeight, LOOK_AT_DISTANCE)
        lookAtTarget.updateMatrixWorld(true)

        addContactShadow(vrm)

        Object.assign(diagnosticsRef, {
          specVersion: loaded.specVersion,
          expressions: loaded.expressions,
          unlit: loaded.unlit,
          hasSecondaryAnimation: loaded.hasSecondaryAnimation,
          animatedBoneCount: idleMotion.animatedBoneCount,
          relaxedBones: pose.correctedBones,
          armVerticalityBefore: round(pose.armVerticality),
          modelHeight: round(metrics.height),
          modelSpan: round(metrics.span),
          eyeHeight: round(metrics.eyeHeight),
          faceWidth: face ? round(face.width) : null,
          faceHeight: face ? round(face.center.y) : null,
          faceBoxHeight: face ? round(face.height) : null,
          mouthTravel: round(face?.mouthTravel ?? 0),
        })

        const missing = ['aa', 'ee', 'ih', 'oh', 'ou'].filter((name) => !loaded.expressions.includes(name))
        console.info(
          `[avatar] VRM ${loaded.specVersion}.0 · altezza ${metrics.height.toFixed(2)} m · ` +
            `apertura ${metrics.span.toFixed(2)} m · occhi a ${metrics.eyeHeight.toFixed(2)} m\n` +
            `[avatar] viso: ${face ? `${round(face.width)}x${round(face.height)} m, centro a y=${round(face.center.y)}, apertura max ${round(face.mouthTravel * 1000)} mm` : 'non localizzato'}\n` +
            `[avatar] espressioni: ${loaded.expressions.join(', ') || 'nessuna'}` +
            (missing.length ? ` · vocali mancanti: ${missing.join(', ')}` : ' · lip-sync pronto') +
            `\n[avatar] unlit=${loaded.unlit} · springBone=${loaded.hasSecondaryAnimation} · ` +
            `posa braccia: ${pose.corrected ? `corretta dalla T-pose (inclinazione ${round(pose.armVerticality)})` : 'già rilassata'} · ossa animate=${idleMotion.animatedBoneCount}`,
        )
        if (missing.length > 0) {
          console.warn(
            '[avatar] Nessun preset vocale completo: la Fase 2 dovrà pilotare i morph target direttamente.',
          )
        }

        avatarLoaded = true
        setState({ avatarPhase: 'ready', avatarProgress: 1, availableExpressions: loaded.expressions })
      })
      .catch((error: unknown) => {
        if (disposed || abort.signal.aborted) return
        const message = error instanceof Error ? error.message : 'Errore sconosciuto durante il caricamento.'
        console.error('[avatar] caricamento fallito', error)
        setState({ avatarPhase: 'error', avatarError: message })
      })

    // Le preferenze camera arrivano dal pannello UI tramite il negozio: le
    // applichiamo alla rig senza mai ricreare scena, renderer e render loop.
    const unsubscribe = subscribe(() => {
      if (disposed) return
      cameraRig.setSettings(getState().camera)
      // Lo sguardo non dipende dalla camera: resta sul viso, quindi qui non
      // c'è niente da riallineare quando l'utente tocca i cursori.
    })

    // ---------------------------------------------------------------- teardown
    return () => {
      disposed = true
      unsubscribe()
      abort.abort()

      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()

      if (expressionRig) speech.detachRig(expressionRig)
      void speech.interrupt()

      idleMotion?.dispose()
      expressionRig?.dispose()
      cameraRig.dispose()

      disposeObject3D(scene)
      renderer.dispose()
      // Libera il contesto WebGL: senza questo Chrome mantiene gli shader compilati
      // in memoria anche dopo lo smontaggio del canvas.
      renderer.forceContextLoss()
      canvas.remove()

      delete window.__avatarDiagnostics
      delete window.__avatar
      delete window.__speech
    }

    // `url` **non** è nelle dipendenze, di proposito. Questo effetto deve girare
    // una volta per mount e mai più, perché il teardown distrugge il contesto
    // WebGL dello stesso elemento `canvas`. È `key={avatarId}` in `App` a fare
    // da garanzia: un URL diverso arriva su un mount nuovo. Metterlo qui
    // rimetterebbe il renderer sopra un contesto perso, con lo schermo nero —
    // esattamente il difetto che la `key` esiste per evitare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className="absolute inset-0" />
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Alone scuro sotto i piedi, così l'avatar non fluttua sul gradiente di fondo.
 *
 * Non è un'ombra vera: un `DirectionalLight` con `castShadow` costerebbe una
 * shadow map e un secondo giro di rendering, e su MToon il risultato è spesso
 * deludente. Qui basta un disco scuro a terra, piazzato sul `min.y` reale del
 * modello e largo quanto il suo occupato orizzontale: due triangoli e zero costo
 * per frame.
 *
 * Il materiale è `MeshBasicMaterial` e nient'altro: nessuna luce lo tocca, quindi
 * resta scuro qualunque avatar si carichi, anche con materiale unlit.
 */
function addContactShadow(vrm: VRM): void {
  const bounds = new Box3()
  for (const child of vrm.scene.children) {
    const childBox = new Box3().setFromObject(child)
    if (!childBox.isEmpty()) bounds.union(childBox)
  }
  if (bounds.isEmpty()) return

  // Mezza larghezza del modello come diametro esterno: l'alone arriva appena
  // oltre i piedi, che è dove uno standing-contact-shadow finisce comunque.
  const diametro = Math.max(bounds.max.x - bounds.min.x, 0.1) * 0.9

  const shadow = new Mesh(
    new RingGeometry(diametro * 0.35, diametro * 0.5, 48),
    new MeshBasicMaterial({
      color: 0x05070c,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  )
  // `RingGeometry` sta sul piano XY: va ruotato per appoggiarsi a terra, che è
  // il piano XZ.
  shadow.name = 'contactShadow'
  shadow.rotation.x = -Math.PI / 2
  shadow.position.set(0, bounds.min.y + 0.001, 0)
  shadow.renderOrder = -1
  vrm.scene.add(shadow)
}