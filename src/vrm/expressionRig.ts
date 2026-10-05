import type { VRMExpressionManager } from '@pixiv/three-vrm-core'
import type { VRM } from '@pixiv/three-vrm'

import { GREETING_FLASH, SPEAKING_MOOD, VISEME_PRESETS, type VisemePreset } from '../config'

type VisemeMap = Record<VisemePreset, number>

/** Costante di tempo dello smoothing dei visemi, in secondi. */
const VISEME_SMOOTHING_TAU = 0.06
/** Sotto questa variazione non riscriviamo il valore: 60 scritture/s inutili per espressione. */
const WRITE_EPSILON = 0.005

/**
 * Come pure il smoothing dei visemi, questo tau è un tempo: `alpha = 1 - e^(-dt/tau)`.
 * Con un tau fisso a 60 fps il movimento cambierebbe velocità su un monitor a
 * 120 Hz, e le espressioni sembrerebbero reattive al raddoppio del frame rate.
 */
const MOOD_SMOOTHING_TAU = 0.28

/** Chiusura e apertura della palpebra, in secondi. Una chiusura reale dura ~100 ms. */
const BLINK_CLOSE_SECONDS = 0.08
const BLINK_OPEN_SECONDS = 0.12
/** Intervallo fra due lampeggi: la media reale è ~4 s, con code lunghe fino a 10. */
const BLINK_MIN_GAP = 2.4
const BLINK_MAX_GAP = 5.2
const BLINK_DOUBLE_PROBABILITY = 0.15

interface BlinkState {
  /** Momento (in secondi di clock) in cui il prossimo blink riparte. */
  nextAt: number
  /** Fase corrente del blink. */
  phase: 'idle' | 'closing' | 'opening'
  phaseStartedAt: number
  /** Dopo il primo blink, un eventuale secondo entro 220ms. */
  pendingSecond: boolean
}

/**
 * Le espressioni d'umore, con il loro peso di arrivo.
 *
 * Non sono presenti in ogni modello: se il preset non c'è, la voce viene
 * ignorata e il rig continua a funzionare. `relaxed` è il sorriso di fondo,
 * `Surprised` il lampo a inizio risposta — nomi che vengono da `config.ts`
 * perché three-vrm li ha riscritti rispetto alla specifica 0.0 del file.
 */
const MOOD_NAMES = [SPEAKING_MOOD.name, GREETING_FLASH.name] as const
type MoodName = (typeof MOOD_NAMES)[number]
type MoodMap = Record<MoodName, number>

function zeroVisemes(): VisemeMap {
  return { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 }
}

function zeroMoods(): MoodMap {
  // Le chiavi vengono dai nomi in `config.ts`, non scritte a mano: sono nomi
  // riscritti da three-vrm e cambiare quelli senza passare da lì romperebbe
  // l'umore in silenzio.
  return { [SPEAKING_MOOD.name]: 0, [GREETING_FLASH.name]: 0 }
}

/**
 * Rampa del blink: 0 → 1 → 0 con una curva smorzata.
 *
 * Una rampa lineare si vede come uno "squartamento" della palpebra, perché la
 * velocità non si annulla mai ai due estremi. `sin(πt)` parte e finisce con
 * velocità quasi nulla, ed è quello che fa un ammicco vero.
 */
function blinkCurve(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.sin(clamped * Math.PI)
}

/**
 * Ponte tra il testo/voce e le espressioni facciali del VRM.
 *
 * Tutti e tre i modelli inclusi espongono i cinque preset vocali (`aa`, `ee`,
 * `ih`, `oh`, `ou`), `blink`, `blinkLeft`, `blinkRight` e le emozioni: il rig
 * sfrutta i visemi e il blink, e sfiora le emozioni solo per il lampo e il
 * sorriso di fondo. I `blinkLeft`/`blinkRight` sono lasciati stare di proposito:
 * il `blink` master è già il massimo dei tre, e pilotarlo insieme agli altri
 * significherebbe socchiudere due volte.
 *
 * Tutto lo smoothing avviene qui dentro, a 60 fps: chi imposta i valori può
 * chiamare `setVisemes` a qualsiasi frequenza senza produrre salti.
 */
export class ExpressionRig {
  /** Null solo se il VRM non espone espressioni: il rig degrada a no-op. */
  private readonly manager: VRMExpressionManager | null
  private readonly supported = new Set<string>()

