/**
 * Verifica della geometria dell'interfaccia.
 *
 * Questi controlli esistono perché il difetto che li ha motivati **non era
 * visibile a 211 verifiche di logica**: pulsante del microfono spinto fuori dal
 * viewport, cronologia che non scorreva, pannelli che non si chiudevano. Tutto
 * funzionava e illeggibile allo stesso tempo.
 *
 * La geometria si verifica solo in un browser vero, con un viewport vero. Qui si
 * guida Chrome con Playwright e si misura il DOM.
 */

import { chromium } from 'playwright-core'

const ORIGINE = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
/**
 * Chrome di sistema. `playwright-core` non scarica browser: questo test prova
 * l'utente vero, con il suo Chrome, che è anche quello in cui l'app è pensata
 * per funzionare (il riconoscimento on-device e la sintesi sono specifici).
 */
const CHROME = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome'

/** Dimensioni che coprono telefono, tablet, portatile e monitor. */
const VIEWPORTS = [
  { w: 420, h: 850, nome: 'telefono' },
  { w: 768, h: 1024, nome: 'tablet' },
  { w: 1024, h: 768, nome: 'portatile stretto' },
  { w: 1280, h: 800, nome: 'portatile' },
  { w: 1440, h: 900, nome: 'monitor' },
  { w: 1280, h: 420, nome: 'finestra bassa' },
]

let passate = 0
let fallite = 0
const problemi = []

function verifica(nome, condizione, dettaglio = '') {
  if (condizione) {
    passate += 1
    console.log(`  ok   ${nome}`)
  } else {
    fallite += 1
    problemi.push(`${nome}${dettaglio ? ' — ' + dettaglio : ''}`)
    console.log(`  FAIL ${nome}${dettaglio ? ' — ' + dettaglio : ''}`)
  }
}

