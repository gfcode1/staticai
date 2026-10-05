import { Euler, Quaternion } from 'three'
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm'

const DEG = Math.PI / 180
const TAU = Math.PI * 2

interface BoneChannel {
  base: Quaternion
  node: import('three').Object3D
  period: number
  phase: number
  axes: { x: number; y: number; z: number }
}

interface BoneSpec {
  bone: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName]
  /** Periodo in secondi. Periodi diversi e non commensurabili => mai ripetitivo. */
  period: number
  phase: number
  /** Ampiezze angolari in radianti, per asse. */
  axes: { x: number; y: number; z: number }
}

/**
 * Generatore di rumore 1D interpolato. Più organico di una somma di sinusoidi
 * per i micro-movimenti, che devono sembrare casuali ma restare continui.
 */
class SmoothNoise {
  private current = 0
  private target = 0
  private nextChangeAt = Number.POSITIVE_INFINITY

  update(deltaSeconds: number, clock: number, minSeconds: number, maxSeconds: number): number {
    if (clock >= this.nextChangeAt) {
      this.target = Math.random() * 2 - 1
      this.nextChangeAt = clock + minSeconds + Math.random() * (maxSeconds - minSeconds)
    }
    this.current += (this.target - this.current) * Math.min(1, deltaSeconds * 1.6)
    return this.current
  }
}

/**
 * Ampiezze nominali, in gradi, per ossa.
 *
 * Sono più piccole di quanto sembrerebbe necessario guardando la tabella, e la
 * ragione è il raddoppio: **i tre modelli inclusi hanno spring bone**, quindi
 * ogni grado di testa diventa un movimento di capelli e di colletti. Le
 * ampiezze sono state ridimensionate quando sono arrivati quei modelli; con
 * avatar senza fisica si può tornare su valori doppi senza che nulla appaia
 * sbagliato.
 */
const SPECS: BoneSpec[] = [
  { bone: VRMHumanBoneName.Head, period: 7.3, phase: 0.0, axes: { x: 1.4 * DEG, y: 2.2 * DEG, z: 0.7 * DEG } },
  { bone: VRMHumanBoneName.Neck, period: 5.7, phase: 1.7, axes: { x: 0, y: 1 * DEG, z: 0 } },
  { bone: VRMHumanBoneName.Chest, period: 11.3, phase: 3.1, axes: { x: 0.45 * DEG, y: 0, z: 0.45 * DEG } },
  { bone: VRMHumanBoneName.Spine, period: 13.7, phase: 0.9, axes: { x: 0, y: 0.8 * DEG, z: 0 } },
  { bone: VRMHumanBoneName.Hips, period: 9.1, phase: 4.4, axes: { x: 0, y: 1 * DEG, z: 0.5 * DEG } },
]

/**
 * Idle motion manuale.
 *
 * Qui si muovono le ossa **del corpo**, non quelle dei capelli: i tre modelli
 * inclusi dichiarano 17-19 `secondaryAnimation.boneGroups` e i loro spring bone
 * seguono da soli testa, collo e petto (i collider ci sono tutti). Questo rig
 * esiste per il motivo opposto — senza di lui il busto sarebbe una colonna ferma
 * e il movimento si leggerebbe solo come effetto fisico, non come una persona in
 * piedi.
 *
 * Le rotazioni sono additive rispetto alla posa di riposo (`base ⊗ offset`), quindi
 * non sovrascrivono mai la posa originale del modello.
 */
export class IdleMotion {
  private readonly channels: BoneChannel[] = []
  private readonly sway = new SmoothNoise()
  private readonly lean = new SmoothNoise()
  private readonly scratch = new Quaternion()
  private readonly euler = new Euler()

  private readonly vrm: VRM
  private readonly chestBaseScale: number = 1
  private readonly amplitude: number
  private clock = 0
  private disposed = false

  constructor(vrm: VRM) {
    this.vrm = vrm
    this.amplitude = prefersReducedMotion() ? 0.15 : 1

    for (const spec of SPECS) {
      const node = vrm.humanoid.getRawBoneNode(spec.bone)
      if (!node) continue
      this.channels.push({
        base: node.quaternion.clone(),
        node,
        period: spec.period,
        phase: spec.phase,
        axes: spec.axes,
      })
    }

    const chest = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Chest)
    if (chest) this.chestBaseScale = chest.scale.y
  }

  /** Numero di ossa effettivamente animate: 0 se il rig non le espone. */
  get animatedBoneCount(): number {
    return this.channels.length
  }

  /**
   * Quaternione corrente di un'osso animata, per verifiche e debug.
   * Restituisce la posa di riposo se l'osso non è nel canale.
   */
  getBoneQuaternion(spec: BoneSpec['bone']): Quaternion {
    const channel = this.channels.find((entry) => entry.node === this.vrm.humanoid.getRawBoneNode(spec))
    return channel ? channel.node.quaternion : new Quaternion()
  }

  /** Nomi delle ossa effettivamente animate. */
  get animatedBones(): string[] {
    return this.channels.map((channel) => channel.node.name || '(senza nome)')
  }

  /** Scala Y corrente di un'osso: serve a verificare il respiro del petto. */
  boneScale(bone: BoneSpec['bone']): number | null {
    return this.vrm.humanoid.getRawBoneNode(bone)?.scale.y ?? null
  }

  update(deltaSeconds: number): void {
    if (this.disposed || this.channels.length === 0) return

    this.clock += deltaSeconds
    const sway = this.sway.update(deltaSeconds, this.clock, 1.1, 2.6)
    const lean = this.lean.update(deltaSeconds, this.clock, 1.8, 4.2)

    for (const channel of this.channels) {
      const phase = (this.clock / channel.period) * TAU + channel.phase
      const { axes } = channel

      this.euler.set(
        axes.x * Math.sin(phase) * this.amplitude,
        axes.y * (Math.sin(phase * 0.87) * 0.6 + sway * 0.4) * this.amplitude,
        axes.z * (Math.sin(phase * 1.13) * 0.5 + lean * 0.5) * this.amplitude,
        'XYZ',
      )

      this.scratch.setFromEuler(this.euler)
      channel.node.quaternion.copy(channel.base).multiply(this.scratch)
    }

    this.applyBreathing()
  }

  /** Riporta le ossa alla posa di riposo. Va chiamato prima di smontare la scena. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const channel of this.channels) channel.node.quaternion.copy(channel.base)
    this.channels.length = 0

    const chest = this.vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Chest)
    if (chest) chest.scale.set(1, this.chestBaseScale, 1)
  }

  private applyBreathing(): void {
    const chest = this.vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Chest)
    if (!chest) return
    const breath = this.chestBaseScale * (1 + 0.012 * Math.sin((this.clock / 3.6) * TAU) * this.amplitude)
    chest.scale.set(1, breath, 1)
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}