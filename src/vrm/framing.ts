import { Box3, Quaternion, Vector3, type Object3D, type SkinnedMesh } from 'three'
import {
  VRMExpressionMorphTargetBind,
  VRMHumanBoneName,
  type VRM,
  type VRMHumanBoneName as BoneName,
} from '@pixiv/three-vrm'

/**
 * Inquadrature predefinite, calcolate dal modello invece che da numeri fissi.
 *
 * I VRM non hanno dimensioni standard: un avatar in T-pose raggiunge più del
 * doppio della propria altezza in larghezza, mentre uno con le braccia lungo i
 * fianchi resta sotto mezzo metro. Una distanza cablata va bene per uno e
 * finisce dentro la faccia dell'altro.
 */
export type Framing = 'face' | 'bust' | 'full'

export interface FramingResult {
  /** Altezza del punto inquadrato, in metri da terra. */
  targetHeight: number
  /** Distanza camera → punto inquadrato, in metri. */
  distance: number
}

export interface ModelMetrics {
  height: number
  span: number
  /** Linea degli occhi stimata: poco sotto il vertice della testa. */
  eyeHeight: number
}

/**
 * Posizione e dimensione del volto, ricavate dalla geometria.
 *
 * Non indoviniamo l'altezza degli occhi con una proporzione generica: la troviamo
 * dai dati stessi del modello. I visemi e il blink muovono un gruppetto di
 * vertici molto piccolo e localizzato — esattamente bocca e occhi — quindi
 * misurandone lo spostamento otteniamo la posizione esatta del viso, che funziona
 * sia su un avatar umano sia su un personaggio stilizzato.
 */
export interface FaceAnchor {
  /** Centro del volto in coordinate mondo. */
  center: Vector3
  /** Larghezza del volto, in metri. */
  width: number
  /** Altezza dell'insieme viso+bocca, in metri. */
  height: number
  /** Spostamento massimo di un viseme: serve a capire quanto si apre la bocca. */
  mouthTravel: number
}

/**
 * Negli umani gli occhi stanno circa il 5-6% dell'altezza totale sotto il vertice
 * della testa; la stessa proporzione regge sui modelli stilizzati.
 */
const EYE_FROM_TOP_RATIO = 0.055

export function measureModel(vrm: VRM): ModelMetrics {
  const box = new Box3()
  for (const child of vrm.scene.children) {
    const childBox = new Box3().setFromObject(child)
    if (!childBox.isEmpty()) box.union(childBox)
  }
  if (box.isEmpty()) box.set(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 1.7, 0.2))

  const height = Math.max(box.max.y - box.min.y, 0.1)
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 0.1)
  const eyeHeight = Math.max(box.max.y - height * EYE_FROM_TOP_RATIO, box.min.y + height * 0.2)

  return { height, span, eyeHeight }
}

/** Sopra questa soglia un displacement è rumore numerico, non un viseme. */
const MORPH_EPSILON = 1e-5

/**
 * Trova il volto ispezionando i morph target legati alle espressioni facciali.
 *
 * Ogni preset visemo di three-vrm pilota un insieme di `morphTargetInfluences`;
 * leggendo gli indici che ciascuno influenza e le posizioni dei vertici che
 * sposta, otteniamo il punto medio di bocca+occhi. `getVertexPosition` applica la
 * skinning, quindi le coordinate sono già nel sistema del mondo.
 *
 * Non indoviniamo l'altezza degli occhi con una proporzione generica: su un avatar
 * umano sbaglierebbe di qualche centimetro, su un cartone di venti.
 */
