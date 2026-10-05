import { useCallback, useSyncExternalStore } from 'react'

import { RAIL_MIN_WIDTH } from '../config'

/**
 * Segue una media query CSS.
 *
 * Serve a scegliere **il layout**, non a decorarlo: cambiare il numero di
 * colonne è una decisione strutturale e non può dipendere da un resize
 * JavaScript che arriva dopo il primo paint, mostrando per un istante la colonna
 * stretta su uno schermo largo.
 *
 * `useSyncExternalStore` invece di uno stato aggiornato in un effetto: la prima
 * lettura è sincrona durante il render, quindi non esiste il fotogramma in cui
 * la larghezza è ancora sconosciuta e il layout parte sbagliato — proprio il
 * tipo di sfarfallio che si vede solo ricaricando la pagina.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** C'è spazio per il rail, o serve la vista a schede? */
export function useWideLayout(): boolean {
  return useMediaQuery(`(min-width: ${RAIL_MIN_WIDTH}px)`)
}