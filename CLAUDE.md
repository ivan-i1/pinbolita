# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pinbolita is a pinball-like game built on the engine of **Bounce Fidget** (`hyper-casual-game`,
a private repo). It was bootstrapped by copying that engine's tracked files without history;
this repo is **public**, so nothing from the engine's gitignored files (credentials, notes) may
ever be committed here. The design loop lives in `ADV-REV-pinbolita-V*.md` in the primary
checkout (untracked).

## Commands

```bash
npm start           # Metro bundler / Expo dev server
npm run android     # build + install the native Android app
npm run web         # browser build
npm test            # jest (jest-expo preset) — covers game/physics.ts only
npm run typecheck   # tsc --noEmit, strict
npm run sounds      # regenerate assets/*.wav (deterministic; a re-run should show no diff)
npx expo export --platform android   # proves Metro resolves and bundles everything
```

There is **no linter**. The automated gates are `npm test` and `npm run typecheck`, and they
only reach the pure maths. Touch, audio, rendering and game feel have no test coverage and must
be verified on a device or emulator. Say what you actually ran.

## The game (deliverables 1a + 1b + 1c)

- The app opens on a **start menu**: Game, Creative, Options, Debug. Its background is the
  portrait art (`assets/menu-background.jpg`) under a scrim: Android 12+ draws the native
  splash only as a small circle-cropped icon (`assets/splash-icon.png` on `#1c2428`), so the
  full-screen art lives on the first screen instead. In game, pulling the top bar
  down pauses and offers Resume, Options, Debug, Menu. Game and Creative are **independent
  modes**; Game plays an empty table (ADV-REV Q32, default — only Test plays the layout). Menu
  on the bar and the Creative strip is beyond the spec's lists: without it, there was no way
  between the two modes.
- **Creative** (`mode === 'creative'`): no ball, no physics, play bands off. A right-side tool
  strip (`STRIP_WIDTH`) holds the current part, Parts, Debug, Test, Menu. On the table, a tap
  places a bumper of the selected power in the grid cell under the finger (`GRID_CELLS` = 8 across,
  centres only) or removes the bumper already there; a vertical drag scrolls the view. A ghost
  cell shows the outcome while the finger is down (place / remove / blocked). The spawn row and
  the lane band are no-build (`canPlace`). Parts picks the power of new bumpers (×0.5–×2) and
  can clear the table (behind a confirm).
- **Test** plays the layout and hands back to Creative on **pause** (top-band drag) or **loss**
  (ADV-REV Q16). `activeBumpers` is what physics collides with: the layout in Test, nothing in
  Game.
- **Bumpers** (`collideCircle`): push out, reflect the inward normal velocity, then add
  `BUMPER_KICK × power` outward; a hit flashes the rim. Movement is split into substeps no longer
  than half the ball's radius (`substepCount`, at most 8) so the ball cannot tunnel through a
  bumper, and the speed cap is re-applied after each kick.
- **The layout persists** under `@pinbolita:layout` in table-width units
  (`serializeLayout` / `parseLayout`: versioned, unknown part types skipped for later
  deliverables, malformed bumpers dropped, the rest clamped onto the table). A blob that is not
  a layout at all is copied to `@pinbolita:layout:corrupt` rather than overwritten.
- **Options is cosmetic only** (sound, vibration, colours, pitch, volumes); **Debug is every
  value that changes play** (pull, lanes, cooldown, viscosity, bounciness, friction, touch-band
  overlay) plus the renderer-spike tools. All settings persist (`@pinbolita:settings`,
  restored through `mergeSettings`, which trusts nothing it reads).
- The table is **one screen wide and `TABLE_ASPECT` (4) widths tall**. A camera follows the ball
  down it and pins at the bottom, which is what puts the lanes at the bottom of the screen
  exactly when the ball can reach them. Continue pans the view back up to the spawn before play
  resumes.
- A small ball falls under a constant **pull** (`settings.pull`). There is **no accelerometer**:
  no tilt, no shake, no `expo-sensors`.
- The table has side and top walls and an **open bottom**. A ball that falls through raises
  "You lost!" with a Continue button, which respawns it top-centre at rest.
