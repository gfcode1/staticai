import { useSyncExternalStore } from 'react'

import {
  BLINK_WHILE_SPEAKING,
  CAMERA_DISTANCE,
  CAMERA_TARGET_HEIGHT,
  DEFAULT_FRAMING,
  STT_LANG,
  STORAGE_KEYS,
  VOICE_PITCH,
  VOICE_RATE,
  WAKE_WORD_ENABLED_DEFAULT,
} from '../config'
import type { WakeKeyword } from '../speech/wakeWordConfig'
import { clampWakeThreshold, normalizeWakeKeyword } from '../speech/wakeWordConfig'
import type { WakeStatus } from '../speech/wakeWord'
import type { Framing } from '../vrm/framing'
import { clamp, debounce, readJson, writeJson } from './persistence'
import { FALLBACK_MODELS, type ModelInfo } from '../ai/models'
import type { ChatMessage } from '../ai/openrouter'
import type { ChatStatus } from '../ai/conversation'
import { DEFAULT_CHAT_MODEL } from '../config'
import type { VoiceSettings } from '../speech/tts'
import { speech } from '../speech/speechController'
import {
  DEFAULT_AVATAR_ID,
  bundledById,
  loadUploaded,
  type UploadedAvatar,
} from '../vrm/avatarLibrary'
import {
  addMemory,
  deriveProfile,
  forgetMemories,
  loadMemories,
  saveMemories,
  EMPTY_MEMORY,
  type Memory,
  type Profile,
} from '../memory/memory'
import {
  addReminder,
  cancelReminders,
  describeDue,
  loadReminders,
  popDue,
  saveReminders,
  type Reminder,
} from '../memory/reminders'

/**
 * Lettura della chiave salvata.
 *
 * La chiave è una stringa e si legge/scrive grezza, senza JSON: avvolgerla in
 * `JSON.stringify` aggiungerebbe virgolette al valore e la rilettura
 * restituirebbe `"sk-or-…"` invece di `sk-or-…`. Le versioni precedenti
 * scrivevano con `writeJson`, quindi qui si accetta anche quel formato per
 * migrazione: se il valore sembra quotato si prova a decodificarlo.
 */
function readStoredKey(): string {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(STORAGE_KEYS.apiKey)
  } catch {
    // Modalità privata o storage negato: si chatta senza ricordare la chiave.
    return ''
  }
  if (raw === null || raw === '') return ''
  if (raw.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(raw)
      return typeof decoded === 'string' ? decoded : raw
    } catch {
      return raw
    }
  }
  return raw
}

