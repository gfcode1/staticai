# AGENTS.md

Voice assistant with a VRM avatar. React 19 + three.js + `@pixiv/three-vrm`, Vite 8,
Tailwind v4. `README.md` (Italian) is the real design document — it explains the
*why* behind the render order, the Chrome workarounds, the memory model. Read the
relevant section before changing `src/vrm/`, `src/speech/` or `src/ai/`. Code
comments and doc blocks are in Italian: match that.

Not a git repo. No CI. No test framework dependency.

## Commands

```bash
npm run typecheck   # tsc -b (src/) + syntax-only pass over scripts/
npm run lint        # oxlint (warnings only, not blocking)
npm test            # 6 logic suites, all offline
npm run test:ui     # geometry suite — NOT in npm test, see below
npm run check:live  # real network calls to Open-Meteo/GeoNames — not in npm test
```

Gate order: `lint` → `typecheck` → `test`. Node 20.19+ / 22.12+ (Vite 8).

Two suites are deliberately outside `npm test`:

- `npm run test:ui` drives the **system** Chrome through `playwright-core`
  (`playwright-core` downloads no browsers). Needs `npm run dev` already running
  and `/opt/google/chrome/chrome`; override with `CHROME_PATH` / `APP_URL`.
  Run it after any change to layout, `PanelRail`, `MobilePanelView`, `MicButton`.
- `npm run check:live` hits third-party APIs. Failures there are not necessarily ours.

Run one suite, not the whole battery: `npm run test:speech`, `test:listening`,
`test:ai`, `test:tools`, `test:memory`, `test:store`, `test:avatar`.

## Test architecture (non-obvious)

Each `scripts/run-*-checks.ts` boots a Vite SSR server and
`ssrLoadModule('/scripts/verify-*.ts')`. That is deliberate: app modules use
extensionless imports which Node cannot resolve, so this exercises the *real*
resolver against the *real* code.

Consequences you must respect when adding tests:

- Test files import via root-absolute paths: `from '/src/store/persistence.ts'`.
- That is why `tsconfig.app.json` **excludes** `scripts` — those imports would be
  unresolvable errors for TypeScript. The price is that `npm run typecheck` does
  not type-check tests; `scripts/check-scripts.ts` only parses them for syntax.
  Types are checked at runtime by the Vite runner.
- No assertion library. Each `verify-*.ts` hand-rolls `check()` / `eq()` counters
  and exits non-zero on failure.
- UI-dependent suites install fake `globalThis.window` objects. A fake without
  timers breaks `debounce` for reasons unrelated to what is under test.

## Invariants that break silently

**Render loop order** in `AvatarStage.tsx` is load-bearing:

1. `expressionRig.update()` — sets expression weights
2. `vrm.update(delta)` — pushes weights into `morphTargetInfluences`, syncs bones
3. `idleMotion.update()` — **after**, because `humanoid.update()` re-copies the
   normalized bones over the raw ones

Corollary: pose corrections must be written to *normalized* bones. Written on raw
bones they are erased on the first `vrm.update()` — which is exactly what happened
once already. `expressionManager.setValue()` alone moves nothing.

**Canvas lifecycle.** The `<canvas>` is created inside the `useEffect`, never in
JSX. React StrictMode double-mounts; reusing the element hands `WebGLRenderer` a
context already lost to `forceContextLoss()` and the screen stays black. Swapping
avatars must remount with `key={avatarId}` — the key *is* the guarantee.

**Render loop does not go through React.** It reads `getState()` inside
   `requestAnimationFrame`. Do not move `avatarProgress` into React state.

Corollary, easy to get wrong: a preference the render loop depends on must be
   pushed **outside** React too. `speech` is a module singleton with no
   subscription, so `VoicePrefs.blinkWhileSpeaking` is deposited in it at module
   load *and* by `setBlinkWhileSpeaking()`. Writing it only to the store gives a
   checkbox that flips without changing anything.

   The **default** of that preference is written in two places too — the
   `VoicePrefs` field and the controller's field — so it lives in `config.ts` as
   `BLINK_WHILE_SPEAKING` and `verify-avatar.ts` fails if they ever diverge. A
   checkbox reading "on" while the engine does the opposite is a silent
   disagreement: no error, no warning, nothing to notice.

**The gaze does not follow the pointer.** `lookAtTarget` is a fixed `Object3D`
   one metre in front of the face, and there is no `pointermove` listener. Its Y
   comes from `locateFace()` / `measureModel().eyeHeight`, **not** from
   `camera.targetHeight`: with the `bust` framing that sits well below the eyes
   and the avatar would stare at the floor. Re-adding mouse tracking has to be a
   deliberate choice, not an accident of a leftover lerp.

