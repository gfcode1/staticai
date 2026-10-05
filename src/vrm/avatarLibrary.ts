/**
 * Catalogo degli avatar e persistenza dei modelli caricati.
 *
 * Due fonti, per motivi diversi. I modelli **inclusi** sono serviti dal progetto
 * e non richiedono nulla. I modelli **caricati dal disco** restano sul
 * computer dell'utente: non passano da nessun server e non hanno problemi di
 * licenza, perché il file è suo.
 *
 * La scelta di non usare URL remoti è deliberata: la maggior parte degli host che
 * espone file .vrm non invia gli header CORS, e `fetch` su un dominio diverso
 * fallisce con un errore che non dice nulla di utile. Meglio un file scelto
 * dall'utente, che funziona anche senza rete.
 */

import { STORAGE_KEYS } from '../config'
import { readJson } from '../store/persistence'

export interface BundledAvatar {
  id: string
  label: string
  /** Note sulla licenza: sono i vincoli reali, non una formalità. */
  note: string
  url: string
}

export interface UploadedAvatar {
  id: string
  name: string
  /** Byte, per mostrare la dimensione senza rileggerlo. */
  size: number
  at: number
}

/**
 * Modelli inclusi.
 *
 * Le licenze sono diverse e vanno dette, perché sono vincoli reali e non una
 * formalità: cambiano da un file all'altro e nessuno dei tre è CC0.
 *
 * - **Kaori** (Fouwaru): uso personale anche commerciale consentito, uso aziendale
 *   no, ridistribuzione consentita, **modifica vietata**, credito non necessario.
 * - **Olivia** ed **Emma** (Lucky): uso personale non commerciale, uso aziendale
 *   consentito, ridistribuzione consentita, modifica consentita, **credito
 *   obbligatorio**.
 *
 * I crediti sono dichiarati qui perché l'interfaccia li mostra accanto al nome:
 * chi ridistribuisce il progetto deve sapere a chi accreditare. La regola resta
 * che un nuovo modello entra solo con la sua licenza scritta in questa nota.
 */
export const BUNDLED: BundledAvatar[] = [
  {
    id: 'kaori',
    label: 'Kaori',
    note: 'VRM 0.0 · 14 espressioni · di Fouwaru · licenza: uso personale anche commerciale, non aziendale, ridistribuzione sì ma **modifica vietata**',
    // BASE_URL vale '/' in dev e '/staticai/' su GitHub Pages: l'URL assoluto
    // '/models/...' funzionerebbe solo dalla radice e darebbe 404 sulle Pages.
    url: `${import.meta.env.BASE_URL}models/Kaori.vrm`,
  },
  {
    id: 'olivia',
    label: 'Olivia',
    note: 'VRM 0.0 · 14 espressioni · di lucky · licenza: **credito obbligatorio**, uso personale non commerciale, modifica e ridistribuzione consentite',
    url: `${import.meta.env.BASE_URL}models/Olivia.vrm`,
  },
  {
    id: 'emma',
    label: 'Emma',
    note: 'VRM 0.0 · 14 espressioni · di Lucky · licenza: **credito obbligatorio**, uso personale non commerciale, modifica e ridistribuzione consentite',
    url: `${import.meta.env.BASE_URL}models/Emma.vrm`,
  },
]

export const DEFAULT_AVATAR_ID = BUNDLED[0]?.id ?? 'sconosciuto'

export function bundledById(id: string): BundledAvatar | undefined {
  return BUNDLED.find((a) => a.id === id)
}

/** Modelli caricati, in ordine di caricamento. */
export function parseUploaded(raw: unknown): UploadedAvatar[] {
  if (!Array.isArray(raw)) return []
  const out: UploadedAvatar[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const u = item as Partial<UploadedAvatar>
    if (typeof u.id !== 'string' || typeof u.name !== 'string') continue
    out.push({ id: u.id, name: u.name, size: typeof u.size === 'number' ? u.size : 0, at: typeof u.at === 'number' ? u.at : 0 })
  }
  return out
}

export function loadUploaded(): UploadedAvatar[] {
  return readJson(STORAGE_KEYS.uploadedAvatars, parseUploaded, [])
}