  private readonly target: VisemeMap = zeroVisemes()
  private readonly current: VisemeMap = zeroVisemes()
  private readonly written: VisemeMap = zeroVisemes()

  /** Umore: peso di arrivo, peso corrente e ultimo peso scritto. */
  private readonly moodTarget: MoodMap = zeroMoods()
  private readonly moodCurrent: MoodMap = zeroMoods()
  private readonly moodWritten: MoodMap = zeroMoods()

  private blink: BlinkState = {
    nextAt: 0,
    phase: 'idle',
    phaseStartedAt: 0,
    pendingSecond: false,
  }

  private blinkValue = 0
  private blinkWritten = -1
  private clock = 0
  private autoBlink = true
  /** Lampo di espressione in corso: nome, peso e scadenza. */
  private flash: { name: MoodName; weight: number; endsAt: number } | null = null
  private disposed = false

  constructor(vrm: VRM) {
    this.manager = vrm.expressionManager ?? null
    if (!this.manager) return
    for (const name of Object.keys(this.manager.expressionMap)) this.supported.add(name)
  }

  /** true se almeno un preset vocale può essere pilotato. */
  get hasAnyViseme(): boolean {
    return this.supportedVisemes.length > 0
  }

  /** Preset vocali effettivamente supportati dal modello caricato. */
  get supportedVisemes(): VisemePreset[] {
    return VISEME_PRESETS.filter((name) => this.supported.has(name))
  }

  hasBlink(): boolean {
    return this.supported.has('blink')
  }

  /** true se il modello espone il sorriso di fondo. */
  get hasMood(): boolean {
    return this.supported.has(SPEAKING_MOOD.name)
  }

  /**
   * Accende o spegne il blink automatico.
   *
   * Utile soprattutto in verifica: con il blink attivo è impossibile distinguere
   * il suo contributo da un viseme.
   */
  setAutoBlink(enabled: boolean): void {
    this.autoBlink = enabled
    if (!enabled) {
      this.blink.phase = 'idle'
      this.blink.nextAt = Number.POSITIVE_INFINITY
      this.blink.pendingSecond = false
    }
  }

  get isAutoBlinkEnabled(): boolean {
    return this.autoBlink
  }

  /**
   * Il lampo di inizio risposta: un peso che sale e scende da solo in `flashSeconds`.
   *
   * Va chiamato una volta per frase. Se il modello non ha l'espressione, non
   * succede nulla: è un extra, mai una condizione perché qualcosa funzioni.
   */
  greetingFlash(): void {
    if (GREETING_FLASH.weight <= 0) return
    if (!this.supported.has(GREETING_FLASH.name)) return
    this.flash = {
      name: GREETING_FLASH.name,
      weight: GREETING_FLASH.weight,
      endsAt: this.clock + GREETING_FLASH.seconds,
    }
  }

  /** Il peso di un'espressione pilotata dal rig, per test e debug. */
  moodValue(name: string): number {
    return this.moodCurrent[name as MoodName] ?? 0
  }

  /** Imposta i valori di arrivo dei visemi. Accetta solo un sottoinsieme. */
  setVisemes(values: Partial<VisemeMap>): void {
    if (this.disposed) return
    for (const name of VISEME_PRESETS) {
      const value = values[name]
      if (value === undefined) continue
      this.target[name] = value < 0 ? 0 : value > 1 ? 1 : value
    }
  }

  /** Il sorriso di fondo mentre si parla. Zero = faccia neutra. */
  setSpeakingMood(weight: number): void {
    if (this.disposed) return
    const name = SPEAKING_MOOD.name
    if (!this.supported.has(name)) return
    this.moodTarget[name] = weight < 0 ? 0 : weight > 1 ? 1 : weight
  }

  /** Porta tutti i visemi a zero: la bocca torna a riposo. */
  silence(): void {
    for (const name of VISEME_PRESETS) this.target[name] = 0
    this.setSpeakingMood(0)
  }

  /** Azzera ogni espressione, compresi eventuali valori impostati a mano. */
  reset(): void {
    this.silence()
    this.flash = null
    for (const name of MOOD_NAMES) this.moodTarget[name] = 0
    this.manager?.resetValues()
  }

  update(deltaSeconds: number): void {
    if (this.disposed || !this.manager) return

    this.clock += deltaSeconds
    this.updateVisemes(deltaSeconds)
    this.updateMood(deltaSeconds)
    this.updateBlink()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset()
  }