export function locateFace(vrm: VRM): FaceAnchor | null {
  const expressionTargets = new Set<number>()
  for (const expression of Object.values(vrm.expressionManager?.expressionMap ?? {})) {
    for (const bind of expression.binds) {
      if (bind instanceof VRMExpressionMorphTargetBind) expressionTargets.add(bind.index)
    }
  }
  if (expressionTargets.size === 0) return null

  // Il viso di un avatar non è necessariamente un unico mesh: i VRoid lo esportano
  // diviso in una primitiva per materiale (pelle, bocca, iridi, ciglia...). Ogni
  // primitiva è uno SkinnedMesh a sé, quindi accumuliamo su tutti quelli che portano
  // i morph target delle espressioni. Fermarci al primo darebbe solo il bbox della
  // bocca, o peggio quello di un lembo di ciglia.
  const box = new Box3()
  let collected = 0
  let mouthTravel = 0

  for (const mesh of findSkinnedMeshes(vrm)) {
    const morphs = mesh.geometry.morphAttributes.position
    if (!morphs) continue
    if (![...expressionTargets].some((index) => morphs[index] !== undefined)) continue

    mesh.updateMatrixWorld(true)
    const scratch = new Vector3()

    for (const targetIndex of expressionTargets) {
      const attribute = morphs[targetIndex]
      if (!attribute) continue
      for (let i = 0; i < attribute.count; i += 1) {
        const travel = Math.hypot(attribute.getX(i), attribute.getY(i), attribute.getZ(i))
        if (travel <= MORPH_EPSILON) continue
        mesh.getVertexPosition(i, scratch)
        box.expandByPoint(scratch.applyMatrix4(mesh.matrixWorld))
        collected += 1
        mouthTravel = Math.max(mouthTravel, travel)
      }
    }
  }

  if (collected === 0 || box.isEmpty()) return null
  const center = box.getCenter(new Vector3())

  return {
    // Il punto più avanzato lungo Z: se il viso ha rilievo (naso, labbra) il suo
    // centro geometrico finirebbe dentro la testa e l'inquadratura risulterebbe
    // leggermente sfocata o tagliata.
    center: new Vector3(center.x, center.y, box.max.z),
    width: Math.max(box.max.x - box.min.x, 1e-3),
    height: Math.max(box.max.y - box.min.y, 1e-3),
    mouthTravel,
  }
}

function findSkinnedMeshes(vrm: VRM): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = []
  vrm.scene.traverse((object) => {
    const candidate = object as Partial<SkinnedMesh>
    if (candidate.isSkinnedMesh === true) meshes.push(candidate as SkinnedMesh)
  })
  return meshes
}

/**
 * Come riempire l'inquadratura, per preset.
 *
 * `subject` sono i multipli delle dimensioni reali del volto; `fill` è la quota di
 * fotogramma che il soggetto deve occupare. Distinguiamo le due cose perché un volto
 * può essere quadrato (un avatar umano) o tre volte più largo che alto (un
 * cartone): la quota da riempire è la stessa, ma i multipli no.
 */
const FRAMING_SPEC = {
  face: { heightFactor: 1.15, widthFactor: 1.5, fillHeight: 0.55, fillWidth: 0.7 },
  bust: { heightFactor: 2.7, widthFactor: 3.6, fillHeight: 0.72, fillWidth: 0.82 },
} as const

