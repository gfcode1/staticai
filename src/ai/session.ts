/**
 * Sessione di conversazione unica per l'applicazione.
 *
 * Vive in un modulo e non in un componente per una ragione precisa: il
 * microfono e la chat devono potersi interrompere a vicenda. `MicButton`
 * riceve la frase da `ListeningSession`, la chiude appena riconosciuta, e se in
 * quel momento è in corso una risposta va interrotta — è il barge-in. Un
 * oggetto creato dentro un componente vivrebbe e morirebbe con quel componente,
 * e l'interruzione non avrebbe nessun soggetto su cui agire.
 */

import { createConversation, type Session } from './conversation'
import { bumpProfile, getState, setChat, voiceSettings } from '../store/appStore'
import { speech } from '../speech/speechController'

export const conversation = createConversation({
  onMessages: (chatMessages) => setChat({ chatMessages }),
  onStatus: (chatStatus) => setChat({ chatStatus }),
  onPartial: (chatPartial) => setChat({ chatPartial }),
  onError: (chatError) => setChat({ chatError, chatPartial: '' }),
  onActivity: (chatActivity) => setChat({ chatActivity }),
})

/**
 * Manda una frase al modello e la fa pronunciare.
 *
 * Si passa dalla voce alle impostazioni correnti **al momento della frase**, non
 * quando è stato creato il pannello: se l'utente cambia la velocità della voce
 * mentre l'avatar sta parlando, la prossima frase usa la velocità nuova.
 */
export function sendUtterance(text: string): void {
  const { apiKey, chatModel, voice } = getState()
  bumpProfile('messages')
  invii += 1
  ultimoInvio = { testo: text, modello: chatModel, conChiave: apiKey.trim() !== '' }
  if (import.meta.env.DEV) {
    window.__conversazione = {
      invii,
      ultimoInvio,
      sessione: conversation,
      // Il log delle frasi pronunciate è ciò che distingue "ha risposto" da
      // "ha risposto e lo ha detto".
      pronunciate: () => speech.spokenLog,
    }
  }
  void conversation.submit(text, apiKey, chatModel, voiceSettings(voice))
}

let invii = 0
let ultimoInvio: { testo: string; modello: string; conChiave: boolean } | null = null

declare global {
  interface Window {
    /** Ultimo invio e sessione, solo in sviluppo. */
    __conversazione?: {
      invii: number
      ultimoInvio: typeof ultimoInvio
      sessione: Session
      pronunciate: () => { text: string; at: number }[]
    }
  }
}

/** Interrompe risposta in arrivo e coda di voce. */
export function interruptReply(): void {
  if (conversation.busy || getState().chatStatus !== 'idle') conversation.abort()
}