/** Il modello salvato deve essere ancora uno di quelli gratuiti di adesso. */
function parseChatModel(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

export type AvatarPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface CameraSettings {
  /** Distanza camera → punto inquadrato, in metri. */
  distance: number
  /** Altezza del punto inquadrato, in metri da terra. */
  targetHeight: number
  /** Se true l'utente può ruotare e spostare la camera col mouse. */
  orbitEnabled: boolean
}

/** Impostazioni di sintesi vocale, persistite tra le sessioni. */
export interface VoicePrefs {
  /** `name` della voce; `null` = scegli la prima disponibile per la lingua. */
  voiceName: string | null
  lang: string
  rate: number
  pitch: number
  /**
   * Se true l'avatar continua a lampeggiare mentre pronuncia.
   *
   * Non è una scienza, è una scelta: le persone lampeggiano parlando, e il
   * silenzio degli occhi per tutta la risposta è ciò che rende un avatar
   * uncanny. Resta una preferenza perché a qualcuno dà fastidio.
   */
  blinkWhileSpeaking: boolean
}

/**
 * Dalle preferenze dell'interfaccia ai parametri del motore di sintesi.
 *
 * Le due forme non coincidono: le preferenze includono cose che il motore non
 * conosce (`suppressBlink`) e il motore ne pretende altre che l'utente non
 * regola (`volume`). La traduzione sta qui, nello store che possiede
 * `VoicePrefs`, così pannello e chat non devono ricostruirla a mano e rischiare
 * di dimenticare un campo.
 */
export function voiceSettings(prefs: VoicePrefs): VoiceSettings {
  return {
    voiceName: prefs.voiceName,
    lang: prefs.lang,
    rate: prefs.rate,
    pitch: prefs.pitch,
    volume: 1,
  }
}

export type ListeningStatus =
  | 'idle'
  | 'unsupported'
  | 'requesting'
  | 'listening'
  | 'transcribing'
  | 'denied'
  | 'error'

/**
 * Preferenze del risveglio vocale.
 *
 * La parola deve essere una di quelle bundled: un valore salvato da una
 * versione con più modelli non deve rompere il selettore.
 */
export interface WakeWordPrefs {
  enabled: boolean
  keyword: WakeKeyword
  threshold: number
}

export interface AppState {
  avatarPhase: AvatarPhase
  /** 0 → 1, aggiornato spesso durante il download del modello. */
  avatarProgress: number
  avatarError: string | null
  /** Preset di espressione effettivamente disponibili nel VRM caricato. */
  availableExpressions: string[]
  camera: CameraSettings
  /** Ultima inquadratura richiesta: i valori effettivi derivano dal modello. */
  framing: Framing
  /** true dopo che l'utente ha toccato i cursori: i default del modello non sovrascrivono più. */
  cameraCustomized: boolean
  /** Inquadrature calcolate sul modello caricato, pronte per essere applicate. */
  framingOptions: Record<Framing, { targetHeight: number; distance: number }> | null
  voice: VoicePrefs

  /** Stato della sessione di ascolto. */
  listeningStatus: ListeningStatus
  /** Trascrizione parziale mostrata mentre l'utente parla. */
  interimTranscript: string
  /** Ultima frase riconosciuta in modo definitivo. */
  lastUtterance: string
  /** Messaggio d'errore dell'ascolto, mostrato finché non si riprova. */
  listeningError: string | null
  /** Lingua del riconoscimento. */
  sttLang: string

  /* -------------------------------------------------------- wake word */

  /**
   * Preferenze del risveglio vocale locale.
   *
   * Spento di default: l'ascolto in background tiene il microfono aperto in
   * permanenza, e deve essere una scelta esplicita — non una sorpresa dopo
   * un aggiornamento.
   */
  wake: WakeWordPrefs
  /** Stato del motore locale: non passa per `ListeningSession`. */
  wakeStatus: WakeStatus
  /** Ultimo errore del motore, mostrato finché non si riprova. */
  wakeError: string | null
  /** Ultimo risveglio rilevato, per la diagnostica. */
  wakeLastDetect: { keyword: string; score: number; at: number } | null

  /* ------------------------------------------------------------- chat */

  /**
   * Chiave OpenRouter.
   *
   * Vive in `localStorage` su questo dispositivo e non esce mai da qui: viene
   * inviata solo a OpenRouter e non finisce in nessun file del progetto. Non è
   * un segreto forte come una credenziale di servizio, e l'interfaccia lo dice.
   */
  apiKey: string
  /** Modello in uso: uno degli identificativi gratuiti letti a runtime. */
  chatModel: string
  /** Modelli gratuiti disponibili al momento della lettura. */
  freeModels: ModelInfo[]
  modelsLoading: boolean
  modelsError: string | null
  /** Stato del turno in corso. */
  chatStatus: ChatStatus
  /** Messaggio d'errore dell'ultimo turno. */
  chatError: string | null
  /** Risposta che sta arrivando, mostrata mentre il modello scrive. */
  chatPartial: string
  /** Cosa sta facendo adesso, per riempire le pause: "sta controllando il meteo". */
  chatActivity: string | null
  /** Cronologia della conversazione, con il ruolo di chi parla. */
  chatMessages: ChatMessage[]

  /** Quali pannelli sono aperti. */
  panels: Record<PanelId, boolean>

  /* ------------------------------------------------------------- memoria */

  /** Ricordi espliciti dell'utente: lui li chiede, lui li cancella. */
  memories: Memory[]
  /** Promemoria in attesa di scadenza: li imposta l'utente, suonano una volta sola. */
  reminders: Reminder[]
  /**
   * Ultimi promemoria scaduti, da mostrare come avviso.
   *
   * Effimero: non si persiste, si ricostruisce alla prossima scadenza. Vive
   * nello store e non in un componente perché a farlo suonare è un timer
   * fuori da React, e il banner deve vederlo comunque.
   */
  dueNotice: string | null
  /** Dati derivati dall'uso. */
  profile: Profile

  /* ----------------------------------------------------------- avatar */

  /** Avatar scelto: id del catalogo, oppure del modello caricato. */
  avatarId: string
  /** Modelli caricati dal disco, per il selettore. */
  uploadedAvatars: UploadedAvatar[]
}

export type PanelId = 'chat' | 'memory' | 'options'

/**
 * Default dei pannelli: solo la chat aperta.
 *
 * Le opzioni servono a configurare, non a usare l'app. Aperte, rubano
 * metà schermo all'avatar: è esattamente il difetto da cui siamo partiti. La
 * chat invece serve subito, perché è il modo in cui si usa un assistente.
 */
const DEFAULT_PANELS: Record<PanelId, boolean> = {
  chat: true,
  memory: false,
  options: false,
}

function parsePanels(raw: unknown): Record<PanelId, boolean> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  let found = false
  for (const id of Object.keys(DEFAULT_PANELS) as PanelId[]) {
    if (typeof candidate[id] === 'boolean') found = true
  }
  // Migrazione dal layout precedente (`avatar` a sinistra, `camera` a destra):
  // se erano aperti, si apre il nuovo pannello Opzioni che li contiene entrambi.
  const legacyOpen = candidate['camera'] === true || candidate['avatar'] === true
  if (!found && !legacyOpen) return null
  const next: Record<PanelId, boolean> = { ...DEFAULT_PANELS }
  for (const id of Object.keys(DEFAULT_PANELS) as PanelId[]) {
    if (typeof candidate[id] === 'boolean') next[id] = candidate[id]
  }
  if (typeof candidate['options'] !== 'boolean' && legacyOpen) next.options = true
  return next
}