export function computeFraming(vrm: VRM, cameraFovDegrees: number, aspect: number): Record<Framing, FramingResult> {
  const metrics = measureModel(vrm)
  const face = locateFace(vrm)
  const halfFov = (cameraFovDegrees * Math.PI) / 360
  const tanV = Math.tan(halfFov)
  const tanH = tanV * Math.max(aspect, 0.0001)

  /**
   * Distanza necessaria perché un soggetto di `subjectWidth` x `subjectHeight`
   * occupi la quota richiesta del fotogramma, con il vincolo che sposta più
   * lontano: sull'altezza o sulla larghezza.
   */
  const frameBox = (subjectWidth: number, subjectHeight: number, fillHeight: number, fillWidth: number): number => {
    const byHeight = subjectHeight / (2 * fillHeight * tanV)
    const byWidth = subjectWidth / (2 * fillWidth * tanH)
    return Math.max(byHeight, byWidth) * FRAMING_MARGIN
  }

  const frame = (targetHeight: number, distance: number): FramingResult => ({
    targetHeight: round(targetHeight),
    distance: round(distance),
  })

  // Con il viso localizzato usiamo le sue dimensioni reali; in sua assenza ripieghiamo
  // su una stima proporzionale rispetto all'altezza del modello.
  const faceWidth = face?.width ?? metrics.height * 0.11
  const faceHeight = face?.height ?? faceWidth * 0.8
  const faceCenter = face?.center.y ?? metrics.eyeHeight

  const faceSpec = FRAMING_SPEC.face
  const bustSpec = FRAMING_SPEC.bust

  return {
    face: frame(
      faceCenter,
      frameBox(faceWidth * faceSpec.widthFactor, faceHeight * faceSpec.heightFactor, faceSpec.fillHeight, faceSpec.fillWidth),
    ),
    // Il punto inquadrato sta un po' sotto il viso: inquadrare il centro del volto
    // taglia il mento, un po' più in basso include collo e spalle.
    bust: frame(
      faceCenter - faceWidth * 0.38,
      frameBox(faceWidth * bustSpec.widthFactor, faceHeight * bustSpec.heightFactor, bustSpec.fillHeight, bustSpec.fillWidth),
    ),
    full: frame(
      metrics.height / 2,
      frameBox(Math.max(metrics.height, metrics.span) * 0.95, metrics.height * 0.95, 0.88, 0.86),
    ),
  }
}

/** Margine di respiro attorno al soggetto: inquadrature troppo strette claustrofobiche. */
const FRAMING_MARGIN = 1.12

function round(value: number): number {
  return Math.round(value * 100) / 100
}

const ARM_TARGET = {
  left: new Vector3(0.34, -1, 0.04).normalize(),
  right: new Vector3(-0.34, -1, 0.04).normalize(),
}

/**
 * Oltre questa inclinazione verticale l'omero è considerato orizzontale, cioè il
 * modello è in T-pose e va corretto.
 */
const T_POSE_MAX_VERTICALITY = 0.35

export interface RelaxPoseResult {
  /** true se il modello era in T-pose ed è stato corretto. */
  corrected: boolean
  /** Quante ossa del braccio sono state ruotate. */
  correctedBones: number
  /**
   * Inclinazione verticale degli omeri misurata prima della correzione.
   * 0 = braccia perfettamente orizzontali (T-pose), 1 = braccia dritte verso il basso.
   */
  armVerticality: number
}

/**
 * Porta le braccia dalla T-pose a una posa rilassata, **solo se serve**.
 *
 * La correzione va sugli ossa **normalizzate**, non su quelle grezze: `vrm.update()`
 * chiama `humanoid.update()`, che a ogni frame copia la posa normalizzata su quella
 * grezza. Scrivere sulle greffe verrebbe cancellato al primo frame.
 *
 * I file VRM arrivano in pose diverse a seconda dell'esportatore: Blender e
 * VRoid Studio 2.x esportano in T-pose, altri strumenti già in A-pose. Applicare
 * la correzione a un modello già rilassato sposterebbe le braccia sotto il corpo,
 * quindi leggiamo la posizione reale dell'omero e correggiamo solo le braccia che
 * partono davvero da orizzontali.
 */
