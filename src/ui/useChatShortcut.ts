import { useEffect } from 'react'

/**
 * Rende `/` e `Ctrl+K` un modo per arrivare al campo di testo.
 *
 * `/` è la scorciatoia che in una chat non ci si aspetta e basta digitare; con
 * qualcosa di già scritto non deve scattare, altrimenti impedirebbe di scrivere
 * una "/" dentro al messaggio.
 *
 * Vive in un file tutto suo perché un modulo che esporta sia un componente sia
 * una funzione fa saltare il Fast Refresh: in sviluppo ogni modifica a
 * `ChatInput` ricaricava l'intero pannello.
 */
export function useChatShortcut(inputId = 'chat-input'): void {
  useEffect(() => {
    const ascolta = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const staScrivendo =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      const daSbarra =
        (event.key === '/' && !staScrivendo && !event.metaKey && !event.ctrlKey) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')

      if (daSbarra) {
        event.preventDefault()
        document.getElementById(inputId)?.focus()
      }
    }
    window.addEventListener('keydown', ascolta)
    return () => window.removeEventListener('keydown', ascolta)
  }, [inputId])
}
