import { Vector3, type PerspectiveCamera } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import type { CameraSettings } from '../store/appStore'
import { CAMERA_DISTANCE } from '../config'

/**
 * Telecamera pilotata dall'utente.
 *
 * La camera sta sul lato **+Z** del punto inquadrato: secondo la specifica VRM
 * gli avatar guardano verso +Z, e `VRMUtils.rotateVRM0` ruota i VRM 0.x di 180°
 * proprio per normalizzarli a questa convenzione. Quindi la stessa regola vale per
 * entrambe le versioni dello spec.
 *
 * Due modalità in mutua esclusione:
 *  - orbit disattivato: la camera resta sulla scia frontale del viso e obbedisce
 *    solo agli slider (distanza + altezza). È il default, perché un utente che
 *    trascina col mouse per sbaglio non deve ritrovarsi con l'avatar di spalle.
 *  - orbit attivo: OrbitControls con damping prende il sopravvento; gli slider
 *    continuano a funzionare per il campo di distanza.
 */
export class CameraRig {
  private readonly camera: PerspectiveCamera
  private readonly domElement: HTMLElement
  private controls: OrbitControls | null = null
  private orbitEnabled: boolean

  private readonly target = new Vector3()
  private readonly desiredTarget = new Vector3()
  private readonly desiredPosition = new Vector3()
  private desiredDistance: number

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, settings: CameraSettings) {
    this.camera = camera
    this.domElement = domElement
    this.orbitEnabled = settings.orbitEnabled
    this.desiredDistance = settings.distance

    this.desiredTarget.set(0, settings.targetHeight, 0)
    this.target.copy(this.desiredTarget)

    this.applyImmediately()
    domElement.addEventListener('contextmenu', this.preventContextMenu)
  }

  get isOrbitEnabled(): boolean {
    return this.orbitEnabled
  }

  setSettings(settings: CameraSettings): void {
    const previous = this.orbitEnabled
    this.orbitEnabled = settings.orbitEnabled

    if (this.orbitEnabled && !this.controls) this.enableControls()
    if (!this.orbitEnabled && this.controls) this.disableControls()

    this.desiredDistance = settings.distance
    this.desiredTarget.set(0, settings.targetHeight, 0)

    if (!this.orbitEnabled || !previous) {
      if (this.controls) {
        this.controls.target.copy(this.desiredTarget)
        this.controls.minDistance = CAMERA_DISTANCE.min
        this.controls.maxDistance = CAMERA_DISTANCE.max
      }
      this.applyImmediately()
    }
  }

  update(deltaSeconds: number): void {
    if (this.controls?.enabled) {
      this.controls.update()
      return
    }

    // Inseguimento morbido della posizione desiderata: niente scatti quando
    // l'utente trascina uno slider.
    const alpha = 1 - Math.exp(-deltaSeconds / 0.09)
    this.target.lerp(this.desiredTarget, alpha)

    this.desiredPosition.copy(this.target)
    this.desiredPosition.z += this.desiredDistance

    this.camera.position.lerp(this.desiredPosition, alpha)
    this.camera.lookAt(this.target)
  }

  dispose(): void {
    this.domElement.removeEventListener('contextmenu', this.preventContextMenu)
    this.disableControls()
  }

  private enableControls(): void {
    const controls = new OrbitControls(this.camera, this.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = false
    controls.minDistance = CAMERA_DISTANCE.min
    controls.maxDistance = CAMERA_DISTANCE.max
    controls.minPolarAngle = Math.PI * 0.15
    controls.maxPolarAngle = Math.PI * 0.85
    controls.target.copy(this.desiredTarget)
    this.controls = controls
  }

  private disableControls(): void {
    this.controls?.dispose()
    this.controls = null
  }

  private applyImmediately(): void {
    this.target.copy(this.desiredTarget)
    this.camera.position.set(0, this.desiredTarget.y, this.desiredDistance)
    this.camera.lookAt(this.target)
  }

  private readonly preventContextMenu = (event: Event): void => {
    event.preventDefault()
  }
}