/** L'id dell'avatar scelto, se è ancora valido. */
export function parseAvatarChoice(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

export function loadAvatarChoice(): string {
  return readJson(STORAGE_KEYS.avatarChoice, parseAvatarChoice, DEFAULT_AVATAR_ID)
}

/* -------------------------------------------------------------- IndexedDB */

/**
 * I modelli caricati stanno in IndexedDB e non in `localStorage`.
 *
 * Non è una scelta stilistica: il modello predefinito pesa 18 MB e il limite di
 * `localStorage` è circa 5 MB. Un `JSON.stringify` di un `Blob` produce
 * `{}`. Quindi `localStorage` tiene solo l'**elenco** dei modelli (nomi e
 * dimensioni, qualche byte), i file veri stanno qui.
 */
const DB_NAME = 'vrmchat-avatars'
const STORE = 'files'
const DB_VERSION = 1

function apriDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const richiesta = indexedDB.open(DB_NAME, DB_VERSION)
    richiesta.onupgradeneeded = () => {
      const db = richiesta.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    richiesta.onsuccess = () => resolve(richiesta.result)
    richiesta.onerror = () => reject(richiesta.error ?? new Error('IndexedDB non raggiungibile'))
  })
}

function transazione<T>(modo: IDBTransactionMode, lavoro: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return apriDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, modo)
        const richiesta = lavoro(tx.objectStore(STORE))
        richiesta.onsuccess = () => resolve(richiesta.result)
        richiesta.onerror = () => reject(richiesta.error ?? new Error('Operazione su IndexedDB fallita'))
        tx.oncomplete = () => db.close()
      }),
  )
}

/** Sopra questo size il caricamento in memoria diventa un problema, non una comodità. */
export const MAX_AVATAR_BYTES = 120 * 1024 * 1024

/**
 * Verifica che il file sia davvero un VRM prima di archiviarlo.
 *
 * Un VRM è glTF binario: comincia con i byte `glTF`. Controllarlo costa nulla e
 * evita di salvare un JPG da 3 MB per poi accorgersi, al primo caricamento, che
 * non è un modello.
 */
export async function verificaFile(file: File): Promise<void> {
  const testata = new Uint8Array(4)
  const handle = await file.slice(0, 4).arrayBuffer()
  new Uint8Array(handle).forEach((b, i) => {
    testata[i] = b
  })
  const magia = String.fromCharCode(...testata)
  if (magia !== 'glTF') {
    throw new Error('Il file non è un VRM. Un modello VRM inizia con i byte "glTF".')
  }
}

export async function salvaModello(id: string, file: File): Promise<void> {
  await transazione('readwrite', (store) => store.put({ id, blob: file }))
}

export async function leggiModello(id: string): Promise<Blob | null> {
  const record = await transazione<{ id: string; blob: Blob } | undefined>('readonly', (store) =>
    store.get(id),
  )
  return record?.blob ?? null
}

export async function eliminaModello(id: string): Promise<void> {
  await transazione('readwrite', (store) => store.delete(id))
}

export async function spazioUtilizzato(): Promise<number> {
  if (!navigator.storage?.estimate) return 0
  const stima = await navigator.storage.estimate()
  return stima.usage ?? 0
}

/* ------------------------------------------------------ object URL in vita */

/**
 * Gli object URL creati per i modelli caricati vanno revocati.
 *
 * Ogni `URL.createObjectURL` tiene vivo il blob finché non si chiama
 * `revokeObjectURL`: senza, cambiare dieci avatar tiene in memoria dieci modelli
 * da 18 MB, e il browser non li scarica mai finché la scheda resta aperta.
 */
const urlVive = new Map<string, string>()

export async function urlPerModello(id: string): Promise<string> {
  const esistente = urlVive.get(id)
  if (esistente) return esistente

  const blob = await leggiModello(id)
  if (!blob) throw new Error('Il modello non è più in archivio. Caricalo di nuovo.')

  const url = URL.createObjectURL(blob)
  urlVive.set(id, url)
  return url
}

/** Revoca l'object URL di un modello non più usato. */
export function revocaUrl(id: string): void {
  const url = urlVive.get(id)
  if (!url) return
  URL.revokeObjectURL(url)
  urlVive.delete(id)
}

export function revocaTutti(): void {
  for (const url of urlVive.values()) URL.revokeObjectURL(url)
  urlVive.clear()
}