- **Lanes are the flippers, and their band is viscous.** The bottom `LANE_DEPTH` of the table
  holds `settings.laneCount` (1–4) equal lanes; each gets `laneCooldownMs(base, count)` — more
  lanes, shorter cooldowns. Once 35% of the ball's area is inside the band (`catchFraction`) the
  ball is "in" its lane — chosen by the ball's centre (`laneOf`), never by the finger. Inside,
  velocity retention drops to `settings.viscosity` (ready lane, ~2.5 s to sink through) or
  `COOLING_RETENTION` (cooling lane, thinner) while the pull keeps acting: the ball **sinks
  slowly and drains if ignored**. Nothing freezes it automatically.
- **A falling ball is capped to `LANE_ENTRY_SPEED` as it enters a band** (`bandEntryVelocity`).
  On the tall table it arrives near `MAX_SPEED`, and the viscosity needs ~v·r/(1−r) of travel to
  absorb that — more than the band — so without the cap it punched straight through and drained
  with no grace (seen on the emulator). Only downward entries are capped; launches keep power.
- **Starting a swipe in the bottom band stops the ball** (`tryStopBall`), if its lane is ready —
  or in the last `LENIENCY_MS` (500 ms) of its cooldown (`canSwipeCatch`). A drag that reaches a
  sinking ball mid-swipe stops it too, and the shot is measured from that moment (`aimFrom`).
  While stopped, an arrow from the ball previews the launch (`launchArrow`: length = capped
  launch speed). Release launches with `swipeLaunch` in **any** direction, the drain included;
  that lane then cools down on its own timer. A drag under 20 px just lets the ball sink on.
  The stop lasts as long as the finger stays down — harmless while there is no score.
- Lane visuals (`laneVisual`): holding = green with ▲; cooldown = dark gray easing to dark
  yellow (`mixColor`) with a rising fill; standby = bright yellow, an obvious jump. Brightness
  and the fill/glyph carry the state too — colour alone fails WCAG 1.4.1.

### Touch bands

One root `PanResponder` routes by where a touch **starts** (`bandOf`):

| Band | Share | Does |
|---|---|---|
| top | 15% | vertical drag pulls the control bar down (**pauses**) or back up (resumes) |
| middle | rest | **taps only**: `impulseAwayFrom` is *added* to velocity (a nudge); drags do nothing |
| bottom | 22% | touch-down stops a ball sinking through a lane; release launches it (`swipeLaunch`) |
| none | bottom 48 px | refused — Android's home-gesture strip, which no app can exclude |

Only a bottom-band touch on a ball already in a catchable lane stops it; a middle-band touch
never does. The engine's catch-anywhere hold was removed because with an open drain it made the
game unlosable. Middle taps nudge the ball even while it sinks through a lane (juggling is
intended). The debug switch "Show touch bands" tints the bands
red/green/blue (and the refused strip black).

## Architecture

- **`game/physics.ts`** — pure functions, **no imports**. Every decision that can be expressed as
  maths lives here so it can be tested: `stepBall`, `catchFraction`, `laneOf`, the lane state
  functions (`laneAfterLaunch`, `laneTick`, `canSwipeCatch`, `laneRetention`, `laneVisual`),
  `mixColor`, `launchArrow`, `bandOf`, `hasFallenOut`, `bandEntryVelocity`, the camera
  (`cameraTarget`, `stepCamera`, `screenToWorld`, `panProgress`), `laneCooldownMs`,
  `mergeSettings`, `substepCount`, `collideCircle`, the build grid (`cellOf`, `cellCenter`,
  `canPlace`), `serializeLayout`, `parseLayout`, plus the engine's `frameScale`,
  `impulseAwayFrom`, `capSpeed`, `impactGain`, `pickVariant`, `nextHue`, `frictionRetention`,
  `swipeLaunch`. New rules go here first, test-first.
- **`App.tsx`** — everything that touches a device: `GameSystem` (the frame loop), the renderers,
  the band router, the options UI, audio and persistence.

### Module-scope mutable state is deliberate

`settings`, `pendingImpulse`, `lanes`, `gameLost`, `camera`, `respawnPan`, `mode`, `layout`, `activeBumpers` and the audio banks are module-level
singletons, not React state, because the frame loop and the touch responder run outside React's
render cycle and need synchronous reads. Consequence: a **required dual write** — `updateSetting`
writes both the module `settings` object and React state. Add a setting and update only one and
the UI moves while the ball ignores it, or the reverse.

### The frame loop

