/**
 * Costanti globali dell'applicazione.
 * Tutto ciò che è magia numerica o un URL vive qui, non sparso nei moduli.
 */

/**
 * Limiti dello slider di distanza camera (metri).
 * Ampi di proposito: i valori di default li calcola `computeFraming` sul modello
 * reale, quindi i limiti servono solo a contenere gli estremi del cursore.
 */
export const CAMERA_DISTANCE = { min: 0.1, max: 8, step: 0.02 } as const

/** Limiti dello slider di altezza del punto inquadrato (metri da terra). */
export const CAMERA_TARGET_HEIGHT = { min: 0, max: 2.5, step: 0.01 } as const

/** Campo visivo verticale della camera, in gradi. 28° è un teleobiettivo leggero: addolcisce il viso. */
export const CAMERA_FOV = 28

export const FRAMING_LABELS = {
  face: 'Volto',
  bust: 'Busto',
  full: 'Figura intera',
} as const

export const DEFAULT_FRAMING = 'bust' as const

/** I cinque preset vocali che il lip-sync pilota. Presenti in tutti e tre i modelli inclusi. */
export const VISEME_PRESETS = ['aa', 'ee', 'ih', 'oh', 'ou'] as const

export type VisemePreset = (typeof VISEME_PRESETS)[number]

/**
 * Espressioni d'umore: i nomi che three-vrm dà davvero.
 *
 * Attenzione, perché sono nomi **riscritti**: un VRM 0.0 dichiara i preset con i
 * nomi della specifica 0.0 (`fun`, `joy`, `sorrow`, e `unknown` per
 * "sorpreso"), ma three-vrm li traduce nei nomi della 1.0 quando costruisce
 * l'expressionManager. Sui tre modelli inclusi si legge quindi `relaxed` e
 * `Surprised` — con la S maiuscola, perché quella veniva dal nome del gruppo e
 * non da una mappa di preset.
 *
 * Scrivere `fun` o `surprised` qui non romperebbe nulla: `setValue` su un
 * preset inesistente è un no-op e l'umore resterebbe semplicemente spento, per
 * sempre, senza un errore. I nomi sono quindi verificati dal test.
 */
export const GREETING_FLASH = { name: 'Surprised', weight: 0.18, seconds: 0.55 } as const

/**
 * Sorriso di fondo mentre l'avatar parla.
 *
 * È ciò che tiene il viso vivo durante una risposta lunga: gli occhi
 * lampeggiano, la bocca si muove, e senza un minimo di umore l'espressione
 * resta neutra per secondi. Tenuto basso, e solo mentre si parla.
 */
export const SPEAKING_MOOD = { name: 'relaxed', weight: 0.12 } as const

/**
 * Default della preferenza "lampeggia mentre parla".
 *
 * Vive qui perché la scrive **due** posti diversi: il campo di `VoicePrefs` nel
 * negozio e il campo del controller del linguaggio. Se i due avessero ciascuno il
 * proprio default, la casella del pannello potrebbe dire "acceso" mentre il motore
 * sospende il blink — uno scontento silenzioso, senza un errore e senza un
 * cambiamento visibile da cui accorgersi.
 */
export const BLINK_WHILE_SPEAKING = true

/** Chiavi di persistenza in localStorage. */
export const STORAGE_KEYS = {
  camera: 'vrmchat.camera.v1',
  voice: 'vrmchat.voice.v1',
  apiKey: 'vrmchat.openrouter.key.v1',
  chatModel: 'vrmchat.openrouter.model.v1',
  panels: 'vrmchat.panels.v1',
  memories: 'vrmchat.memories.v1',
  profile: 'vrmchat.profile.v1',
  conversation: 'vrmchat.conversation.v1',
  avatarChoice: 'vrmchat.avatar.choice.v1',
  uploadedAvatars: 'vrmchat.avatar.uploaded.v1',
} as const

/**
 * Sotto questa larghezza i pannelli non hanno spazio: diventano una vista a
 * schermo intero con schede.
 *
 * 1024px è il punto in cui il rail da 20rem e l'avatar non si pestano più i piedi.
 * Sotto, due colonne da 320px su un viewport da 768 non funzionano: si sommano a
 * 640px e schiacciano il soggetto al punto di tagliarlo.
 */
export const RAIL_MIN_WIDTH = 1024


/**
 * Modello iniziale.
 *
 * `openrouter/free` è un alias: OpenRouter instrada verso un modello gratuito
 * disponibile al momento. Serve come ripiego quando l'elenco non si riesce a
 * scaricare, ed è anche una scelta sensata come default — non si lega
 * l'utente a un modello che potrebbe sparire.
 */
export const DEFAULT_CHAT_MODEL = 'openrouter/free'

/**
 * Istruzione di sistema dell'assistente.
 *
 * Vive qui e non nella cronologia per due motivi: non occupa la finestra di
 * contesto a ogni turno, e non può essere "dimenticato" dal modello a metà
 * conversazione. Non si aggiornano le preferenze con un messaggio: sono
 * informazione di sistema, non un turno.
 *
 * Le risposte sono brevi perché vengono **prodotte a voce**: un paragrafo
 * scritto è accettabile, un paragrafo udito no. Chi chiede "come stai?" e si
 * sente tre paragrafi di cortesia ha già smesso di ascoltare.
 */
export const PERSONA = `Sei un assistente vocale dentro un avatar 3D. Parli in italiano.

Regole:
- Rispondi in due o tre frasi. Il tuo testo viene letto ad alta voce, non letto in silenzio: la brevità è cortesia, non limitazione.
- Niente elenchi puntati, niente markdown, niente titoli. La voce non li sa pronunciare.
- Una domanda sola alla volta, e solo se serve davvero.
- Se non sai, dillo. Meglio una risposta onesta che una inventata.
- Non citati fonti, non fornisci link: non puoi leglerli ad alta voce.
- Hai quattro strumenti: "ora" per l'ora e la data, "meteo" per il tempo in una città, "ricorda" e "dimentica" per la memoria. Sul tempo non indovinare mai: se ti chiedono il tempo, chiama lo strumento.
- Se l'utente dice "ricorda che..." o "ricorda che mi chiamo...", chiama "ricorda" prima di confermare. Non dire "te lo ricorderò" senza averlo salvato.
- Il tuo nome è "Ari".`

/** Limiti dei cursori della voce. */
export const VOICE_RATE = { min: 0.5, max: 2, step: 0.05 } as const
export const VOICE_PITCH = { min: 0.5, max: 1.8, step: 0.05 } as const

/** Lingua del riconoscimento predefinita. */
export const STT_LANG = 'it-IT'

/**
 * Tetto dei caratteri scrivibili in un messaggio.
 *
 * Non serve a far quadrare i conti: serve a non mandare un paste da un megapixel
 * come una richiesta da mezzo contesto. È un tetto sull'input, non un troncamento
 * finale: il campo semplicemente non accetta oltre, così nessuna parola sparisce
 * senza che se ne accorga l'utente.
 */
export const MAX_INPUT_CHARS = 2_000