  /**
   * Smoothing esponenziale indipendente dal frame rate:
   * alpha = 1 - e^(-dt / tau). Con un tau fisso a 60 fps l'animazione
   * accelererebbe su monitor a 120 Hz e rallenterebbe a 30 Hz.
   */
  private updateVisemes(deltaSeconds: number): void {
    if (!this.manager) return
    const alpha = 1 - Math.exp(-deltaSeconds / VISEME_SMOOTHING_TAU)

    for (const name of VISEME_PRESETS) {
      const next = this.current[name] + (this.target[name] - this.current[name]) * alpha
      const clamped = next < 0 ? 0 : next > 1 ? 1 : next
      this.current[name] = clamped

      if (!this.supported.has(name)) continue
      if (Math.abs(clamped - this.written[name]) < WRITE_EPSILON) continue

      this.written[name] = clamped
      this.manager.setValue(name, clamped)
    }
  }

  /**
   * Umore: il sorriso di fondo e il lampo di inizio risposta.
   *
   * Il lampo non entra nel peso di arrivo ma lo **sovrascrive** finché è vivo:
   * una variazione continua piccola (0.18) non produrrebbe alcuna scrittura con
   * `WRITE_EPSILON`, perché resterebbe sotto la soglia. Qui invece parte da 0 e
   * sale, quindi si vede.
   */
  private updateMood(deltaSeconds: number): void {
    if (!this.manager) return
    const alpha = 1 - Math.exp(-deltaSeconds / MOOD_SMOOTHING_TAU)

    if (this.flash && this.clock >= this.flash.endsAt) this.flash = null

    for (const name of MOOD_NAMES) {
      if (!this.supported.has(name)) continue

      let target = this.moodTarget[name]
      // Il lampo sovrascrive il fondo: parte da 0 e sale, quindi la differenza
      // rispetto allo zero supera la soglia di scrittura. `flash` diventa null
      // alla scadenza, e il peso rientra al valore di fondo con lo stesso tau.
      if (this.flash?.name === name) target = this.flash.weight

      const next = this.moodCurrent[name] + (target - this.moodCurrent[name]) * alpha
      const clamped = next < 0 ? 0 : next > 1 ? 1 : next
      this.moodCurrent[name] = clamped

      if (Math.abs(clamped - this.moodWritten[name]) < WRITE_EPSILON) continue
      this.moodWritten[name] = clamped
      this.manager.setValue(name, clamped)
    }
  }

  private updateBlink(): void {
    if (!this.manager || !this.hasBlink()) return

    let value = 0
    if (!this.autoBlink) {
      if (this.blinkWritten !== 0) {
        this.blinkWritten = 0
        this.blinkValue = 0
        this.manager.setValue('blink', 0)
      }
      return
    }

    switch (this.blink.phase) {
      case 'idle': {
        if (this.blink.nextAt === 0) {
          this.blink.nextAt = this.clock + this.randomGap()
        } else if (this.clock >= this.blink.nextAt) {
          this.blink.phase = 'closing'
          this.blink.phaseStartedAt = this.clock
        }
        break
      }
      case 'closing': {
        const t = (this.clock - this.blink.phaseStartedAt) / BLINK_CLOSE_SECONDS
        value = blinkCurve(t)
        if (t >= 1) {
          this.blink.phase = 'opening'
          this.blink.phaseStartedAt = this.clock
        }
        break
      }
      case 'opening': {
        const t = (this.clock - this.blink.phaseStartedAt) / BLINK_OPEN_SECONDS
        value = 1 - blinkCurve(t)
        if (t >= 1) {
          if (this.blink.pendingSecond) {
            this.blink.pendingSecond = false
            this.blink.phase = 'closing'
            this.blink.phaseStartedAt = this.clock
            break
          }
          this.blink.phase = 'idle'
          this.blink.nextAt = this.clock + this.randomGap()
        }
        break
      }
    }

    if (Math.abs(value - this.blinkWritten) < WRITE_EPSILON) return
    this.blinkWritten = value
    this.blinkValue = value
    this.manager.setValue('blink', value)
  }

  private randomGap(): number {
    const gap = BLINK_MIN_GAP + Math.random() * (BLINK_MAX_GAP - BLINK_MIN_GAP)
    // Un doppio blink occasionale: due chiusure ravvicinate, come negli umani.
    this.blink.pendingSecond = Math.random() < BLINK_DOUBLE_PROBABILITY
    return gap
  }

  /** Valore corrente del blink, esposto per test e debug. */
  get currentBlink(): number {
    return this.blinkValue
  }
}