/**
 * Cronologia riletta da `localStorage`.
 *
 * Si tiene solo il testo e il ruolo: timestamp e chiamate agli strumenti si
 * perdono. Non è una semplificazione, è una scelta — una cronologia salvata che
 * contiene i nomi degli strumenti usati occuperebbe spazio per raccontare a chi
 * riapre la pagina cose che ha già perso il senso. E il tetto impedisce che una
 * conversazione lunga riempa lo storage.
 */
const MAX_SAVED_MESSAGES = 60

/** L'avatar scelto, letto una volta e riusato: vedi `cameraPerAvatar`. */
function stateAvatarId(): string {
  return readJson(STORAGE_KEYS.avatarChoice, parseAvatarChoiceSafe, DEFAULT_AVATAR_ID)
}

function parseAvatarChoiceSafe(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

/**
 * L'id salvato deve esistere ancora.
 *
 * Può non esistere per due motivi: un modello caricato dall'utente è stato
 * cancellato a mano, oppure l'id era un modello del catalogo che è stato tolto.
 * Senza questo controllo un id orfano finisce sulla strada dei modelli caricati
 * dal disco: `useAvatarUrl` chiede quel file a IndexedDB, non lo trova, e
 * l'utente si vede «Il modello non è più in archivio» invece di un avatar.
 */
function normalizeAvatar(id: string): string {
  if (bundledById(id) !== undefined) return id
  return loadUploaded().some((u) => u.id === id) ? id : DEFAULT_AVATAR_ID
}

/** L'id letto dal salvataggio, non ancora validato. */
const savedAvatarId = stateAvatarId()
const initialAvatarId = normalizeAvatar(savedAvatarId)

const FALLBACK_CAMERA: CameraSettings = {
  distance: 0.9,
  targetHeight: 1.35,
  orbitEnabled: false,
}

/**
 * Le preferenze salvate portano con sé l'avatar per cui sono valide.
 * Le distanze sono calcolate sulla geometria del modello: riapplicarle a un
 * avatar diverso finirebbe dentro la testa o taglierebbe i piedi.
 */
interface StoredCamera extends CameraSettings {
  /** L'avatar a cui queste distanze sono state calcolate. */
  avatarKey: string
}

function parseCamera(raw: unknown): StoredCamera | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Partial<Record<keyof StoredCamera, unknown>>
  const distance = typeof candidate.distance === 'number' ? candidate.distance : Number.NaN
  const targetHeight = typeof candidate.targetHeight === 'number' ? candidate.targetHeight : Number.NaN
  if (Number.isNaN(distance) && Number.isNaN(targetHeight)) return null
  return {
    distance: clamp(
      Number.isNaN(distance) ? FALLBACK_CAMERA.distance : distance,
      CAMERA_DISTANCE.min,
      CAMERA_DISTANCE.max,
    ),
    targetHeight: clamp(
      Number.isNaN(targetHeight) ? FALLBACK_CAMERA.targetHeight : targetHeight,
      CAMERA_TARGET_HEIGHT.min,
      CAMERA_TARGET_HEIGHT.max,
    ),
    orbitEnabled:
      typeof candidate.orbitEnabled === 'boolean' ? candidate.orbitEnabled : FALLBACK_CAMERA.orbitEnabled,
    avatarKey: typeof candidate.avatarKey === 'string' ? candidate.avatarKey : '',
  }
}