/** Il pulsante del microfono, per geometria. */
const MISURA_MIC = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) =>
    /parla|ascolt/i.test(x.getAttribute('aria-label') || ''),
  )
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, vw: innerWidth }
})()`

/** Il rail: è il primo elemento con scorrimento verticale che non sia la cronologia. */
const MISURA_RAIL = `(() => {
  const el = [...document.querySelectorAll('div')].find(
    (d) => d.className.includes('max-h-[calc(100dvh-11rem)]'),
  )
  if (!el) return null
  el.scrollTop = 99999
  return { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop }
})()`

async function apriTutto(page) {
  for (let i = 0; i < 6; i += 1) {
    const btn = page.locator('button[aria-expanded=false]').first()
    if ((await btn.count()) === 0) break
    await btn.click()
    await page.waitForTimeout(220)
  }
  await page.waitForTimeout(500)
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: false,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
    ],
  })

  try {
    /* ------------------------------------------- il pulsante resta sempre dentro */
    console.log('\n=== Il microfono è sempre premibile ===')

    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } })
      const page = await context.newPage()
      await page.goto(ORIGINE, { waitUntil: 'networkidle', timeout: 180000 })
      await page.waitForFunction(() => !!window.__avatarDiagnostics, undefined, { timeout: 180000 })
      await page.waitForTimeout(1400)

      const iniziale = await page.evaluate(MISURA_MIC)
      verifica(
        `${vp.nome} ${vp.w}×${vp.h}: presente`,
        iniziale !== null,
        iniziale === null ? 'non trovato' : '',
      )

      if (iniziale !== null) {
        const dentro = iniziale.top >= 0 && iniziale.bottom <= iniziale.vh
        verifica(
          `${vp.nome}: dentro il viewport`,
          dentro,
          `top=${Math.round(iniziale.top)} bottom=${Math.round(iniziale.bottom)} vh=${iniziale.vh}`,
        )
      }

      // Il caso che ha rotto tutto: pannelli aperti.
      await apriTutto(page)
      const aperto = await page.evaluate(MISURA_MIC)
      const dentroAperto = aperto !== null && aperto.top >= 0 && aperto.bottom <= aperto.vh
      verifica(
        `${vp.nome}: dentro anche con tutti i pannelli aperti`,
        dentroAperto,
        aperto === null
          ? 'non trovato'
          : `top=${Math.round(aperto.top)} bottom=${Math.round(aperto.bottom)} vh=${aperto.vh}`,
      )

      const scrollX = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      verifica(`${vp.nome}: nessun scorrimento orizzontale`, !scrollX)

      await context.close()
    }

    /* --------------------------------------------------------- il rail scorre */
    console.log('\n=== Il rail scorre quando i pannelli non entrano ===')

    for (const vp of [VIEWPORTS[5], VIEWPORTS[3]]) {
      const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } })
      const page = await context.newPage()
      await page.goto(ORIGINE, { waitUntil: 'networkidle', timeout: 180000 })
      await page.waitForFunction(() => !!window.__avatarDiagnostics, undefined, { timeout: 180000 })
      await page.waitForTimeout(1400)
      await apriTutto(page)

      const rail = await page.evaluate(MISURA_RAIL)
      if (rail === null) {
        // Sotto 1024px il rail non esiste: la vista a schede fa quel lavoro.
        verifica(`${vp.nome}: niente rail atteso sotto 1024px`, vp.w < 1024)
        await context.close()
        continue
      }

      const trabocca = rail.scroll > rail.client
      if (trabocca) {
        verifica(`${vp.nome}: il rail scorre`, rail.top > 0, `scrollTop=${rail.top}`)
      } else {
        verifica(`${vp.nome}: tutto entra, nessuno scorrimento serve`, true)
      }
      await context.close()
    }

    /* ---------------------------------------------------- la cronologia scorre */
    console.log('\n=== La cronologia scorre e resta ancorata in fondo ===')

    for (const vp of [VIEWPORTS[1], VIEWPORTS[4]]) {
      const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } })
      const page = await context.newPage()
      await page.goto(ORIGINE, { waitUntil: 'networkidle', timeout: 180000 })
      await page.waitForFunction(() => !!window.__avatarDiagnostics, undefined, { timeout: 180000 })
      await page.waitForTimeout(1400)

      // Sul telefono la cronologia vive in una scheda a schermo intero.
      if (vp.w < 1024) {
        const apre = page.getByRole('button', { name: /Impostazioni|Chat e impostazioni/ })
        if ((await apre.count()) > 0) {
          await apre.click()
          await page.waitForTimeout(500)
        }
      }

      // Chat aperta con una conversazione lunga.
      const cronologia = await page.evaluate(() => {
        const store = window.__store
        if (!store) return null
        const messaggi = []
        for (let i = 0; i < 24; i += 1) {
          messaggi.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Messaggio numero ${i + 1}: testo abbastanza lungo da occupare più righe e far scorrere il riquadro.` })
        }
        store.setChat({ chatMessages: messaggi })
        return true
      })
      verifica(`${vp.nome}: store raggiungibile per il test`, cronologia !== null)
      await page.waitForTimeout(700)

      const m = await page.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find((d) =>
          d.className.includes('overscroll-contain') && d.className.includes('bg-slate-950/40'),
        )
        if (!el) return null
        const inFondo = el.scrollHeight - el.clientHeight - el.scrollTop
        return { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop, fondo: inFondo }
      })

      if (m === null) {
        verifica(`${vp.nome}: cronologia trovata`, false)
      } else {
        verifica(`${vp.nome}: il contenuto supera il riquadro`, m.scroll > m.client, `${m.scroll} vs ${m.client}`)
        verifica(`${vp.nome}: ancorata in fondo`, m.fondo < 8, `distanza dal fondo=${Math.round(m.fondo)}`)
        verifica(
          `${vp.nome}: altezza legata al viewport, non fissa`,
          m.client <= Math.round(vp.h * 0.5),
          `client=${m.client} viewport=${vp.h}`,
        )
      }
      await context.close()
    }

    /* --------------------------------------------- pannelli collassabili, mobile */
    console.log('\n=== Pannelli collassabili e vista a schede ===')

    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      await page.goto(ORIGINE, { waitUntil: 'networkidle', timeout: 180000 })
      await page.waitForFunction(() => !!window.__avatarDiagnostics, undefined, { timeout: 180000 })
      await page.waitForTimeout(1400)

      const prima = await page.evaluate(() => {
        const bottoni = [...document.querySelectorAll('button[aria-expanded]')]
        return bottoni.map((b) => ({
          titolo: b.textContent?.trim().slice(0, 20),
          aperto: b.getAttribute('aria-expanded'),
          controlla: !!document.getElementById(b.getAttribute('aria-controls') ?? ''),
        }))
      })
      verifica('i pannelli dichiarano aria-expanded', prima.length === 3, JSON.stringify(prima.map((x) => x.aperto)))
      verifica('default: chat aperta, altri chiusi', prima.filter((x) => x.aperto === 'true').length === 1, JSON.stringify(prima))
      verifica('ogni pannello controlla un corpo esistente', prima.every((x) => x.controlla))

      const chat = page.locator('button[aria-expanded=true]').first()
      await chat.click()
      await page.waitForTimeout(350)
      const chiuso = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) => /chat/i.test(x.textContent ?? ''))
        const corpo = document.getElementById(b?.getAttribute('aria-controls') ?? '')
        return { aperto: b?.getAttribute('aria-expanded'), nascosto: corpo?.hidden ?? null }
      })
      verifica('chiudere un pannello lo nasconde davvero', chiuso.aperto === 'false', JSON.stringify(chiuso))
      verifica('il corpo è hidden, non solo invisibile', chiuso.nascosto === true)

      const altoDopoChiusura = await page.evaluate(MISURA_MIC)
      verifica('il microfono resta dentro dopo aver chiuso', altoDopoChiusura.bottom <= altoDopoChiusura.vh)

      await context.close()
    }

    {
      const context = await browser.newContext({ viewport: { width: 420, height: 850 } })
      const page = await context.newPage()
      await page.goto(ORIGINE, { waitUntil: 'networkidle', timeout: 180000 })
      await page.waitForFunction(() => !!window.__avatarDiagnostics, undefined, { timeout: 180000 })
      await page.waitForTimeout(1400)

      const iniziale = await page.evaluate(() => ({
        schede: !!document.querySelector('[role=tablist]'),
        bottone: !!document.body.innerText.match(/Impostazioni|Chat e impostazioni/),
      }))
      verifica('su telefono le schede sono chiuse all\'inizio', !iniziale.schede)
      verifica('c\'è un bottone per aprirle', iniziale.bottone)

      await page.getByRole('button', { name: /Impostazioni|Chat e impostazioni/ }).click()
      await page.waitForTimeout(600)

      const aperta = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role=tab]')]
        return {
          schede: tabs.map((t) => t.textContent),
          selezionata: tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.textContent,
        }
      })
      verifica('le due schede ci sono', aperta.schede.length === 2, JSON.stringify(aperta.schede))
      verifica('la chat è la scheda iniziale', aperta.selezionata === 'Chat')

      for (const nome of ['Opzioni']) {
        await page.getByRole('tab', { name: nome }).click()
        await page.waitForTimeout(400)
        const dentro = await page.evaluate(() => ({
          selezionata: document.querySelector('[aria-selected=true]')?.textContent,
          contenuto: (document.querySelector('[role=tabpanel]')?.textContent ?? '').trim().length,
        }))
        verifica(`la scheda ${nome} mostra il suo contenuto`, dentro.selezionata === nome && dentro.contenuto > 20)
      }

      const mic = await page.evaluate(MISURA_MIC)
      verifica('il microfono non è coperto dalla vista a schede', mic !== null && mic.bottom <= mic.vh)

      await page.getByRole('button', { name: /Chiudi/ }).click()
      await page.waitForTimeout(500)
      const chiusa = await page.evaluate(() => !!document.querySelector('[role=tablist]'))
      verifica('chiudere riporta all\'avatar', !chiusa)

      await context.close()
    }
  } finally {
    await browser.close()
  }

    /* --------------------------------------------------- il selettore di avatar */
    console.log('\n=== Il selettore di avatar ===')

    // Browser proprio: le sezioni precedenti aprono e chiudono molti contesti, e
    // un Chrome headed con SwiftShader a un certo punto muore. Aggiungerne uno
    // condiviso renderebbe questa sezione dipendente da quante sezioni sono
    // prima di lei.
    const browserAvatar = await chromium.launch({
      executablePath: CHROME,
      headless: false,
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
      ],
    })
    {
      const context = await browserAvatar.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      const erroriPagina: string[] = []
      page.on('pageerror', (e) => erroriPagina.push(String(e).slice(0, 160)))
      await page.goto(ORIGINE, { waitUntil: 'networkidle', timeout: 180000 })
      await page.waitForFunction(() => !!window.__avatarDiagnostics, undefined, { timeout: 180000 })
      await page.waitForTimeout(1600)

      const selettore = page.locator('button[aria-expanded]').filter({ hasText: 'Opzioni' })
      verifica('il pannello Opzioni esiste', (await selettore.count()) === 1)
      await selettore.click()
      await page.waitForTimeout(500)

      // Si registra l'**indice** del pulsante e non il suo testo: il nome
      // accessibile concatena etichetta e nota di licenza, quindi selezionarlo
      // per nome significherebbe accettare una stringa lunga e fragile.
      // I pulsanti avatar vivono nella sezione "Avatar" dentro Opzioni: le
      // tre voci di inquadratura (Volto/Busto/Figura) hanno anch'esse
      // `aria-pressed` e vanno escluse, altrimenti il cambio cliccherebbe un
      // framing invece di un modello.
      const voci = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) => /Opzioni/i.test(x.textContent ?? ''))
        const corpo = document.getElementById(b?.getAttribute('aria-controls') ?? '')
        const sezioneAvatar = corpo?.querySelector('section[aria-label="Avatar"]') ?? corpo
        const pulsanti = sezioneAvatar ? [...sezioneAvatar.querySelectorAll('button[aria-pressed]')] : []
        return {
          tot: pulsanti.length,
          nomi: pulsanti.map((x) => x.getAttribute('aria-label') ?? x.textContent?.slice(0, 20) ?? ''),
          selezionato: pulsanti.findIndex((x) => x.getAttribute('aria-pressed') === 'true'),
          licenze: corpo ? [...corpo.querySelectorAll('span')].map((x) => x.textContent ?? '').filter((t) => /licenz/i.test(t)).length : 0,
          caricamento: corpo?.querySelector('input[type=file]') !== null,
          avvisoPrivacy: /IndexedDB|non passano da nessun server/i.test(corpo?.textContent ?? ''),
        }
      })
      verifica('i modelli inclusi sono elencati', voci.tot >= 2, JSON.stringify(voci.nomi))
      verifica('ogni modello dichiara la licenza', voci.licenze >= 2, String(voci.licenze))
      verifica("c'è un campo per caricare un .vrm", voci.caricamento)
      verifica('si dice dove finiscono i file caricati', voci.avvisoPrivacy)

      // Cambio di avatar: il contesto WebGL deve sopravvivere, perché è la
      // cosa che si rompe se il `key` non fa il suo lavoro.
      // Le dichiarazioni globali sono già in `appStore.ts` e in `AvatarStage`:
      // le conversioni di tipo qui dentro non servono e appesantiscono il codice.
      // L'identità del modello va presa dalla geometria, non dalla versione
      // dello spec: i tre modelli inclusi sono tutti VRM 0.0, quindi confrontare
      // `specVersion` non distinguerebbe nessuno e il test passerebbe (o
      // fallirebbe) per un motivo che non c'entra con il cambio. I triangoli
      // sono diversi per costruzione: 114k su Kaori, 51k su Olivia, 48k su Emma.
      const prima = await page.evaluate(() => ({
        id: window.__store?.get().avatarId ?? '',
        triangoli: window.__avatarDiagnostics?.triangles ?? -1,
      }))
      let indiceAltro = -1
      for (let i = 0; i < voci.tot; i += 1) {
        if (i !== voci.selezionato) {
          indiceAltro = i
          break
        }
      }
      verifica("c'è un altro modello da scegliere", indiceAltro >= 0, JSON.stringify(voci.nomi))
      if (indiceAltro >= 0) {
        const pannello = page.locator('button[aria-expanded]').filter({ hasText: 'Opzioni' })
        await pannello.evaluate((b, i) => {
          const corpo = document.getElementById(b.getAttribute('aria-controls') ?? '')
          const sezioneAvatar = corpo?.querySelector('section[aria-label="Avatar"]') ?? corpo
          const pulsanti = sezioneAvatar ? [...sezioneAvatar.querySelectorAll('button[aria-pressed]')] : []
          pulsanti[i]?.click()
        }, indiceAltro)
        await page.waitForTimeout(5000)
        const dopo = await page.evaluate(() => ({
          id: window.__store?.get().avatarId ?? '',
          triangoli: window.__avatarDiagnostics?.triangles ?? -1,
          canvasDisegna: (() => {
            const c = document.querySelector('canvas')
            return !!c && c.width > 0 && c.height > 0
          })(),
          erroriVisibili: document.body.innerText.includes('Impossibile caricare') || document.body.innerText.includes('non disponibile'),
        }))
        verifica('il cambio di avatar avviene', dopo.id !== prima.id, `${prima.id} → ${dopo.id}`)
        verifica('il contesto WebGL sopravvive al cambio', dopo.canvasDisegna)
        verifica('nessun errore a schermo dopo il cambio', !dopo.erroriVisibili)
        verifica(
          'è un altro modello davvero, non solo un altro id',
          dopo.triangoli > 0 && dopo.triangoli !== prima.triangoli,
          `${prima.triangoli} → ${dopo.triangoli} triangoli`,
        )
      }

      verifica('nessun errore in pagina', erroriPagina.length === 0, erroriPagina.join(' | '))
      await context.close()
    }
    await browserAvatar.close()

  console.log(`\n=== riepilogo ===`)
  console.log(`${passate} verifiche superate, ${fallite} fallite`)
  if (fallite > 0) {
    for (const p of problemi) console.log(`  - ${p}`)
    process.exit(1)
  }
  console.log('TUTTE LE VERIFICHE SUPERATE')
}

await main()