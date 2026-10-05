/**
 * Controllo sintattico dei file in `scripts/`.
 *
 * `tsconfig.app.json` esclude `scripts` di proposito: i test importano con
 * percorsi assoluti come `/src/ai/tools.ts`, che il risolutore di TypeScript non
 * sa risolvere, e ogni import diventerebbe un errore. Il prezzo è che
 * `npm run typecheck` non li guarda.
 *
 * Il prezzo lo si è sentito: una stringa con l'apostrofo non chiuso
 * (`'c'è un altro…'`) è rimasta in un file di test per diverse esecuzioni senza
 * che il typecheck lo segnalasse. I test la trovano, ma solo quando arrivano a
 * quel file — cioè dopo tutto il resto.
 *
 * Qui si controlla **solo la sintassi**, che non richiede di risolvere nulla.
 * I tipi restano fuori: quelli li vede il runner Vite quando esegue il file.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

function main(): void {
  // `import.meta.dirname` dice quello che dice. `new URL('.', import.meta.url)`
  // sembrava la via ovvia e restituiva la radice del progetto: il controllo
  // passava in silenzio su `vite.config.ts` e non guardava nessuno dei test.
  const cartella = import.meta.dirname
  const nomi = readdirSync(cartella)
    .filter((nome) => nome.endsWith('.ts'))
    .sort()

  if (nomi.length === 0) {
    console.log('Nessun file da controllare: il percorso è sbagliato?')
    process.exit(1)
  }

  let errori = 0

  for (const nome of nomi) {
    const sorgente = readFileSync(join(cartella, nome), 'utf8')
    const fileAst = ts.createSourceFile(join(cartella, nome), sorgente, ts.ScriptTarget.ES2023, false, ts.ScriptKind.TS)
    const diagnostici = fileAst.parseDiagnostics ?? []

    if (diagnostici.length === 0) continue

    errori += diagnostici.length
    console.log(`\n  ${nome}`)
    for (const d of diagnostici) {
      const posizione = fileAst.getLineAndCharacterOfPosition(d.start ?? 0)
      console.log(`    ${posizione.line + 1}:${posizione.character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
    }
  }

  console.log(`\n${nomi.length} file in scripts/, ${errori} errori sintattici`)
  if (errori > 0) {
    process.exit(1)
  }
  console.log('SINTASSI CORRETTA')
}

main()