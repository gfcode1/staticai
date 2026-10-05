import { useEffect, useState } from 'react'

import { bundledById, revocaUrl, urlPerModello } from '../vrm/avatarLibrary'

/**
 * L'indirizzo del modello scelto, pronto da caricare.
 *
 * I modelli inclusi hanno un URL noto subito. Quelli caricati dal disco devono
 * prima uscire da IndexedDB e diventare un object URL, e questa operazione è
 * asincrona: senza questo hook servirebbe un `await` dentro l'effetto di
 * `AvatarStage`, che non è async e non ha motivo di esserlo.
 *
 * Il revinco dell'object URL è qui e non nel componente che carica: un URL
 * creato per un tentativo abbandonato deve morire comunque, altrimenti ogni
 * cambio di avatar lascia in giro un blob da 18 MB.
 */
export function useAvatarUrl(avatarId: string): { url: string | null; error: string | null } {
  const incluso = bundledById(avatarId)
  const [risolto, setRisolto] = useState<{ id: string; url: string } | null>(null)
  const [errore, setErrore] = useState<string | null>(null)

  // L'URL dei modelli inclusi si **deriva** durante il render: è noto, e farlo
  // con uno `setState` dentro l'effetto aggiungerebbe un render in più a ogni
  // cambio senza portare nulla.
  const url = incluso?.url ?? (risolto?.id === avatarId ? risolto.url : null)

  useEffect(() => {
    if (incluso) {
      // Niente da aspettare: un incluso non passa da IndexedDB. Lo stato delle
      // scelte precedenti non va svuotato, `url` guarda già `avatarId`.
      return
    }

    let attivo = true

    void urlPerModello(avatarId)
      .then((indirizzo) => {
        if (!attivo) {
          // Il tentativo è stato superato: questo object URL non serve a nessuno
          // e deve morire subito, non alla fine della pagina.
          revocaUrl(avatarId)
          return
        }
        // Un solo posto in memoria: sostituendo lo slot si libera anche
        // l'object URL del modello precedente.
        setRisolto((precedente) => {
          if (precedente && precedente.id !== avatarId) revocaUrl(precedente.id)
          return { id: avatarId, url: indirizzo }
        })
      })
      .catch((e: unknown) => {
        if (!attivo) return
        setErrore(e instanceof Error ? e.message : 'Modello non raggiungibile.')
      })

    return () => {
      attivo = false
    }
  }, [avatarId, incluso])

  // All'uscita dalla pagina gli object URL non servono più: tenerli vivi fino
  // alla garbage collection significa tenerci dentro ogni modello caricato.
  useEffect(() => {
    const libera = (): void => revocaUrl(avatarId)
    window.addEventListener('pagehide', libera)
    return () => window.removeEventListener('pagehide', libera)
  }, [avatarId])

  return { url, error: errore }
}