`GameSystem` ticks lane cooldowns, moves the camera (respawn pan, or eased follow), returns early
while the ball is stopped, lost or waiting out the pan, drains `pendingImpulse`, calls `stepBall`
with the lane's viscous retention when the ball is in a band (friction otherwise), bounces off
side and top walls, caps the entry speed into a band, checks fall-out, then `publish`es lane
visuals, the arrow, the camera offset and the FPS estimate onto the entities.

- **Everything is scaled by `dtf`** (`frameScale`), because the loop runs at the display's
  refresh rate. `frameScale` returns exactly 1 at 60 Hz. Any new force must be `dtf`-scaled.
- **There is no rest clamp.** The engine zeroed speeds under 0.08 px/frame; under a weak
  constant pull that hung a respawned ball in mid-air forever (worse at 120 Hz). A test pins it.
- **Bounce order matters**: clamp position, fire feedback with the pre-reflection speed, then
  reflect and damp.
- **Tunnelling floor**: the worst single step is `MAX_SPEED × 2` (the dtf clamp), so the lane
  band must be deeper than that plus the ball's diameter (144 > 108 at 360 dp, and it scales).
  A `__DEV__` warning checks it.

### World units and the camera

Physics runs in **world dp**: x across the screen width, y down a table `WORLD_HEIGHT =
SCREEN_WIDTH × TABLE_ASPECT` tall. Every length and speed is written for a 360 dp table and
multiplied by `SCALE = SCREEN_WIDTH / 360` (ball size, `MAX_SPEED`, `TAP_IMPULSE`, the pull, lane
depth), so the same table plays the same in table-width units on any phone. Ratios are not
scaled (`SWIPE_GAIN`, retentions). Renderers draw at `toScreenY(worldY, camY) = TOP_INSET +
worldY − camY`; each world entity receives `camY` from `publish`. Taps are mapped back with
`screenToWorld`. Touch **bands** stay in screen space. Screen bounds are read once from
`Dimensions.get('window')`; `app.json` locks portrait.

### Renderer spike (ADV-REV Q9 / D1)

Debug → Renderer spike: **Show FPS** (EMA of frame time, top right) and **Stress views** (0–100
bumper-sized views re-rendered every frame, no collision). This is how to decide RN Views vs
Skia **on a physical phone**: the emulator renders in software and its numbers mean nothing.

### Sound bank

Five WAVs in `assets/` (3 bounce, 2 push) generated by `scripts/generate-sounds.mjs` with a
seeded RNG. Each variant has two `AudioPlayer` voices so hits overlap; `pickVariant` never
repeats the last variant; playback rate and volume are randomised with `shouldCorrectPitch =
false`, so pitch moves with rate.

> **`expo-audio`'s types lie about `playbackRate`**: it is declared assignable but the runtime
> object only has a getter, so assigning throws. Use `player.setPlaybackRate(rate)`. `volume`
> and `shouldCorrectPitch` are genuinely assignable. Verify against a running app, not the
> `.d.ts`; `tsc` and jest both pass a silent build.

Custom bounce/hit sounds are copied into `Paths.document` under fixed basenames and recorded in
AsyncStorage (`@pinbolita:bounce_sound`, `@pinbolita:hit_sound`), using the SDK 54 object-based
`expo-file-system` API (`File`, `Paths`). Settings persist separately under
`@pinbolita:settings` (see The game).

## Native project is generated, not committed

`/android` and `/ios` are gitignored; `android/` on disk is `expo prebuild` output. **`app.json`
is the source of truth for native config.**

`expo-audio`'s library manifest declares `RECORD_AUDIO` and a media-playback foreground service
although nothing here records or plays in the background. The plugin option alone does not
remove them, so `app.json` lists them in `blockedPermissions`; `expo prebuild` then emits
`tools:node="remove"` for each. Keep it that way — Play requires a declaration for
`FOREGROUND_SERVICE_MEDIA_PLAYBACK`.

## Release signing

Signing is injected by `plugins/withReleaseSigning.js` on every prebuild, reading
`credentials/keystore.properties` (gitignored). **This app has no release keystore yet.** Until
`credentials/` is created, release builds fall back to the debug key, which Play rejects. Verify
the signer before uploading:

```
apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
jarsigner -verify -verbose:summary -certs android/app/build/outputs/bundle/release/app-release.aab
```

The upload keystore, once created, is the app's permanent Play identity and cannot be recovered
if lost. It must be a **new** key (not Bounce Fidget's) and backed up off-machine with its
password.