const storedCamera = readJson(STORAGE_KEYS.camera, parseCamera, null)

/**
 * La camera riprende i valori salvati solo se appartengono all'avatar scelto.
 *
 * Si decide qui e non dentro l'oggetto di `state` perché il confronto richiede
 * l'avatar corrente, e `state` non è ancora dichiarato quando viene costruito.
 */
function cameraPerAvatar(avatarId: string): { camera: CameraSettings; personalizzata: boolean } {
  const salvata = storedCamera
  if (salvata !== null && salvata.avatarKey === avatarId && salvata.avatarKey !== '') {
    return {
      camera: {
        distance: salvata.distance,
        targetHeight: salvata.targetHeight,
        orbitEnabled: salvata.orbitEnabled,
      },
      personalizzata: true,
    }
  }
  return { camera: FALLBACK_CAMERA, personalizzata: false }
}

export const DEFAULT_VOICE: VoicePrefs = {
  voiceName: null,
  lang: 'it-IT',
  rate: 1,
  pitch: 1,
  blinkWhileSpeaking: BLINK_WHILE_SPEAKING,
}

function parseVoice(raw: unknown): VoicePrefs | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Partial<Record<keyof VoicePrefs, unknown>>
  const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
  return {
    voiceName: typeof candidate.voiceName === 'string' ? candidate.voiceName : null,
    lang: typeof candidate.lang === 'string' && candidate.lang ? candidate.lang : DEFAULT_VOICE.lang,
    rate: number(candidate.rate, DEFAULT_VOICE.rate, VOICE_RATE.min, VOICE_RATE.max),
    pitch: number(candidate.pitch, DEFAULT_VOICE.pitch, VOICE_PITCH.min, VOICE_PITCH.max),
    // L'assenza di chiave non è un errore: le preferenze salvate prima che
    // l'opzione esistesse non hanno il campo, e per quelle vale il default.
    blinkWhileSpeaking:
      typeof candidate.blinkWhileSpeaking === 'boolean'
        ? candidate.blinkWhileSpeaking
        : DEFAULT_VOICE.blinkWhileSpeaking,
  }
}

const storedVoice = readJson(STORAGE_KEYS.voice, parseVoice, null)

export const DEFAULT_WAKE: WakeWordPrefs = {
  enabled: WAKE_WORD_ENABLED_DEFAULT,
  keyword: 'hey_jarvis',
  threshold: 0.5,
}

/**
 * Il parser sta fuori dal `try` di `readJson` di proposito: dati corrotti e
 * codice rotto devono restare distinguibili (vedi nota in `persistence.ts`).
 */