export function relaxPose(vrm: VRM): RelaxPoseResult {
  // Misuriamo sugli ossa grezzi: è la posa effettivamente renderizzata.
  const leftDirection = segmentDirection(vrm, VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.LeftLowerArm)
  const rightDirection = segmentDirection(vrm, VRMHumanBoneName.RightUpperArm, VRMHumanBoneName.RightLowerArm)

  const verticalities = [leftDirection, rightDirection]
    .filter((direction): direction is Vector3 => direction !== null)
    .map((direction) => Math.abs(direction.y))
  const armVerticality = verticalities.length > 0 ? Math.max(...verticalities) : 1

  let correctedBones = 0
  if (isHorizontal(leftDirection)) {
    correctedBones += aimBone(vrm, VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.LeftLowerArm, ARM_TARGET.left)
  }
  if (isHorizontal(rightDirection)) {
    correctedBones += aimBone(vrm, VRMHumanBoneName.RightUpperArm, VRMHumanBoneName.RightLowerArm, ARM_TARGET.right)
  }

  if (correctedBones > 0) {
    bendJoint(vrm, VRMHumanBoneName.LeftLowerArm, 0.22)
    bendJoint(vrm, VRMHumanBoneName.RightLowerArm, -0.22)
  }

  if (correctedBones > 0) {
    // Portiamo subito la posa normalizzata su quella grezza, così chi costruisce
    // `IdleMotion` trova le braccia già rilassate e le usa come base.
    vrm.humanoid.update()
  }

  return { corrected: correctedBones > 0, correctedBones, armVerticality }
}

function isHorizontal(direction: Vector3 | null): boolean {
  return direction !== null && Math.abs(direction.y) <= T_POSE_MAX_VERTICALITY
}

/** Direzione (bone → figlio) normalizzata, in spazio mondo. */
function segmentDirection(vrm: VRM, boneName: BoneName, childName: BoneName): Vector3 | null {
  const bone = vrm.humanoid.getRawBoneNode(boneName)
  const child = vrm.humanoid.getRawBoneNode(childName)
  if (!bone || !child) return null
  bone.updateWorldMatrix(true, false)
  child.updateWorldMatrix(true, false)
  const from = new Vector3()
  bone.getWorldPosition(from)
  const to = new Vector3()
  child.getWorldPosition(to)
  from.subVectors(to, from)
  return from.lengthSq() < 1e-10 ? null : from.normalize()
}

/**
 * Nodo su cui scrivere una correzione di posa: quello normalizzato se esiste,
 * altrimenti quello grezzo.
 *
 * Il normalized rig è la sorgente: `humanoid.update()` lo copia sui raw a ogni
 * frame, quindi una correzione scritta sui raw verrebbe subito sovrascritta.
 */
function poseTarget(vrm: VRM, name: BoneName): Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name) ?? vrm.humanoid.getRawBoneNode(name)
}

/** Ruota `bone` finché il segmento bone→child non punta in `targetDirection`. */
function aimBone(vrm: VRM, boneName: BoneName, childName: BoneName, targetDirection: Vector3): number {
  const bone = poseTarget(vrm, boneName)
  const child = poseTarget(vrm, childName)
  const parent = bone?.parent
  if (!bone || !parent || !child) return 0

  bone.updateWorldMatrix(true, false)
  child.updateWorldMatrix(true, false)

  const from = new Vector3()
  bone.getWorldPosition(from)
  const to = new Vector3()
  child.getWorldPosition(to)
  from.subVectors(to, from)
  if (from.lengthSq() < 1e-10) return 0
  from.normalize()

  const worldRotation = new Quaternion().setFromUnitVectors(from, targetDirection)
  applyWorldRotation(bone, worldRotation)
  return 1
}

/** Piega il gomito attorno all'asse Z locale del bone. */
function bendJoint(vrm: VRM, boneName: BoneName, radians: number): void {
  const bone = poseTarget(vrm, boneName)
  if (!bone?.parent) return

  const axis = new Vector3(0, 0, 1).applyQuaternion(bone.quaternion)
  applyWorldRotation(bone, new Quaternion().setFromAxisAngle(axis, radians))
}

/**
 * Applica una rotazione R in spazio mondo a un bone, composing con la sua
 * rotazione locale esistente.
 *
 *   mondo = P · L   →   mondo' = R · P · L   →   L' = P⁻¹ · R · P · L
 */
function applyWorldRotation(bone: Object3D, worldRotation: Quaternion): void {
  const parentQuat = new Quaternion()
  bone.parent?.getWorldQuaternion(parentQuat)
  const conjugated = parentQuat.clone().invert().multiply(worldRotation).multiply(parentQuat)
  bone.quaternion.premultiply(conjugated)
}