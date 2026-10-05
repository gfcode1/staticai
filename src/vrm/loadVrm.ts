import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

export interface LoadedAvatar {
  vrm: VRM
  /** '0' per i VRM 0.x, '1' per i VRM 1.0. Determina se serve la rotazione di 180°. */
  specVersion: '0' | '1'
  /** Nomi delle espressioni che three-vrm è riuscito a costruire (aa, ee, ih, oh, ou, blink...). */
  expressions: string[]
  /** true se il materiale dichiara KHR_materials_unlit: le luci non hanno effetto. */
  unlit: boolean
  /** true se il file ha animazioni VRMA utilizzabili. */
  hasSecondaryAnimation: boolean
}

/** Rileva la versione dello spec VRM dal JSON glTF grezzo. */
function readSpecVersion(gltf: GLTF): '0' | '1' {
  const extensions = gltf.parser.json.extensions as
    | { VRM?: { specVersion?: string }; VRMC_vrm?: { specVersion?: string } }
    | undefined
  const version = extensions?.VRM?.specVersion ?? extensions?.VRMC_vrm?.specVersion ?? '1.0'
  return version.startsWith('0') ? '0' : '1'
}

function detectUnlit(gltf: GLTF): boolean {
  const materials = gltf.parser.json.materials ?? []
  return materials.some(
    (material: { extensions?: Record<string, unknown> }) =>
      typeof material.extensions?.['KHR_materials_unlit'] === 'object',
  )
}

/** Conta i boneGroup della secondaryAnimation: 0 significa che non ci sono spring bone. */
function countBoneGroups(gltf: GLTF): number {
  const extensions = gltf.parser.json.extensions as
    | { VRM?: { secondaryAnimation?: { boneGroups?: unknown[] } }; VRMC_vrm?: { springBone?: { colliderGroups?: unknown[]; jointGroups?: unknown[] } } }
    | undefined
  const legacy = extensions?.VRM?.secondaryAnimation?.boneGroups?.length
  if (typeof legacy === 'number') return legacy
  const modern =
    (extensions?.VRMC_vrm?.springBone?.jointGroups?.length ?? 0) +
    (extensions?.VRMC_vrm?.springBone?.colliderGroups?.length ?? 0)
  return modern
}

/**
 * Carica un file VRM e applica le ottimizzazioni di three-vrm v3.
 *
 * `signal` permette di annullare un caricamento in corso: se il modello arriva
 * dopo l'unmount del componente, viene comunque disposato per non fuggire memoria.
 */
export async function loadAvatar(
  url: string,
  options: { signal?: AbortSignal | undefined; onProgress?: ((ratio: number) => void) | undefined } = {},
): Promise<LoadedAvatar> {
  const { signal, onProgress } = options

  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))

  const gltf = await new Promise<GLTF>((resolve, reject) => {
    loader.load(
      url,
      resolve,
      (event) => {
        if (!onProgress) return
        // `total` è 0 quando il server non invia Content-Length (i VRM spesso lo omettono).
        const ratio = event.total > 0 ? event.loaded / event.total : 0
        onProgress(ratio)
      },
      reject,
    )
  }).catch((error: unknown) => {
    if (signal?.aborted) throw new DOMException('Caricamento annullato', 'AbortError')
    throw error
  })

  const vrm = gltf.userData.vrm as VRM | undefined
  if (!vrm) {
    disposeObject3D(gltf.scene)
    throw new Error('Il file caricato non contiene dati VRM validi.')
  }

  if (signal?.aborted) {
    disposeObject3D(vrm.scene)
    throw new DOMException('Caricamento annullato', 'AbortError')
  }

  // Va letto **adesso**, prima che il JSON venga ritoccato: il plugin MToon di
  // three-vrm cancella `KHR_materials_unlit` da ogni materiale che dichiara
  // anche MToon, altrimenti il loader glTF applicherebbe due percorsi
  // incompatibili sullo stesso materiale. Leggendolo dopo, tutti i nostri
  // avatar si dichiaravano "unlit" in diagnostica e si concludeva — a torto —
  // che le luci della scena non facessero nulla.
  const unlit = detectUnlit(gltf)
  const specVersion = readSpecVersion(gltf)

  // Ottimizzazioni di three-vrm v3: riducono drasticamente il numero di draw call
  // e i morph target, che è il collo di bottiglia sui dispositivi mobili.
  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  VRMUtils.combineMorphs(vrm)

  // I VRM 0.x sono esportati con la camera rivolta verso -Z: senza questa rotazione
  // l'avatar si vede di schiena.
  if (specVersion === '0') VRMUtils.rotateVRM0(vrm)

  // MToon e spring bone usano shader che spostano i vertici: il frustum culling
  // della mesh sbaglierebbe e l'avatar comparirebbe/scomparirebbe a random.
  vrm.scene.traverse((object) => {
    object.frustumCulled = false
  })

  const manager = vrm.expressionManager
  if (!manager) throw new Error('Il VRM non espone un expressionManager.')

  const expressions = Object.keys(manager.expressionMap).sort()

  return {
    vrm,
    specVersion,
    expressions,
    unlit,
    hasSecondaryAnimation: countBoneGroups(gltf) > 0,
  }
}

/**
 * Rilascia geometrie, materiali e texture di un intero sotto-albero.
 * Va chiamata in fase di teardown, altrimenti GPU e memoria restano occupate.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>()

  root.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>
    mesh.geometry?.dispose()

    const material = mesh.material
    if (!material) return
    const materials = Array.isArray(material) ? material : [material]
    for (const entry of materials) {
      for (const value of Object.values(entry)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
      entry.dispose()
    }
  })

  for (const texture of textures) texture.dispose()
  root.removeFromParent()
  root.clear()
}