function parseWake(raw: unknown): WakeWordPrefs | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Partial<Record<keyof WakeWordPrefs, unknown>>
  return {
    enabled: candidate.enabled === true,
    keyword: normalizeWakeKeyword(candidate.keyword),
    threshold: clampWakeThreshold(candidate.threshold),
  }
}

const storedWake = readJson(STORAGE_KEYS.wakeWord, parseWake, null)

// La preferenza va depositata nel controller all'avvio, non solo nello stato:
// se il primo turno di parola arrivasse prima che l'utente tocchi la casella,
// il motore deve già sapere cosa vale.
if (storedVoice) speech.blinkWhileSpeaking = storedVoice.blinkWhileSpeaking

function isFraming(value: unknown): value is Framing {
  return value === 'face' || value === 'bust' || value === 'full'
}

let state: AppState = {
  avatarPhase: 'idle',
  avatarProgress: 0,
  avatarError: null,
  availableExpressions: [],
  camera: cameraPerAvatar(initialAvatarId).camera,
  framing: DEFAULT_FRAMING,
  // Le preferenze salvate hanno la precedenza sui default calcolati dal modello,
  // ma solo se erano state ricavate per questo stesso avatar.
  cameraCustomized: cameraPerAvatar(initialAvatarId).personalizzata,
  framingOptions: null,
  voice: storedVoice ?? DEFAULT_VOICE,

  listeningStatus: 'idle',
  interimTranscript: '',
  lastUtterance: '',
  listeningError: null,
  sttLang: STT_LANG,

  wake: storedWake ?? DEFAULT_WAKE,
  wakeStatus: 'off',
  wakeError: null,
  wakeLastDetect: null,

  apiKey: readStoredKey(),
  chatModel: readJson(STORAGE_KEYS.chatModel, parseChatModel, DEFAULT_CHAT_MODEL),
  freeModels: FALLBACK_MODELS,
  modelsLoading: false,
  modelsError: null,
  chatStatus: 'idle',
  chatError: null,
  chatPartial: '',
  chatActivity: null,
  // Ripresa da `localStorage`: senza, ricaricare la pagina farebbe perdere la
  // conversazione in corso, che è il modo più veloce per rendersi fastidiosi.
  chatMessages: readJson(STORAGE_KEYS.conversation, parseConversation, []),
  panels: readJson(STORAGE_KEYS.panels, parsePanels, DEFAULT_PANELS),

  memories: loadMemories(),
  reminders: loadReminders(),
  dueNotice: null,
  profile: readJson(STORAGE_KEYS.profile, parseProfile, deriveProfile({})),

  avatarId: initialAvatarId,
  uploadedAvatars: loadUploaded(),
}

function parseConversation(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const m = item as { role?: unknown; content?: unknown; at?: unknown }
    if (typeof m.content !== 'string' || m.content.trim() === '') continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    out.push({
      role: m.role,
      content: m.content,
      at: typeof m.at === 'number' ? m.at : undefined,
    })
  }
  return out.slice(-MAX_SAVED_MESSAGES)
}

function parseProfile(raw: unknown): Profile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Partial<Profile>
  const numeri = [c.conversations, c.messages, c.firstSeen]
  if (!numeri.every((n) => typeof n === 'number')) return null
  return deriveProfile(c)
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

const persistCamera = debounce(
  () => writeJson(STORAGE_KEYS.camera, { ...state.camera, avatarKey: state.avatarId } satisfies StoredCamera),
  300,
)

const persistVoice = debounce(() => writeJson(STORAGE_KEYS.voice, state.voice), 300)
const persistWake = debounce(() => writeJson(STORAGE_KEYS.wakeWord, state.wake), 300)

