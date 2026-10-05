/**
 * Tipi minimi della Web Speech Recognition API.
 *
 * L'API non è standard e non è in `lib.dom`: TypeScript non la conosce, ma il
 * browser la espone. Dichiarare qui solo il sottoinsieme che usiamo evita di
 * tipizzare a mano ogni evento e rende esplicito, in un colpo d'occhio, da chi
 * dipendiamo davvero: se domani il motore, un cambiamento di specifica lo
 * segnala come errore di compilazione invece di fallire a runtime.
 *
 * Quando l'API diventerà standard questi tipi dovranno essere rimossi: i
 * duplicati confliggerebbero con quelli ufficiali.
 */

type SpeechRecognitionErrorCode =
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'phrasing-not-supported'

interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode
  readonly message: string
}

interface SpeechRecognitionEventMap {
  start: Event
  end: Event
  result: SpeechRecognitionEvent
  error: SpeechRecognitionErrorEvent
  nomatch: Event
  soundstart: Event
  speechstart: Event
  speechend: Event
  audiostart: Event
  audioend: Event
}

interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number

  /** Chrome 138+: elaborazione sul dispositivo. */

  start(): void
  stop(): void
  abort(): void

  onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null
  onend: ((this: SpeechRecognition, ev: Event) => unknown) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}