**Baked avatars.** The three bundled models are VRM 0.0 exports from VRoid
   (UniGLTF) with 17-19 `secondaryAnimation.boneGroups` — hair, skirt, sleeves
   and hood strings all follow the head. Two consequences: `idleMotion`'s
   amplitudes are roughly half what a springbone-less model wants (head yaw is
   2.2°, not 3.5°), and they cannot be raised for a user-loaded model without a
   per-model factor. `lookAt.type` is `bone`, so mouse tracking moved only the
   eye bones, never the head.

**Defensive parsing has a boundary.** In `store/persistence.ts` the `try` covers
only storage access and JSON parsing — the *parser* sits outside it, so a code bug
surfaces instead of being swallowed as a fallback. A temporal-dead-zone
`ReferenceError` was once hidden exactly this way and shipped a silent
empty-history bug. Preserve that split in any new defensive code.

**Memory is prompt-injection surface.** Memory text is flattened to a single line
and capped at 300 chars in **three** places: on save, on read from
`localStorage`, and when building the prompt. The third is the one that matters —
do not add a path that bypasses it.

**Chrome's TTS/STT defects are worked around in code**, each with the remedy
next to the comment in `src/speech/tts.ts` (empty `getVoices()` at start, queue
suspension after silence, ~130-char chunk ceiling, 60 ms after `cancel()`,
missing `end` events, `interrupted` after our own cancel). Re-read that table
before "simplifying" the queue. Chrome on Linux never fires `boundary`, which is
why lip-sync is text-derived and duration-calibrated rather than timestamped.

**CSS layout rules.** The mic button is absolutely positioned and must never
re-enter normal flow — this exact regression shipped once and 211 logic checks
could not see it. Use `dvh`, never `vh`. The rail/tab breakpoint is
`RAIL_MIN_WIDTH` (1024) in `src/config.ts`; panels scroll themselves, the page
does not.

## Other conventions

- `three` is pinned to `0.180.0`. `@pixiv/three-vrm@3.5.5` is tested against
  `^0.180.0`; installing latest exits the tested range.
- Vite 8 uses Rolldown: `manualChunks` in `vite.config.ts` accepts **only** the
  function form. The object form was removed.
- Strict TS flags are aggressive and enforced: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (type-only imports must use
  `import type`), `erasableSyntaxOnly` (no enums, no parameter properties).
- Magic numbers and URLs live in `src/config.ts` (`STORAGE_KEYS`, slider limits,
  `RAIL_MIN_WIDTH`, `MAX_INPUT_CHARS`, `PERSONA`, `DEFAULT_CHAT_MODEL`). Not
  scattered in modules.
- No state library. `src/store/appStore.ts` is `useSyncExternalStore` with a plain
  object; persistence is debounced `localStorage` (700 ms, 60-message cap).
  Uploaded VRM blobs go to IndexedDB, only their names/sizes to `localStorage`.
- No env vars. The OpenRouter key is entered in the UI and kept in
  `localStorage`; the free-model list is fetched at runtime (free model IDs churn).
- Diagnostics: `window.__avatarDiagnostics` always; `window.__avatar`,
  `window.__speech` only under `import.meta.env.DEV`. Keep dev-only handles behind
  that guard so tree-shaking still removes them.
- The bundled avatars are all **VRoid, license "Other"**, and none is CC0:
  `Kaori.vrm` (Fouwaru) allows redistribution but forbids modification and does
  not require credit; `Olivia.vrm` and `Emma.vrm` (Lucky) require credit and
  allow modification, non-commercial personal use. `verify-avatar.ts` enforces
  that every `BUNDLED` entry states a license *and* an author, and that the file
  really exists in `public/`. Do not add a model without recording its license
  in `src/vrm/avatarLibrary.ts` — the UI surfaces the per-entry note.
- **Expression names are three-vrm's, not the file's.** A VRM 0.0 declares its
  presets with the 0.0 names (`fun`, `joy`, `sorrow`, `unknown`), but three-vrm
  translates them into 1.0 names when it builds the expressionManager. On the
  bundled models that means `relaxed` and `Surprised` — capital S, because that
  one comes from the group's name rather than a preset map. Writing `fun` or
  `surprised` breaks nothing: `setValue` on an absent preset is a no-op, so the
  mood stays permanently off with no error. The names live in `config.ts` for
  that reason, and `verify-avatar.ts` pins them.
- `detectUnlit()` must run **before** `VRMUtils`/three-vrm touch the parsed JSON.
  The MToon plugin's `beforeRoot()` deletes `KHR_materials_unlit` from any
  material that also declares MToon, so reading it afterwards reports `true` for
  every bundled avatar and wrongly implies the scene lights do nothing.
- `SpeechRecognition` sends audio to Google. There is deliberately no "off"
  toggle; the disclosure is written out once. Do not add a toggle that silently
  falls back to cloud.