const persistKey = debounce(() => {
  // Scrittura grezza, in coppia con `readStoredKey`: niente JSON, niente
  // virgolette attorno alla chiave.
  try {
    window.localStorage.setItem(STORAGE_KEYS.apiKey, state.apiKey)
  } catch {
    /* quota esaurita o storage negato: la chiave non viene salvata, pazienza */
  }
}, 400)
const persistModel = debounce(() => writeJson(STORAGE_KEYS.chatModel, state.chatModel), 300)
const persistPanels = debounce(() => writeJson(STORAGE_KEYS.panels, state.panels), 250)
const persistMemories = debounce(() => saveMemories(state.memories), 200)
const persistReminders = debounce(() => saveReminders(state.reminders), 200)
const persistProfile = debounce(() => writeJson(STORAGE_KEYS.profile, state.profile), 400)
const persistAvatar = debounce(() => writeJson(STORAGE_KEYS.avatarChoice, state.avatarId), 200)
const persistUploaded = debounce(() => writeJson(STORAGE_KEYS.uploadedAvatars, state.uploadedAvatars), 400)

// La conversazione si salva con ritardo: durante uno scambio fitto si scrive a ogni
// messaggio, e localStorage è sincrono. Scrivere sul debole è il modo più rapido
// per bloccare l'interfaccia.
const persistConversation = debounce(() => {
  const salvabile = state.chatMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_SAVED_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content, at: m.at }))
  writeJson(STORAGE_KEYS.conversation, salvabile)
}, 700)

// Se l'id salvato non era più valido, la correzione va scritta subito: senza,
// ogni ricarica della pagina ripeterebbe la normalizzazione e l'utente vedrebbe
// di nuovo il messaggio sul modello mancante prima di poter sceglierne uno.
if (initialAvatarId !== savedAvatarId) persistAvatar()

export function getState(): AppState {
  return state
}

declare global {
  interface Window {
    /**
     * Stato e azioni dello store, solo in sviluppo.
     *
     * Serve a ispezionare e a pilotare l'applicazione dalla console, e a rendere
     * verificabile la geometria: la cronologia si può riempire con messaggi
     * fittizi e misurare se scorre davvero, cosa impossibile guardando l'app vuota.
     */
    __store?: {
      get: typeof getState
      set: typeof setState
      setChat: typeof setChat
      setAllPanels: typeof setAllPanels
      setPanel: typeof setPanel
      rememberMemory: typeof rememberMemory
      forgetMemory: typeof forgetMemory
      clearMemories: typeof clearMemories
      scheduleReminder: typeof scheduleReminder
      cancelReminder: typeof cancelReminder
      dismissDueNotice: typeof dismissDueNotice
    }
  }
}

if (import.meta.env.DEV) {
  window.__store = {
    get: getState,
    set: setState,
    setChat,
    setAllPanels,
    setPanel,
    rememberMemory,
    forgetMemory,
    clearMemories,
    scheduleReminder,
    cancelReminder,
    dismissDueNotice,
  }
}

export function setState(patch: Partial<AppState>): void {
  const previousCamera = state.camera
  const previousVoice = state.voice
  const previousWake = state.wake
  const previousKey = state.apiKey
  const previousModel = state.chatModel
  const previousPanels = state.panels
  const previousMemories = state.memories
  const previousReminders = state.reminders
  const previousChat = state.chatMessages
  const previousAvatar = state.avatarId
  const previousUploaded = state.uploadedAvatars
  const previousProfile = state.profile
  state = { ...state, ...patch }
  if (patch.camera !== undefined && patch.camera !== previousCamera) persistCamera()
  if (patch.voice !== undefined && patch.voice !== previousVoice) persistVoice()
  if (patch.wake !== undefined && patch.wake !== previousWake) persistWake()
  if (patch.apiKey !== undefined && patch.apiKey !== previousKey) persistKey()
  if (patch.chatModel !== undefined && patch.chatModel !== previousModel) persistModel()
  if (patch.panels !== undefined && patch.panels !== previousPanels) persistPanels()
  if (patch.memories !== undefined && patch.memories !== previousMemories) persistMemories()
  if (patch.reminders !== undefined && patch.reminders !== previousReminders) persistReminders()
  if (patch.chatMessages !== undefined && patch.chatMessages !== previousChat) persistConversation()
  if (patch.avatarId !== undefined && patch.avatarId !== previousAvatar) persistAvatar()
  if (patch.uploadedAvatars !== undefined && patch.uploadedAvatars !== previousUploaded) persistUploaded()
  if (patch.profile !== undefined && patch.profile !== previousProfile) persistProfile()
  emit()
}

export function setVoice(patch: Partial<VoicePrefs>): void {
  setState({ voice: { ...state.voice, ...patch } })
}

/**
 * Il blink automatico mentre l'avatar parla.
 *
 * Va oltre il semplice stato: il controller del linguaggio vive fuori da React e
 * ne serra una copia. Senza questa azione la preferenza arriverebbe al pannello
 * ma non al motore, e la casella accesa non cambierebbe nulla — il difetto più
 * subdolo di un'interfaccia che scrive in un posto solo.
 */
export function setBlinkWhileSpeaking(enabled: boolean): void {
  setVoice({ blinkWhileSpeaking: enabled })
  speech.blinkWhileSpeaking = enabled
}

/** Campi che non sono preferenze ma stato effimero dell'ascolto. */
export function setListening(patch: Partial<AppState>): void {
  setState(patch)
}

/** Aggiorna le preferenze del risveglio e le persiste (debounce 300 ms). */
export function setWake(patch: Partial<WakeWordPrefs>): void {
  setState({ wake: { ...state.wake, ...patch } })
}

/** Stato effimero del motore locale: non si persiste, si ricostruisce. */
export function setWakeStatus(
  patch: Pick<AppState, 'wakeStatus'> & Partial<Pick<AppState, 'wakeError' | 'wakeLastDetect'>>,
): void {
  setState(patch)
}

/* --------------------------------------------------------------- avatar */

/**
 * Cambia avatar.
 *
 * Le distanze della camera sono calcolate sulla geometria del modello: riportarle
 * su un avatar più basso o più largo finirebbe dentro la testa o taglierebbe i
 * piedi. Perciò a ogni cambio si rilegge la camera salvata **per quell'avatar**,
 * e se non c'è si riparte dal default che `AvatarStage` calcolerà sul modello
 * nuovo. Senza la rilettura, tornare a un avatar precedente perderebbe la camera
 * che si era configurata per lui.
 */
export function setAvatar(id: string): void {
  if (state.avatarId === id) return

  const salvata = readJson(STORAGE_KEYS.camera, parseCamera, null)
  const pertinente = salvata !== null && salvata.avatarKey === id && salvata.avatarKey !== ''

  setState({
    avatarId: id,
    framingOptions: null,
    availableExpressions: [],
    cameraCustomized: pertinente,
    camera: pertinente
      ? {
          distance: salvata.distance,
          targetHeight: salvata.targetHeight,
          orbitEnabled: salvata.orbitEnabled,
        }
      : FALLBACK_CAMERA,
  })
}

/** Registra un modello appena caricato e lo seleziona. */
export function addUploadedAvatar(avatar: UploadedAvatar): void {
  setState({ uploadedAvatars: [...state.uploadedAvatars, avatar] })
  setAvatar(avatar.id)
}

/** Rimuove un modello caricato; se era in uso, torna al predefinito. */
export function removeUploadedAvatar(id: string): void {
  setState({ uploadedAvatars: state.uploadedAvatars.filter((u) => u.id !== id) })
  if (state.avatarId === id) setAvatar(DEFAULT_AVATAR_ID)
}

/* --------------------------------------------------------------- memoria */

/** Aggiunge un ricordo e restituisce se è davvero nuovo. */
export function rememberMemory(text: string): { added: boolean; memory?: Memory | undefined } {
  const dopo = addMemory(text, state.memories)
  if (dopo === state.memories) return { added: false }
  const memory = dopo[dopo.length - 1]
  setState({ memories: dopo })
  return { added: true, memory }
}

/** Cancella i ricordi che contengono il testo, o tutti con "tutto". */
export function forgetMemory(query: string): number {
  const { memories, removed } = forgetMemories(query, state.memories)
  if (removed > 0) setState({ memories })
  return removed
}

/** Svuota i ricordi: il pulsante nel pannello. */
export function clearMemories(): void {
  setState({ memories: EMPTY_MEMORY })
}

/* ----------------------------------------------------------- promemoria */

/**
 * Imposta un promemoria.
 *
 * La scadenza ("fra 10 minuti", "alle 18:30") si risolve qui, non nel
 * modello: il modello passa la frase originale e non un orario calcolato,
 * così non può sbagliare il conto in silenzio.
 */
export function scheduleReminder(
  text: string,
  quando: string,
): { added: boolean; reminder?: Reminder | undefined; error?: string | undefined } {
  const esito = addReminder(text, quando, state.reminders)
  if (esito.reminder === undefined) return { added: false, error: esito.error }
  setState({ reminders: esito.reminders })
  return { added: true, reminder: esito.reminder }
}

/** Annulla i promemoria che contengono il testo, o tutti con "tutto". */
export function cancelReminder(query: string): number {
  const { reminders, removed } = cancelReminders(query, state.reminders)
  if (removed > 0) setState({ reminders })
  return removed
}

/**
 * Preleva i promemoria scaduti e alza l'avviso.
 *
 * Gli scaduti escono dall'elenco: suonano una volta sola. Chi chiama
 * pronuncia il `dueNotice` e lo archivia con `dismissDueNotice`.
 */
export function consumeDueReminders(nowMs: number = Date.now()): Reminder[] {
  const { due, rest } = popDue(state.reminders, nowMs)
  if (due.length === 0) return due
  setState({ reminders: rest, dueNotice: describeDue(due) })
  return due
}

/** Chiude l'avviso di scadenza dopo averlo letto. */
export function dismissDueNotice(): void {
  if (state.dueNotice !== null) setState({ dueNotice: null })
}

/**
 * Aggorna il profilo.
 *
 * Il conteggio delle conversazioni cresce una volta sola per sessione: ogni
 * messaggio non deve far aumentare anche il primo numero, altrimenti "12
 * conversazioni" dopo 40 scambi sarebbe semplicemente falso.
 */
export function bumpProfile(field: 'messages' | 'conversations'): void {
  setState({ profile: { ...state.profile, [field]: state.profile[field] + 1 } })
}

/** Apre o chiude un pannello. */
export function setPanel(id: PanelId, open: boolean): void {
  if (state.panels[id] === open) return
  setState({ panels: { ...state.panels, [id]: open } })
}

/** Apre o chiude tutti i pannelli insieme: il pulsante "chiudi tutto". */
export function setAllPanels(open: boolean): void {
  const panels = {} as Record<PanelId, boolean>
  for (const id of Object.keys(DEFAULT_PANELS) as PanelId[]) panels[id] = open
  setState({ panels })
}

/** Svuota la cronologia e gli errori: il pulsante "nuova conversazione". */
export function resetChat(): void {
  setState({ chatMessages: [], chatPartial: '', chatError: null })
}

/** Sostituisce la cronologia, senza toccare le preferenze. */
export function setChat(patch: Partial<AppState>): void {
  setState(patch)
}

export function setCamera(patch: Partial<CameraSettings>): void {
  setState({ camera: { ...state.camera, ...patch }, cameraCustomized: true })
}

/** Applica un'inquadratura precostruita sul modello caricato. */
export function applyFraming(framing: Framing): void {
  const option = state.framingOptions?.[framing]
  if (!option) return
  setState({
    framing,
    cameraCustomized: false,
    camera: { ...state.camera, distance: option.distance, targetHeight: option.targetHeight },
  })
}

export function restoreFraming(): void {
  if (!isFraming(state.framing)) return
  applyFraming(state.framing)
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Sottoscrive il componente all'intero stato.
 *
 * Il render loop di three.js NON passa da qui: legge `getState()` direttamente
 * dentro `requestAnimationFrame`. Così `avatarProgress`, che cambia decine di
 * volte al secondo durante il download, non causa alcun re-render del canvas.
 */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState, getState)
}