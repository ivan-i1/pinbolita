import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  ImageBackground,
  Modal,
  PanResponder,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { GameEngine } from 'react-native-game-engine';
import * as Haptics from 'expo-haptics';
import { createAudioPlayer, setAudioModeAsync, AudioPlayer } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import {
  bandEntryVelocity,
  bandOf,
  cameraTarget,
  canPlace,
  canSwipeCatch,
  capSpeed,
  cellCenter,
  cellOf,
  collideShape,
  partShape,
  PART_TYPES,
  cleanTableName,
  deleteTable,
  parseTables,
  saveTable,
  serializeTables,
  type SavedTable,
  parseLayout,
  serializeLayout,
  substepCount,
  type Part,
  type PartType,
  type Shape,
  catchFraction,
  frameScale,
  frictionRetention,
  hasFallenOut,
  impactGain,
  impulseAwayFrom,
  laneAfterLaunch,
  laneCooldownMs,
  laneOf,
  ballRetention,
  slowsEntry,
  laneTick,
  laneVisual,
  launchArrow,
  mergeSettings,
  mixColor,
  nextHue,
  panProgress,
  pickVariant,
  screenToWorld,
  stepBall,
  stepCamera,
  swipeLaunch,
  type Band,
  type Lane,
  type LaneVisual,
} from './game/physics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// The table is one screen wide and TABLE_ASPECT widths tall, so it has the same shape on
// every phone. Physics runs in dp, and every length and speed below is written for a
// 360 dp wide table and multiplied by SCALE: a phone twice as wide gets a ball twice as
// big moving twice as fast, which is the same game in table-width units.
const REFERENCE_WIDTH = 360;
const SCALE = SCREEN_WIDTH / REFERENCE_WIDTH;
const TABLE_ASPECT = 4;
const WORLD_HEIGHT = SCREEN_WIDTH * TABLE_ASPECT;

const BALL_SIZE = 28 * SCALE;
const RADIUS = BALL_SIZE / 2;

const DEFAULTS = {
  // Constant downward pull, dp/frame² at 60 Hz on a 360 dp table. The table's only
  // gravity: the accelerometer is not used at all.
  pull: 0.2,
  laneCount: 1, // 1–4 equal lanes across the bottom
  // Multiplier on the lane cooldown line (one lane 3 s … each of four 7 s).
  cooldownScale: 1,
  // Velocity kept per frame inside a ready lane: lower is thicker. 0.8 lets an ignored
  // ball sink through the lane band in roughly 2 s.
  viscosity: 0.8,
  bounciness: 0.7,
  // 0 = frictionless, 1 = grips hardest. See frictionRetention: this used to be the
  // retention factor itself, which made the slider run backwards.
  friction: 0.25,
  vibration: true,
  sound: true,
  basePitch: 1.0,
  colorOnBounce: false,
  bounceVolume: 1.0,
  hitVolume: 1.0,
  debugBands: false, // tint the top/middle/bottom touch bands red/green/blue
  // Renderer spike (ADV-REV Q9 / dark area D1): measure the frame rate.
  showFps: false,
};

// Choice rows rather than sliders: these only make sense at these exact values.
const LANE_COUNT_CHOICES = [1, 2, 3, 4];

// Every slider is divided into four, so each has step = (max - min) / 4 and the defaults
// above sit exactly on a stop.
const SLIDERS = {
  pull: { min: 0.1, max: 0.5 },
  cooldownScale: { min: 0.5, max: 1.5 },
  viscosity: { min: 0.7, max: 0.9 },
  bounciness: { min: 0.1, max: 1.3 }, // above 1 the ball gains energy on a bounce
  friction: { min: 0, max: 1 },
  basePitch: { min: 0.5, max: 1.5 },
  bounceVolume: { min: 0, max: 1 },
  hitVolume: { min: 0, max: 1 },
} as const;
const quarterStep = (k: keyof typeof SLIDERS) => (SLIDERS[k].max - SLIDERS[k].min) / 4;
// Ranges a persisted value is clamped back into on load (see mergeSettings).
const SETTING_RANGES = {
  ...SLIDERS,
  laneCount: { min: 1, max: 4 },
};
const SETTINGS_STORAGE_KEY = '@pinbolita:settings';

// Which settings each panel owns. Options is cosmetic only; Debug is every value that
// changes how the game plays (ADV-REV Q23).
const OPTION_KEYS = [
  'vibration',
  'sound',
  'basePitch',
  'colorOnBounce',
  'bounceVolume',
  'hitVolume',
] as const;
const DEBUG_KEYS = [
  'pull',
  'laneCount',
  'cooldownScale',
  'viscosity',
  'bounciness',
  'friction',
  'debugBands',
  'showFps',
] as const;

// Bounces below this impact speed don't fire feedback — keeps the ball quiet when it's resting against a wall.
const FEEDBACK_VELOCITY_THRESHOLD = 1.0;

const SOUND_STORAGE_KEY = '@pinbolita:bounce_sound';
const SOUND_FILE_BASENAME = 'bounce-sound';
const HIT_SOUND_STORAGE_KEY = '@pinbolita:hit_sound';
const HIT_SOUND_FILE_BASENAME = 'hit-sound';

// Input and feel. Starting values — expect to tune these against a real device.
const TAP_IMPULSE = 11 * SCALE; // tuned by hand on device — 9 read as slightly underpowered
const TAP_MIN_DISTANCE = 1; // closer than this and the tap has no usable direction
const MAX_SPEED = 40 * SCALE; // so repeated nudges and launches cannot fling the ball out of the world

// Sound variation.
const VOICES_PER_VARIANT = 2;
const RATE_MIN = 0.82;
const RATE_MAX = 1.22;
const VOLUME_JITTER = 0.15;
const LOUD_SPEED = 14 * SCALE; // impact speed that plays at full volume
const MIN_GAIN = 0.25;
// Applied every frame, so it stays small: 0.98 retention still sheds ~70% in a second.
const FRICTION_LOSS_AT_MAX = 0.02;
// Flick-to-launch. A drag no longer than MIN is a tap, not a swipe. The gain is a ratio
// (launch speed per dp of drag), so it is not scaled: a swipe across the same share of
// the screen launches at the same share of the table on any phone.
const SWIPE_MIN_DISTANCE = 20;
const SWIPE_GAIN = 0.09;

// Touch bands, by where a touch STARTS: top swipes open the bar and pause, middle taps
// nudge the ball, bottom swipes launch it out of a lane.
const TOP_BAND = 0.15;
const BOTTOM_BAND = 0.22;
// Android's home gesture owns the bottom 32 dp and no app can exclude it; a swipe
// starting inside it never reaches us. Refuse the strip outright, with some margin.
const BOTTOM_GESTURE_GUARD = 48;

// Lanes are the flippers. A lane's band is viscous: a ball in it keeps sinking slowly and
// drains if ignored. Starting a swipe stops it; releasing launches it in any direction;
// that lane then cools down on its own timer. They sit at the very bottom of the table.
const CATCH_FRACTION = 0.35; // share of the ball's area inside the band before it counts as in
const LANE_DEPTH = 0.4 * SCREEN_WIDTH;
const CATCH_EDGE_Y = WORLD_HEIGHT - LANE_DEPTH;
// The worst single step is MAX_SPEED × the dtf clamp of 2. A shallower band would let a
// stalled frame carry the ball straight over it. Everything here scales together, so
// this holds on every phone (144 > 108 at 360 dp); the check guards future edits.
if (__DEV__ && LANE_DEPTH <= MAX_SPEED * 2 + BALL_SIZE) {
  console.warn('[lanes] lane band is shallower than one worst-case step');
}

// Creative: bumpers sit on the centres of a GRID_CELLS-wide grid, in table-width units, so
// a layout fits any phone. Kick is the outward speed a bumper adds on contact, scaled by
// the bumper's power.
const GRID_CELLS = 8;
const BUMPER_RADIUS_TW = 0.05;
// A wall fills its whole cell, so walls in neighbouring cells join into one longer wall.
const WALL_HALF_TW = 0.5 / 8;
// Half-thickness of the /, \, X and + bars.
const BAR_HALF_TW = 0.014;
const BUMPER_KICK = 8 * SCALE;
const POWER_CHOICES = [0.5, 1, 1.5, 2];
const LAYOUT_STORAGE_KEY = '@pinbolita:layout';
// Named tables saved from Creative, and which of them the draft was loaded from or saved
// as (so Save offers that name again).
const TABLES_STORAGE_KEY = '@pinbolita:tables';
const DRAFT_META_STORAGE_KEY = '@pinbolita:draft-meta';
// Bumpers are small next to a stalled frame's 80 px step, so movement is split into
// pieces no longer than half the ball's radius, at most MAX_SUBSTEPS per frame.
const MAX_SUBSTEP = RADIUS * 0.5;
const MAX_SUBSTEPS = 8;
// The Creative tool strip down the right edge, where its buttons own every touch. While
// building it is put away, so all eight columns are reachable, and a bar along the bottom
// (above Android's gesture strip) holds the part and Done.
const STRIP_WIDTH = 76;
const BUILD_BAR_HEIGHT = 56;
const BUILD_BAR_BOTTOM = 52;
const BUMPER_FLASH_MS = 120;

// Camera: the view is the screen below the status bar, scrolling down the table. The
// ball is held ANCHOR of the way down the view, eased by FOLLOW per 60 Hz frame.
const VIEWPORT_HEIGHT = SCREEN_HEIGHT - (StatusBar.currentHeight ?? 0);
const CAMERA_ANCHOR = 0.45;
const CAMERA_FOLLOW = 0.15;
// After Continue, the view pans back up to the spawn point before play resumes.
const RESPAWN_PAN_MS = 900;
// Speed a falling ball is capped to as it enters a lane band. Without it a ball dropped from
// the top of the tall table arrives at MAX_SPEED and punches through the whole band (the
// viscosity needs ~v·r/(1−r) of travel to absorb it). 6 keeps an ignored ball in a ready
// lane for roughly 3 s.
const LANE_ENTRY_SPEED = 6 * SCALE;
// A swipe may stop the ball this long before its lane's cooldown ends.
const LENIENCY_MS = 500;
// Launch-arrow length per unit of launch speed: the cap draws a 160 dp arrow at 360 dp.
const ARROW_PX_PER_SPEED = 4;

// Lane colours. Each state also differs in brightness, and cooldown draws a rising fill
// with a ▲ marking "swipe now" — colour must not be the only cue (WCAG 1.4.1).
const LANE_HOLDING = '#2ecc71';
const LANE_COOL_FROM = '#3a3a3a';
const LANE_COOL_TO = '#6e6214';
const LANE_STANDBY = '#f2e45c';

// The status bar area belongs to the system; the view of the table starts below it.
const TOP_INSET = StatusBar.currentHeight ?? 0;
// World coordinates: the ball respawns top-centre of the table, at rest.
const SPAWN = { x: SCREEN_WIDTH / 2, y: RADIUS + 24 * SCALE };
const RATE_HARD_MIN = 0.25; // expo-audio rejects rates outside roughly this range
const RATE_HARD_MAX = 3.0;

// Ball colour. The hue only moves when colourOnBounce is on; the default pink is the
// seed so the first random hue is already visibly away from it.
const BALL_DEFAULT_COLOR = '#ff4081';
const TABLE_COLOR = '#2a2a2a';
const HUE_MIN_SEPARATION = 60;

// Swipe-down control bar. The playfield is otherwise bare, so a permanently visible
// grabber is the only affordance telling the player the gesture exists at all.
const BAR_HEIGHT = 108;
// The bar never hides completely: this much stays on screen so the grabber remains a
// visible affordance. Hiding it entirely leaves the gesture undiscoverable.
// 8 (grabber margin) + 5 (grabber) + slack. Must stay below the space under the button
// row, or the buttons peek below the top edge while the bar is "hidden".
const GRABBER_PEEK = 22;
const BAR_HIDDEN_Y = BAR_HEIGHT - GRABBER_PEEK;
const SWIPE_TRIGGER = 36; // px of travel on release that commits to show/hide
const SWIPE_CLAIM = 8; // px before a drag is treated as a swipe rather than a tap

const BOUNCE_SOURCES = [
  require('./assets/bounce-1.wav'),
  require('./assets/bounce-2.wav'),
  require('./assets/bounce-3.wav'),
];
const PUSH_SOURCES = [require('./assets/push-1.wav'), require('./assets/push-2.wav')];

type PersistedSound = { uri: string; name: string };

// Mutated by React state; read by the physics system every frame.
const settings = { ...DEFAULTS };

// Taps land here and are drained once per frame, ADDED to the ball's velocity: a nudge,
// never a stop. Touch events arrive outside the frame loop, so they are banked.
const pendingImpulse = { x: 0, y: 0 };

// Lane state and the loss flag live at module scope for the same reason as `settings`:
// the frame loop and the touch responder both need them synchronously.
const freshLanes = (): Lane[] =>
  Array.from({ length: settings.laneCount }, () => ({ phase: 'ready' as const, readyAt: 0 }));
let lanes: Lane[] = freshLanes();
let gameLost = false;
// The camera's top edge, in world dp. Every world renderer draws at
// TOP_INSET + worldY - camera.y.
const camera = { y: 0 };
// While set, the view is panning back to the spawn point after Continue and the ball
// waits there; play resumes when the pan lands.
let respawnPan: { startedAt: number; from: number } | null = null;
// Frame-rate estimate for the Debug FPS meter: an EMA of frame time.
let frameMsAvg = 1000 / 60;

// Which screen is up, mirrored from React state for the frame loop and the responder.
// Game and Creative are independent modes (ADV-REV Q16); Test plays the Creative layout
// and hands back to Creative on pause or loss.
type Mode = 'menu' | 'game' | 'creative' | 'test';
let mode: Mode = 'menu';
// The Creative layout, in table-width units, and the bumpers the ball actually hits:
// the layout during Test, nothing in Game (ADV-REV Q32, default: an empty table).
let layout: Part[] = [];
let activeBumpers: Part[] = [];
// Collision outlines of activeBumpers in px, rebuilt whenever the active table changes.
let activeShapes: Shape[] = [];
const shapeOf = (p: Part) =>
  partShape(p.type, p.x * SCREEN_WIDTH, p.y * SCREEN_WIDTH, p.r * SCREEN_WIDTH, BAR_HALF_TW * SCREEN_WIDTH);
const setActiveParts = (parts: Part[]) => {
  activeBumpers = parts;
  activeShapes = parts.map(shapeOf);
};
// When each bumper was last hit, for a brief flash.
const bumperHits: Record<string, number> = {};
// The cell a Creative touch would act on, shown while the finger is down.
const ghost = { visible: false, col: 0, row: 0, kind: 'place' as 'place' | 'remove' | 'blocked' };
let nextBumperId = 0;
// Set while a bottom-band swipe holds the ball still. `stopLane` launches it on release;
// `aimFrom` is the drag already made when the stop began, so the shot is measured from
// the moment the ball stopped, not from where the finger first landed.
let ballStopped = false;
let stopLane = -1;
const aimFrom = { dx: 0, dy: 0 };
// The launch preview, read by the arrow's renderer every frame.
const arrow = { visible: false, length: 0, angle: 0 };
let wasInBand = false;
// Registered by App so the frame loop, which runs outside React, can raise the overlay.
let notifyLost: (() => void) | null = null;

let bounceBank: AudioPlayer[] = [];
let pushBank: AudioPlayer[] = [];
let customBouncePlayer: AudioPlayer | null = null;
let customPushPlayer: AudioPlayer | null = null;
let ballHue = 340;
let ballColor = BALL_DEFAULT_COLOR;
let lastBounceVariant = -1;
let lastPushVariant = -1;
let voiceCursor = 0;

// Which lane the ball is in, and whether enough of it has entered the band to count.
const ballLane = (x: number, y: number) => ({
  k: laneOf(x, SCREEN_WIDTH, lanes.length),
  inBand: catchFraction(y, CATCH_EDGE_Y, RADIUS) >= CATCH_FRACTION,
});

// Stop the ball for a swipe, if its lane allows it right now. Returns whether it stopped.
const tryStopBall = (): boolean => {
  if (ballStopped || gameLost || respawnPan) return ballStopped;
  const box = gameEntities.box;
  const { k, inBand } = ballLane(box.position.x, box.position.y);
  if (!inBand || !canSwipeCatch(lanes[k], Date.now(), LENIENCY_MS)) return false;
  ballStopped = true;
  stopLane = k;
  return true;
};

const releaseStop = () => {
  ballStopped = false;
  stopLane = -1;
  arrow.visible = false;
};

const randomBetween = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

const createBank = (sources: number[]) => {
  const bank: AudioPlayer[] = [];
  for (const source of sources) {
    for (let voice = 0; voice < VOICES_PER_VARIANT; voice++) {
      const player = createAudioPlayer(source);
      // Let rate changes drag the pitch with them — that variation is the whole point.
      player.shouldCorrectPitch = false;
      bank.push(player);
    }
  }
  return bank;
};

// Read at play time rather than stored, because the physics loop moves faster than React
// state does. (The engine also raised the pitch with tilt; there is no tilt here.)
const currentPitch = () => settings.basePitch;

const playPlayer = (player: AudioPlayer, gain: number, pitch: number) => {
  try {
    // Must be setPlaybackRate(), not `player.playbackRate = x`. The type definitions
    // declare playbackRate as an assignable property, but the runtime object exposes
    // only a getter, so assigning throws — which typecheck and unit tests both miss.
    // The per-hit random variation still applies; base pitch multiplies it. Clamped because
    // an out-of-range rate throws, and a thrown rate means silence, not a wrong pitch.
    const rate = randomBetween(RATE_MIN, RATE_MAX) * pitch;
    player.setPlaybackRate(Math.max(RATE_HARD_MIN, Math.min(RATE_HARD_MAX, rate)));
    player.volume = Math.max(0, Math.min(1, gain * randomBetween(1 - VOLUME_JITTER, 1)));
    player.seekTo(0);
    player.play();
  } catch (err) {
    // A player can be mid-load or already released, and a dropped sound effect is not
    // worth taking the frame down for — but never swallow it silently. A quiet catch
    // here is exactly what hid the playbackRate bug above.
    if (__DEV__) console.warn('[sfx] play failed:', err);
  }
};

// Every variant owns VOICES_PER_VARIANT players, so back-to-back hits land on different
// instances and overlap instead of chopping each other off.
const playFromBank = (
  bank: AudioPlayer[],
  lastVariant: number,
  gain: number,
  pitch: number,
) => {
  if (bank.length === 0) return lastVariant;
  const variantCount = bank.length / VOICES_PER_VARIANT;
  const variant = pickVariant(variantCount, lastVariant, Math.random);
  // Rotate the voice rather than picking one at random, so two hits in quick succession
  // are guaranteed to be different player instances and can overlap.
  const voice = voiceCursor++ % VOICES_PER_VARIANT;
  playPlayer(bank[variant * VOICES_PER_VARIANT + voice], gain, pitch);
  return variant;
};

const playBounceSound = (gain: number) => {
  const pitch = currentPitch();
  gain *= settings.bounceVolume;
  // A sound the player loaded themselves replaces the bundled set, but still varies.
  if (customBouncePlayer) {
    playPlayer(customBouncePlayer, gain, pitch);
    return;
  }
  lastBounceVariant = playFromBank(bounceBank, lastBounceVariant, gain, pitch);
};

const playPushSound = () => {
  if (!settings.sound) return;
  const pitch = currentPitch();
  const gain = settings.hitVolume;
  if (customPushPlayer) {
    playPlayer(customPushPlayer, gain, pitch);
    return;
  }
  lastPushVariant = playFromBank(pushBank, lastPushVariant, gain, pitch);
};

const triggerBounceFeedback = (impactSpeed: number) => {
  if (impactSpeed < FEEDBACK_VELOCITY_THRESHOLD) return;
  if (settings.colorOnBounce) {
    ballHue = nextHue(ballHue, Math.random, HUE_MIN_SEPARATION);
    ballColor = `hsl(${ballHue.toFixed(0)}, 90%, 62%)`;
  }
  if (settings.vibration) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  if (settings.sound) playBounceSound(impactGain(impactSpeed, LOUD_SPEED, MIN_GAIN));
};

// Hand this frame's shared state to the renderers. Each renderer only sees its own
// entity, so the camera offset is copied onto every world-space entity.
const publish = (entities: any, now: number, here: { k: number; inBand: boolean }) => {
  const box = entities.box;
  const cooldownMs = laneCooldownMs(lanes.length, settings.cooldownScale);
  entities.lanes.visuals = lanes.map((lane, i) =>
    laneVisual(lane, now, cooldownMs, !gameLost && here.inBand && i === here.k),
  );
  entities.arrow.x = box.position.x;
  entities.arrow.y = box.position.y;
  entities.arrow.visible = arrow.visible;
  entities.arrow.length = arrow.length;
  entities.arrow.angle = arrow.angle;
  for (const key of ['guides', 'lanes', 'box', 'arrow', 'bumpers', 'grid']) {
    entities[key].camY = camera.y;
  }
  entities.hud.fps = settings.showFps ? 1000 / frameMsAvg : 0;
  box.color = settings.colorOnBounce ? ballColor : BALL_DEFAULT_COLOR;
  // Creative edits the layout with no ball; Test and Game play whatever is active.
  const editing = mode === 'creative';
  box.hidden = editing;
  entities.bumpers.items = editing ? layout : activeBumpers;
  entities.bumpers.hits = bumperHits;
  entities.bumpers.now = now;
  entities.grid.visible = editing;
  entities.grid.ghost = editing && ghost.visible ? { ...ghost } : null;
};

const GameSystem = (entities: any, { time }: any) => {
  const box = entities.box;
  const now = Date.now();

  // The loop is driven by requestAnimationFrame, so it ticks at the display's refresh
  // rate. Without this a 120Hz phone runs the ball twice as fast on the same numbers.
  const delta = time?.delta;
  const dtf = frameScale(delta);
  if (Number.isFinite(delta) && delta > 0) {
    frameMsAvg += (Math.min(delta, 250) - frameMsAvg) * 0.05;
  }

  // Cooldowns run on the wall clock, so a lane recovers even while the ball is elsewhere.
  lanes = lanes.map((lane) => laneTick(lane, now));

  // Creative: no ball, no physics. The camera is scrolled by hand; just draw.
  if (mode === 'creative') {
    publish(entities, now, { k: 0, inBand: false });
    return entities;
  }

  // Camera: pan back up after Continue, otherwise follow the ball down the table. It holds
  // still while the loss overlay is up.
  if (respawnPan) {
    const p = panProgress(now - respawnPan.startedAt, RESPAWN_PAN_MS);
    camera.y = respawnPan.from * (1 - p);
    if (p >= 1) respawnPan = null;
  } else if (!gameLost) {
    const target = cameraTarget(box.position.y, VIEWPORT_HEIGHT, WORLD_HEIGHT, CAMERA_ANCHOR);
    camera.y = stepCamera(camera.y, target, dtf, CAMERA_FOLLOW);
  }

  const here = ballLane(box.position.x, box.position.y);

  // Lost, panning back to the spawn, or held still by a swipe in progress: no pull, no
  // nudges until play resumes.
  if (gameLost || ballStopped || respawnPan) {
    box.velocity.x = 0;
    box.velocity.y = 0;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    publish(entities, now, here);
    return entities;
  }

  // Whatever the tap handler banked since the last frame.
  box.velocity.x += pendingImpulse.x;
  box.velocity.y += pendingImpulse.y;
  pendingImpulse.x = 0;
  pendingImpulse.y = 0;

  // Inside a ready lane's band the air turns to syrup: the pull keeps acting, so the ball
  // sinks at a slow terminal speed instead of stopping — and drains if the player does
  // nothing. A cooling lane is disabled: open air, the ball falls straight through.
  const retention = ballRetention(
    here.inBand,
    lanes[here.k],
    settings.viscosity,
    frictionRetention(settings.friction, FRICTION_LOSS_AT_MAX),
  );
  // Integrate in pieces short enough that the ball cannot skip over a bumper, colliding
  // after each one. Splitting dtf is exact for the pull and the damping (r^(dtf/n))^n.
  let next = { x: box.position.x, y: box.position.y, vx: box.velocity.x, vy: box.velocity.y };
  const pieces = substepCount(Math.hypot(next.vx, next.vy) * dtf, MAX_SUBSTEP, MAX_SUBSTEPS);
  for (let s = 0; s < pieces; s++) {
    next = stepBall(next, settings.pull * SCALE, dtf / pieces, retention, MAX_SPEED);
    for (let i = 0; i < activeBumpers.length; i++) {
      const bumper = activeBumpers[i];
      // Bumpers of every shape kick; a wall only bounces, like the table's own walls.
      const wall = bumper.type === 'wall';
      const contact = collideShape(
        next,
        activeShapes[i],
        RADIUS,
        wall ? 0 : BUMPER_KICK * bumper.power,
        wall ? settings.bounciness : 1,
      );
      if (!contact.hit) continue;
      next = contact.ball;
      if (contact.impact > 0) {
        bumperHits[bumper.id] = now;
        triggerBounceFeedback(contact.impact);
      }
    }
    // A kick can push past the cap; the cap holds everywhere.
    const capped = capSpeed(next.vx, next.vy, MAX_SPEED);
    next.vx = capped.x;
    next.vy = capped.y;
  }
  box.position.x = next.x;
  box.position.y = next.y;
  box.velocity.x = next.vx;
  box.velocity.y = next.vy;

  if (box.position.x < RADIUS) {
    box.position.x = RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.x));
    box.velocity.x = -box.velocity.x * settings.bounciness;
  } else if (box.position.x > SCREEN_WIDTH - RADIUS) {
    box.position.x = SCREEN_WIDTH - RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.x));
    box.velocity.x = -box.velocity.x * settings.bounciness;
  }

  // Top wall only — the top of the table, not of the screen. The bottom is open, which is
  // how the ball is lost.
  if (box.position.y < RADIUS) {
    box.position.y = RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.y));
    box.velocity.y = -box.velocity.y * settings.bounciness;
  }

  // A light tick as the ball sinks into a lane that can take a swipe. The lane is chosen by
  // the ball's centre, never by where the player's finger is.
  const after = ballLane(box.position.x, box.position.y);
  const entering = after.inBand && !wasInBand;
  // A ball falling in from high up the table arrives near the speed cap, faster than the
  // band can absorb; a ready lane caps it on the way in so it sinks instead of punching
  // through. A cooling lane lets it fall.
  const entry = bandEntryVelocity(
    box.velocity.x,
    box.velocity.y,
    slowsEntry(entering, lanes[after.k]),
    LANE_ENTRY_SPEED,
  );
  box.velocity.x = entry.x;
  box.velocity.y = entry.y;
  if (entering && lanes[after.k].phase === 'ready' && settings.vibration) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
  wasInBand = after.inBand;

  if (hasFallenOut(box.position.y, RADIUS, WORLD_HEIGHT)) {
    gameLost = true;
    notifyLost?.();
  }

  publish(entities, now, after);
  return entities;
};

// World y → screen y for the current camera.
const toScreenY = (worldY: number, camY: number) => TOP_INSET + worldY - camY;

// The lane strip along the bottom of the table.
//   holding  — green, ▲: the ball is sinking here and a swipe will stop and launch it
//   cooldown — dark gray easing toward dark yellow, with a fill rising as it recovers
//   standby  — bright yellow: an obvious jump, so the moment a lane is back is unmissable
const laneColor = ({ kind, progress }: LaneVisual) => {
  if (kind === 'holding') return LANE_HOLDING;
  if (kind === 'standby') return LANE_STANDBY;
  return mixColor(LANE_COOL_FROM, LANE_COOL_TO, progress);
};

const LaneStrip = ({ visuals, camY }: { visuals: LaneVisual[]; camY: number }) => (
  <View style={[styles.laneStrip, { top: toScreenY(CATCH_EDGE_Y, camY ?? 0) }]} pointerEvents="none">
    {visuals.map((visual, i) => (
      <View
        key={i}
        style={[styles.lane, { backgroundColor: laneColor(visual) }, i > 0 && styles.laneDivider]}
      >
        {visual.kind === 'cooldown' && (
          <View style={[styles.laneFill, { height: `${visual.progress * 100}%` }]} />
        )}
        {visual.kind === 'holding' && <Text style={styles.laneGlyph}>▲</Text>}
      </View>
    ))}
  </View>
);

// Faint lines across the table every table-width, plus its top edge, so that scrolling
// down an otherwise empty table is visible at all.
const TableGuides = ({ camY }: { camY: number }) => (
  <View style={StyleSheet.absoluteFill} pointerEvents="none">
    {Array.from({ length: TABLE_ASPECT }, (_, i) => (
      <View
        key={i}
        style={[
          styles.guide,
          i === 0 && styles.guideTop,
          { top: toScreenY(i * SCREEN_WIDTH, camY ?? 0) },
        ]}
      />
    ))}
  </View>
);

// The launch preview: a shaft from the ball's centre along the shot, with a head at the
// tip. Its length is the launch speed, so it stops growing at the cap.
const HEAD_HALF = 7; // half the arrowhead square's side
const LaunchArrow = ({ visible, x, y: worldY, length, angle, camY }: any) => {
  if (!visible) return null;
  const y = toScreenY(worldY, camY ?? 0);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View
        style={[
          styles.arrowShaft,
          {
            left: x + (cos * length) / 2 - length / 2,
            top: y + (sin * length) / 2 - 2,
            width: length,
            transform: [{ rotate: `${angle}rad` }],
          },
        ]}
      />
      {/*
        The head is a square showing two borders, rotated so that corner points along the
        shot. That corner sits HEAD_HALF·√2 from the square's centre, so the centre is set
        back by that much from the tip for the point to land exactly on it.
      */}
      <View
        style={[
          styles.arrowHead,
          {
            left: x + cos * (length - HEAD_HALF * Math.SQRT2) - HEAD_HALF,
            top: y + sin * (length - HEAD_HALF * Math.SQRT2) - HEAD_HALF,
            transform: [{ rotate: `${angle + Math.PI / 4}rad` }],
          },
        ]}
      />
    </View>
  );
};

// One part, drawn in a 2h × 2h box. The bars of /, \, X and + stop inside the round
// bumper's circle, like their collision outlines (partShape). Bumpers are purple, brighter
// with power; walls are stone grey.
const bumperColor = (power: number) => mixColor('#5b2a86', '#c77dff', (power - 0.5) / 1.5);
const WALL_COLOR = '#6b7280';
const PartGlyph = ({
  type,
  h,
  power,
  flashing = false,
  label = false,
}: {
  type: PartType;
  h: number;
  power: number;
  flashing?: boolean;
  label?: boolean;
}) => {
  const color = type === 'wall' ? WALL_COLOR : bumperColor(power);
  const rim = flashing ? styles.partFlash : null;
  const bar = Math.max(3, (BAR_HALF_TW / BUMPER_RADIUS_TW) * h * 2);
  const bars: number[] =
    type === 'slash' ? [-45] : type === 'backslash' ? [45] : type === 'x' ? [45, -45] : type === 'plus' ? [0, 90] : [];
  return (
    <View style={{ width: 2 * h, height: 2 * h, alignItems: 'center', justifyContent: 'center' }}>
      {type === 'bumper' && (
        <View
          style={[styles.partBody, { width: 2 * h, height: 2 * h, borderRadius: h, backgroundColor: color }, rim]}
        >
          {label && <Text style={styles.bumperLabel}>×{power}</Text>}
        </View>
      )}
      {bars.map((deg) => (
        <View
          key={deg}
          style={[
            styles.partBody,
            {
              position: 'absolute',
              width: 2 * h,
              height: bar,
              borderRadius: bar / 2,
              backgroundColor: color,
              transform: [{ rotate: `${deg}deg` }],
            },
            rim,
          ]}
        />
      ))}
      {type === 'diamond' && (
        <View
          style={[
            styles.partBody,
            {
              width: h * Math.SQRT2,
              height: h * Math.SQRT2,
              backgroundColor: color,
              transform: [{ rotate: '45deg' }],
            },
            rim,
          ]}
        />
      )}
      {type === 'wall' && (
        <View style={[styles.partBody, styles.wall, { width: 2 * h, height: 2 * h }, rim]} />
      )}
    </View>
  );
};

// Parts, in table-width units, drawn at their place on the table. A hit flashes the rim.
const BumperField = ({
  items,
  hits,
  now,
  camY,
}: {
  items: Part[];
  hits: Record<string, number>;
  now: number;
  camY: number;
}) => (
  <View style={StyleSheet.absoluteFill} pointerEvents="none">
    {(items ?? []).map((b) => {
      const h = b.r * SCREEN_WIDTH;
      return (
        <View
          key={b.id}
          style={{
            position: 'absolute',
            left: b.x * SCREEN_WIDTH - h,
            top: toScreenY(b.y * SCREEN_WIDTH, camY ?? 0) - h,
          }}
        >
          <PartGlyph
            type={b.type}
            h={h}
            power={b.power}
            flashing={now - (hits?.[b.id] ?? -Infinity) < BUMPER_FLASH_MS}
            label
          />
        </View>
      );
    })}
  </View>
);

// Creative's build grid: cell lines, the no-build zones shaded (the spawn row and the lane
// band), and the cell under the finger — green to place, orange to remove, red if blocked.
const GRID_ROWS = TABLE_ASPECT * GRID_CELLS;
const CELL = SCREEN_WIDTH / GRID_CELLS;
const GHOST_COLORS = {
  place: 'rgba(46,204,113,0.45)',
  remove: 'rgba(255,152,0,0.5)',
  blocked: 'rgba(231,76,60,0.45)',
};
const BuildGrid = ({
  visible,
  camY,
  ghost: g,
}: {
  visible: boolean;
  camY: number;
  ghost: typeof ghost | null;
}) => {
  if (!visible) return null;
  const cam = camY ?? 0;
  const firstRow = Math.max(0, Math.floor(cam / CELL));
  const lastRow = Math.min(GRID_ROWS, Math.ceil((cam + VIEWPORT_HEIGHT) / CELL));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.noBuild, { top: toScreenY(0, cam), height: CELL }]} />
      <View
        style={[styles.noBuild, { top: toScreenY(CATCH_EDGE_Y, cam), height: LANE_DEPTH }]}
      />
      {Array.from({ length: GRID_CELLS + 1 }, (_, i) => (
        <View key={`c${i}`} style={[styles.gridCol, { left: i * CELL }]} />
      ))}
      {Array.from({ length: lastRow - firstRow + 1 }, (_, i) => (
        <View
          key={`r${firstRow + i}`}
          style={[styles.gridRow, { top: toScreenY((firstRow + i) * CELL, cam) }]}
        />
      ))}
      {g && (
        <View
          style={[
            styles.ghost,
            {
              left: g.col * CELL,
              top: toScreenY(g.row * CELL, cam),
              width: CELL,
              height: CELL,
              backgroundColor: GHOST_COLORS[g.kind],
            },
          ]}
        />
      )}
    </View>
  );
};

const Box = ({ position, size, color, camY, hidden }: any) => {
  if (hidden) return null;
  return (
    <View
      style={{
        position: 'absolute',
        left: position.x - size[0] / 2,
        top: toScreenY(position.y, camY ?? 0) - size[1] / 2,
        width: size[0],
        height: size[1],
        backgroundColor: color ?? BALL_DEFAULT_COLOR,
        borderRadius: size[0] / 2,
      }}
    />
  );
};

// Debug FPS readout, in screen space just under the pause bar's grabber.
const Hud = ({ fps }: { fps: number }) =>
  fps ? <Text style={styles.hud}>{fps.toFixed(0)} fps</Text> : null;

// Built once, deliberately. GameEngine reads entities only at mount, and the root touch
// responder needs a stable handle on the ball to work out which way "away from the tap"
// is. Draw order follows key order: guides at the back, then the lanes,
// the bumpers, the build grid, the ball, the arrow, and the HUD on top.
const gameEntities = {
  guides: { camY: 0, renderer: <TableGuides camY={0} /> },
  lanes: {
    visuals: lanes.map((lane) => laneVisual(lane, 0, 0, false)),
    camY: 0,
    renderer: <LaneStrip visuals={[]} camY={0} />,
  },
  bumpers: {
    items: [] as Part[],
    hits: bumperHits,
    now: 0,
    camY: 0,
    renderer: <BumperField items={[]} hits={{}} now={0} camY={0} />,
  },
  grid: {
    visible: false,
    camY: 0,
    ghost: null as typeof ghost | null,
    renderer: <BuildGrid visible={false} camY={0} ghost={null} />,
  },
  box: {
    hidden: false,
    position: { x: SPAWN.x, y: SPAWN.y },
    velocity: { x: 0, y: 0 },
    size: [BALL_SIZE, BALL_SIZE],
    color: BALL_DEFAULT_COLOR,
    camY: 0,
    renderer: <Box />,
  },
  arrow: {
    visible: false,
    x: 0,
    y: 0,
    length: 0,
    angle: 0,
    camY: 0,
    renderer: <LaunchArrow />,
  },
  hud: { fps: 0, renderer: <Hud fps={0} /> },
};

// ---- Creative editing -------------------------------------------------------------
// Touches on the table while editing: a vertical drag scrolls the view (ADV-REV Q16,
// manual scroll); a tap places a bumper of the selected power in the cell under the
// finger, or removes the one already there. The ghost shows the outcome while the finger
// is down. Saved shortly after each change.

let partPower = 1;
let partType: PartType = 'bumper';
const halfSizeOf = (type: PartType) => (type === 'wall' ? WALL_HALF_TW : BUMPER_RADIUS_TW);
const edit = { startCamera: 0, scrolling: false };
// Creative has two states. Off, the tool strip is up and a drag only scrolls. On (Build),
// the strip is away, every cell is reachable, and a tap places or removes a part.
let building = false;
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
let tables: SavedTable[] = [];
let draftName: string | null = null;

const persistTables = () =>
  AsyncStorage.setItem(
    TABLES_STORAGE_KEY,
    JSON.stringify(serializeTables(tables, TABLE_ASPECT, GRID_CELLS)),
  ).catch(() => {});
const persistDraftMeta = () =>
  AsyncStorage.setItem(DRAFT_META_STORAGE_KEY, JSON.stringify({ name: draftName })).catch(() => {});
const newTableId = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const saveLayout = () => {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    const json = JSON.stringify(serializeLayout(layout, TABLE_ASPECT, GRID_CELLS));
    AsyncStorage.setItem(LAYOUT_STORAGE_KEY, json).catch(() => {});
  }, 400);
};

// The bumper occupying a cell, if any.
const bumperAt = (col: number, row: number) => {
  const c = cellCenter(col, row, GRID_CELLS);
  return layout.find((b) => Math.hypot(b.x - c.x, b.y - c.y) < b.r);
};

const aimGhost = (pageX: number, pageY: number) => {
  const p = screenToWorld(pageX, pageY, camera.y, TOP_INSET);
  const { col, row } = cellOf(p.x / SCREEN_WIDTH, p.y / SCREEN_WIDTH, GRID_CELLS);
  ghost.col = col;
  ghost.row = row;
  ghost.kind = bumperAt(col, row)
    ? 'remove'
    : canPlace(col, row, layout, GRID_CELLS, TABLE_ASPECT, LANE_DEPTH / SCREEN_WIDTH, halfSizeOf(partType))
      ? 'place'
      : 'blocked';
  ghost.visible = true;
};

const beginEdit = (pageX: number, pageY: number) => {
  edit.startCamera = camera.y;
  edit.scrolling = false;
  if (building) aimGhost(pageX, pageY);
};

const moveEdit = (dy: number) => {
  if (!edit.scrolling && Math.abs(dy) <= SWIPE_CLAIM) return;
  edit.scrolling = true;
  ghost.visible = false;
  camera.y = Math.max(0, Math.min(WORLD_HEIGHT - VIEWPORT_HEIGHT, edit.startCamera - dy));
};

const endEdit = () => {
  const { col, row, kind, visible } = ghost;
  ghost.visible = false;
  if (!building || edit.scrolling || !visible) return;
  if (kind === 'remove') {
    const target = bumperAt(col, row);
    layout = layout.filter((b) => b !== target);
  } else if (kind === 'place') {
    const c = cellCenter(col, row, GRID_CELLS);
    layout = [
      ...layout,
      {
        id: `b${Date.now().toString(36)}${nextBumperId++}`,
        type: partType,
        x: c.x,
        y: c.y,
        r: halfSizeOf(partType),
        power: partType === 'wall' ? 1 : partPower,
      },
    ];
  } else {
    return;
  }
  if (settings.vibration) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  saveLayout();
};

type SettingsState = typeof DEFAULTS;

const OptionsMenu = ({
  visible,
  onClose,
  state,
  onChange,
  onReset,
  onOpenSounds,
}: {
  visible: boolean;
  onClose: () => void;
  state: SettingsState;
  onChange: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  onReset: () => void;
  onOpenSounds: () => void;
}) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Options</Text>
        <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Vibration</Text>
          <Switch value={state.vibration} onValueChange={(v) => onChange('vibration', v)} />
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Sound</Text>
          <Switch value={state.sound} onValueChange={(v) => onChange('sound', v)} />
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Colour on bounce</Text>
          <Switch
            value={state.colorOnBounce}
            onValueChange={(v) => onChange('colorOnBounce', v)}
          />
        </View>

        <TouchableOpacity style={styles.subMenuRow} onPress={onOpenSounds}>
          <Text style={styles.rowLabel}>Sounds</Text>
          <Text style={styles.subMenuChevron}>›</Text>
        </TouchableOpacity>

        <View style={styles.sliderBlock}>
          <Text style={styles.rowLabel}>Base pitch: {state.basePitch.toFixed(2)}</Text>
          <Slider
            minimumValue={SLIDERS.basePitch.min}
            maximumValue={SLIDERS.basePitch.max}
            step={quarterStep('basePitch')}
            value={state.basePitch}
            onValueChange={(v) => onChange('basePitch', v)}
            minimumTrackTintColor="#03dac6"
            maximumTrackTintColor="#444"
            thumbTintColor="#03dac6"
          />
        </View>
        </ScrollView>

        <View style={styles.modalActions}>
          <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={onReset}>
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>
);

type Change = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
type SliderKey = keyof typeof SLIDERS;

const SliderRow = ({
  label,
  k,
  state,
  onChange,
  format = (v: number) => v.toFixed(2),
}: {
  label: string;
  k: SliderKey;
  state: SettingsState;
  onChange: Change;
  format?: (v: number) => string;
}) => (
  <View style={styles.sliderBlock}>
    <Text style={styles.rowLabel}>
      {label}: {format(state[k])}
    </Text>
    <Slider
      minimumValue={SLIDERS[k].min}
      maximumValue={SLIDERS[k].max}
      step={quarterStep(k)}
      value={state[k]}
      onValueChange={(v) => onChange(k, v)}
      minimumTrackTintColor="#03dac6"
      maximumTrackTintColor="#444"
      thumbTintColor="#03dac6"
    />
  </View>
);

// A row of exact choices, for values a slider would only ever land between.
const ChoiceRow = ({
  label,
  choices,
  value,
  onPick,
}: {
  label: string;
  choices: number[];
  value: number;
  onPick: (v: number) => void;
}) => (
  <View style={styles.sliderBlock}>
    <Text style={styles.rowLabel}>{label}</Text>
    <View style={styles.choiceRow}>
      {choices.map((c) => (
        <TouchableOpacity
          key={c}
          style={[styles.choice, c === value && styles.choiceOn]}
          onPress={() => onPick(c)}
          accessibilityState={{ selected: c === value }}
        >
          <Text style={[styles.choiceText, c === value && styles.choiceTextOn]}>{c}</Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

// Every value that changes how the game plays (ADV-REV Q23). Options stays cosmetic.
const DebugMenu = ({
  visible,
  onClose,
  state,
  onChange,
  onReset,
}: {
  visible: boolean;
  onClose: () => void;
  state: SettingsState;
  onChange: Change;
  onReset: () => void;
}) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Debug</Text>
        <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>
          <SliderRow label="Pull" k="pull" state={state} onChange={onChange} />
          <ChoiceRow
            label="Lanes"
            choices={LANE_COUNT_CHOICES}
            value={state.laneCount}
            onPick={(v) => onChange('laneCount', v)}
          />
          <SliderRow
            label="Lane cooldown"
            k="cooldownScale"
            state={state}
            onChange={onChange}
            format={(v) =>
              `×${v.toFixed(2)} → ${(laneCooldownMs(state.laneCount, v) / 1000).toFixed(1)} s each`
            }
          />
          <SliderRow
            label="Lane viscosity (lower = thicker)"
            k="viscosity"
            state={state}
            onChange={onChange}
          />
          <SliderRow label="Bounciness" k="bounciness" state={state} onChange={onChange} />
          <SliderRow label="Friction" k="friction" state={state} onChange={onChange} />

          <View style={styles.row}>
            <Text style={styles.rowLabel}>Show touch bands</Text>
            <Switch value={state.debugBands} onValueChange={(v) => onChange('debugBands', v)} />
          </View>

          <Text style={styles.sectionLabel}>Renderer spike</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Show FPS</Text>
            <Switch value={state.showFps} onValueChange={(v) => onChange('showFps', v)} />
          </View>
        </ScrollView>

        <View style={styles.modalActions}>
          <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={onReset}>
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>
);


// Each sound gets its own file picker and its own volume, so a loud custom bounce can be
// tamed without turning the hit sound down with it.
// Creative's part picker: a shape, and for bumpers the power of new ones. Walls have no
// power — they bounce with the table's own bounciness.
const PART_LABELS: Record<PartType, string> = {
  bumper: 'Round',
  slash: '/',
  backslash: '\\',
  x: 'X',
  plus: '+',
  diamond: 'Rhombus',
  wall: 'Wall',
};
const PartsMenu = ({
  visible,
  onClose,
  type,
  onType,
  power,
  onPower,
  count,
  onClear,
}: {
  visible: boolean;
  onClose: () => void;
  type: PartType;
  onType: (t: PartType) => void;
  power: number;
  onPower: (p: number) => void;
  count: number;
  onClear: () => void;
}) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Parts</Text>
        <View style={styles.partGrid}>
          {PART_TYPES.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.partTile, t === type && styles.partTileOn]}
              onPress={() => onType(t)}
              accessibilityLabel={PART_LABELS[t]}
              accessibilityState={{ selected: t === type }}
            >
              <PartGlyph type={t} h={14} power={t === 'wall' ? 1 : power} />
              <Text style={styles.partTileText}>{PART_LABELS[t]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {type === 'wall' ? (
          <Text style={[styles.rowLabel, styles.muted, { marginTop: 12 }]}>
            Walls fill their cell and join their neighbours. They do not kick: the ball bounces
            off them like off the table's sides.
          </Text>
        ) : (
          <ChoiceRow
            label="Power of new bumpers (×)"
            choices={POWER_CHOICES}
            value={power}
            onPick={onPower}
          />
        )}
        <Text style={[styles.rowLabel, styles.muted, { marginTop: 12 }]}>
          {count} part{count === 1 ? '' : 's'} on the table.
        </Text>
        <View style={styles.modalActions}>
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton]}
            onPress={onClear}
            disabled={count === 0}
          >
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>Clear table</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>
);

// Creative's table library: save the table being edited under a name, load or delete a
// saved one, or start a new one. Saving under a name that exists asks before overwriting.
const TablesMenu = ({
  visible,
  onClose,
  list,
  currentName,
  partCount,
  onSave,
  onLoad,
  onDelete,
  onNew,
}: {
  visible: boolean;
  onClose: () => void;
  list: SavedTable[];
  currentName: string | null;
  partCount: number;
  onSave: (name: string) => void;
  onLoad: (t: SavedTable) => void;
  onDelete: (t: SavedTable) => void;
  onNew: () => void;
}) => {
  const [name, setName] = useState(currentName ?? '');
  useEffect(() => {
    if (visible) setName(currentName ?? '');
  }, [visible, currentName]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Tables</Text>
          <Text style={[styles.rowLabel, styles.muted]}>
            Editing: {currentName ?? 'unsaved table'} · {partCount} part{partCount === 1 ? '' : 's'}
          </Text>
          <View style={styles.saveRow}>
            <TextInput
              style={styles.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="Table name"
              placeholderTextColor="#777"
              maxLength={24}
              returnKeyType="done"
              onSubmitEditing={() => onSave(name)}
            />
            <TouchableOpacity style={[styles.button, styles.smallButton]} onPress={() => onSave(name)}>
              <Text style={styles.buttonText}>Save</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sectionLabel}>Saved</Text>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>
            {list.length === 0 && (
              <Text style={[styles.rowLabel, styles.muted]}>No saved tables yet.</Text>
            )}
            {list.map((t) => (
              <View key={t.id} style={styles.tableRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel} numberOfLines={1}>{t.name}</Text>
                  <Text style={[styles.tableMeta, styles.muted]}>
                    {t.items.length} part{t.items.length === 1 ? '' : 's'}
                    {t.background ? ' · background' : ''}
                  </Text>
                </View>
                <TouchableOpacity style={[styles.button, styles.smallButton]} onPress={() => onLoad(t)}>
                  <Text style={styles.buttonText}>Load</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.smallButton, styles.secondaryButton]}
                  onPress={() => onDelete(t)}
                  accessibilityLabel={`Delete ${t.name}`}
                >
                  <Text style={[styles.buttonText, styles.secondaryButtonText]}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={onNew}>
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>New table</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={onClose}>
              <Text style={styles.buttonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// Game: which table to play — an empty one, or any table saved from Creative.
const GamePicker = ({
  visible,
  onClose,
  list,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  list: SavedTable[];
  onPick: (t: SavedTable | null) => void;
}) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Play which table?</Text>
        <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>
          <TouchableOpacity style={styles.pickRow} onPress={() => onPick(null)}>
            <Text style={styles.rowLabel}>Empty table</Text>
            <Text style={styles.subMenuChevron}>›</Text>
          </TouchableOpacity>
          {list.map((t) => (
            <TouchableOpacity key={t.id} style={styles.pickRow} onPress={() => onPick(t)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel} numberOfLines={1}>{t.name}</Text>
                <Text style={[styles.tableMeta, styles.muted]}>
                  {t.items.length} part{t.items.length === 1 ? '' : 's'}
                </Text>
              </View>
              <Text style={styles.subMenuChevron}>›</Text>
            </TouchableOpacity>
          ))}
          {list.length === 0 && (
            <Text style={[styles.rowLabel, styles.muted, { marginTop: 8 }]}>
              Tables you save in Creative appear here.
            </Text>
          )}
        </ScrollView>
        <View style={styles.modalActions}>
          <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={onClose}>
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>
);

const SoundRow = ({
  label,
  name,
  fallback,
  onPick,
  onClear,
  volumeKey,
  state,
  onChange,
}: {
  label: string;
  name: string | null;
  fallback: string;
  onPick: () => void;
  onClear: () => void;
  volumeKey: 'bounceVolume' | 'hitVolume';
  state: SettingsState;
  onChange: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}) => (
  <View style={styles.soundBlock}>
    <Text style={styles.rowLabel}>
      {label}: <Text style={styles.muted}>{name ?? fallback}</Text>
    </Text>
    <View style={styles.soundButtons}>
      <TouchableOpacity style={[styles.button, styles.smallButton]} onPress={onPick}>
        <Text style={styles.buttonText}>{name ? 'Change…' : 'Load sound…'}</Text>
      </TouchableOpacity>
      {name && (
        <TouchableOpacity
          style={[styles.button, styles.smallButton, styles.secondaryButton]}
          onPress={onClear}
        >
          <Text style={[styles.buttonText, styles.secondaryButtonText]}>Clear</Text>
        </TouchableOpacity>
      )}
    </View>
    <Text style={styles.rowLabel}>Volume: {state[volumeKey].toFixed(2)}</Text>
    <Slider
      minimumValue={SLIDERS[volumeKey].min}
      maximumValue={SLIDERS[volumeKey].max}
      step={quarterStep(volumeKey)}
      value={state[volumeKey]}
      onValueChange={(v) => onChange(volumeKey, v)}
      minimumTrackTintColor="#03dac6"
      maximumTrackTintColor="#444"
      thumbTintColor="#03dac6"
    />
  </View>
);

const SoundsMenu = ({
  visible,
  onClose,
  state,
  onChange,
  customSoundName,
  onPickSound,
  onClearSound,
  customHitName,
  onPickHitSound,
  onClearHitSound,
}: {
  visible: boolean;
  onClose: () => void;
  state: SettingsState;
  onChange: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  customSoundName: string | null;
  onPickSound: () => void;
  onClearSound: () => void;
  customHitName: string | null;
  onPickHitSound: () => void;
  onClearHitSound: () => void;
}) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Sounds</Text>
        <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>
          <SoundRow
            label="Bounce sound"
            name={customSoundName}
            fallback="haptic tick (default)"
            onPick={onPickSound}
            onClear={onClearSound}
            volumeKey="bounceVolume"
            state={state}
            onChange={onChange}
          />
          <SoundRow
            label="Hit sound"
            name={customHitName}
            fallback="default push"
            onPick={onPickHitSound}
            onClear={onClearHitSound}
            volumeKey="hitVolume"
            state={state}
            onChange={onChange}
          />
        </ScrollView>
        <View style={styles.modalActions}>
          <TouchableOpacity style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>
);

export default function App() {
  const [running, setRunning] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [state, setState] = useState<SettingsState>(DEFAULTS);
  const [customSoundName, setCustomSoundName] = useState<string | null>(null);
  const [customHitName, setCustomHitName] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  // The app opens on the start menu (ADV-REV Q23). Mirrored into the module `mode` for the
  // frame loop and the responder.
  const [screen, setScreen] = useState<Mode>('menu');
  const [partsOpen, setPartsOpen] = useState(false);
  const [power, setPower] = useState(partPower);
  const [kind, setKind] = useState<PartType>(partType);
  const [buildingUi, setBuildingUi] = useState(false);
  const [tablesOpen, setTablesOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tableList, setTableList] = useState<SavedTable[]>([]);
  const [draftNameUi, setDraftNameUi] = useState<string | null>(null);
  const [bumperCount, setBumperCount] = useState(0);
  const go = (next: Mode) => {
    mode = next;
    menuRef.current = next === 'menu';
    setScreen(next);
  };
  // The responder is created once, so it reads the loss and the menu through refs.
  const lostRef = useRef(false);
  const menuRef = useRef(true);

  // The bar lives translated up behind the top edge; 0 is shown, -BAR_HIDDEN_Y is hidden.
  // Animated.Value rather than state so dragging never re-renders the game.
  const barY = useRef(new Animated.Value(-BAR_HIDDEN_Y)).current;
  const barShown = useRef(false);

  // Pulling the bar down pauses the table; putting it away resumes it. Banked nudges are
  // dropped either way, so resuming never discharges a stored-up shove.
  const settleBar = (show: boolean) => {
    // In Test, pausing hands back to Creative (ADV-REV Q16).
    if (show && mode === 'test') {
      exitTest();
      return;
    }
    barShown.current = show;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    setRunning(!show);
    Animated.timing(barY, {
      toValue: show ? 0 : -BAR_HIDDEN_Y,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  // One responder, three bands, chosen by where the finger LANDS:
  //   top    — a vertical drag pulls the bar down (pause) or pushes it back (resume)
  //   middle — taps only: a nudge ADDED to the ball's motion; drags do nothing
  //   bottom — an upward swipe launches the ball out of whichever lane holds it
  // Nothing freezes the ball on touch-down any more: with an open drain, a hold was a
  // free, unlimited save.
  const band = useRef<Band>('none');

  const swipe = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => {
        // While the loss overlay or the start menu is up, its buttons own every touch.
        if (lostRef.current || menuRef.current) return false;
        // Creative: the tool strip's buttons own their touches; the rest is the table. The
        // play bands do not apply while editing.
        if (mode === 'creative') {
          band.current = 'none';
          const { pageX, pageY } = evt.nativeEvent;
          // The strip's buttons, or while building the bottom bar's, take their own taps.
          if (!building && pageX > SCREEN_WIDTH - STRIP_WIDTH) return false;
          if (building && pageY > SCREEN_HEIGHT - BUILD_BAR_BOTTOM - BUILD_BAR_HEIGHT) return false;
          beginEdit(pageX, pageY);
          return true;
        }
        band.current = bandOf(
          evt.nativeEvent.pageY,
          SCREEN_HEIGHT,
          TOP_BAND,
          BOTTOM_BAND,
          BOTTOM_GESTURE_GUARD,
        );
        // Bottom: starting a swipe stops a ball sinking through a lane that allows it.
        if (band.current === 'bottom' && tryStopBall()) {
          aimFrom.dx = 0;
          aimFrom.dy = 0;
        }
        // Top: let the bar's buttons take their own taps; a drag is claimed on move.
        return band.current === 'middle' || band.current === 'bottom';
      },
      onMoveShouldSetPanResponder: (_evt, g) =>
        !lostRef.current &&
        !menuRef.current &&
        mode !== 'creative' &&
        band.current === 'top' &&
        Math.abs(g.dy) > SWIPE_CLAIM &&
        Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_evt, g) => {
        if (mode === 'creative') {
          moveEdit(g.dy);
          return;
        }
        if (band.current === 'bottom') {
          // A drag already under way also stops a ball that sinks into reach mid-swipe;
          // the shot is then measured from that moment.
          if (!ballStopped && tryStopBall()) {
            aimFrom.dx = g.dx;
            aimFrom.dy = g.dy;
          }
          if (!ballStopped) return;
          const preview = launchArrow(
            g.dx - aimFrom.dx,
            g.dy - aimFrom.dy,
            SWIPE_MIN_DISTANCE,
            SWIPE_GAIN,
            MAX_SPEED,
            ARROW_PX_PER_SPEED,
          );
          arrow.visible = preview !== null;
          if (preview) {
            arrow.length = preview.length;
            arrow.angle = preview.angle;
          }
          return;
        }
        if (band.current !== 'top') return;
        const base = barShown.current ? 0 : -BAR_HIDDEN_Y;
        barY.setValue(Math.max(-BAR_HIDDEN_Y, Math.min(0, base + g.dy)));
      },
      onPanResponderRelease: (evt, g) => {
        const box = gameEntities.box;

        if (mode === 'creative') {
          endEdit();
          setBumperCount(layout.length);
          return;
        }

        if (band.current === 'top') {
          if (g.dy > SWIPE_TRIGGER) settleBar(true);
          else if (g.dy < -SWIPE_TRIGGER) settleBar(false);
          else settleBar(barShown.current);
          return;
        }

        if (band.current === 'bottom') {
          if (!ballStopped) return; // the swipe never had a ball to launch
          const k = stopLane;
          // Any direction — aiming into the drain is allowed — scaled by drag length.
          const launch = swipeLaunch(
            g.dx - aimFrom.dx,
            g.dy - aimFrom.dy,
            SWIPE_MIN_DISTANCE,
            SWIPE_GAIN,
            MAX_SPEED,
          );
          releaseStop();
          // Too short to be a swipe: the ball simply resumes sinking, and the lane keeps
          // its state — no launch, no cooldown.
          if (!launch) return;
          lanes = lanes.map((lane, i) =>
            i === k
              ? laneAfterLaunch(lane, Date.now(), laneCooldownMs(lanes.length, settings.cooldownScale))
              : lane,
          );
          box.velocity.x = launch.x;
          box.velocity.y = launch.y;
          playPushSound();
          return;
        }

        // Middle band: taps only. A tap nudges the ball wherever it is, including while it
        // sinks through a lane — juggling is part of the game.
        if (Math.hypot(g.dx, g.dy) > SWIPE_MIN_DISTANCE) return;
        // The finger is on the screen; the ball is on a scrolled table.
        const finger = screenToWorld(
          evt.nativeEvent.pageX,
          evt.nativeEvent.pageY,
          camera.y,
          TOP_INSET,
        );
        const impulse = impulseAwayFrom(
          box.position.x,
          box.position.y,
          finger.x,
          finger.y,
          TAP_IMPULSE,
          Math.random,
          TAP_MIN_DISTANCE,
        );
        pendingImpulse.x += impulse.x;
        pendingImpulse.y += impulse.y;
        playPushSound();
      },
      onPanResponderTerminate: () => {
        // Losing the touch to the system must never leave the ball stopped, or a ghost up.
        releaseStop();
        ghost.visible = false;
        if (band.current === 'top') settleBar(barShown.current);
      },
    }),
  ).current;

  // The ball fell through the open bottom: show the overlay and wait for Continue.
  // Ball back to the spawn point at rest, lanes fresh, nothing banked.
  const resetTable = () => {
    const box = gameEntities.box;
    box.position.x = SPAWN.x;
    box.position.y = SPAWN.y;
    box.velocity.x = 0;
    box.velocity.y = 0;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    lanes = freshLanes();
    releaseStop();
    wasInBand = false;
    gameLost = false;
    lostRef.current = false;
    setLost(false);
  };

  // Continue: the ball waits at the spawn while the view pans back up the table to it,
  // so the player sees where play restarts (ADV-REV Q7). Play resumes when the pan lands.
  const continueAfterLoss = () => {
    resetTable();
    respawnPan = { startedAt: Date.now(), from: camera.y };
  };

  // Put the pause bar away without the pause/resume side effects.
  const hideBar = () => {
    barShown.current = false;
    barY.setValue(-BAR_HIDDEN_Y);
  };

  // From the start menu's picker: an empty table, or one saved from Creative, viewed from
  // the top.
  const startGame = (table: SavedTable | null) => {
    setPickerOpen(false);
    resetTable();
    setActiveParts(table ? [...table.items] : []);
    respawnPan = null;
    camera.y = 0;
    hideBar();
    go('game');
    setRunning(true);
  };

  // Creative: no ball; the layout under a build grid, scrolled by hand from the top.
  const setBuild = (on: boolean) => {
    building = on;
    ghost.visible = false;
    setBuildingUi(on);
  };

  const enterCreative = () => {
    setBuild(false);
    resetTable();
    setActiveParts([]);
    respawnPan = null;
    camera.y = 0;
    ghost.visible = false;
    hideBar();
    setBumperCount(layout.length);
    go('creative');
    setRunning(true);
  };

  // Test plays the layout, then hands back to Creative on pause or loss (ADV-REV Q16).
  const startTest = () => {
    resetTable();
    setActiveParts([...layout]);
    respawnPan = null;
    camera.y = 0;
    hideBar();
    go('test');
    setRunning(true);
  };

  const exitTest = () => {
    resetTable();
    setActiveParts([]);
    hideBar();
    go('creative');
    setRunning(true);
  };

  const backToMenu = () => {
    resetTable();
    setActiveParts([]);
    ghost.visible = false;
    hideBar();
    go('menu');
    setRunning(true);
  };

  const choosePower = (p: number) => {
    partPower = p;
    setPower(p);
  };

  const chooseType = (t: PartType) => {
    partType = t;
    setKind(t);
  };

  const clearTable = () =>
    Alert.alert('Clear the table?', 'This removes every part. It cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          layout = [];
          setBumperCount(0);
          saveLayout();
        },
      },
    ]);

  // ---- Saved tables ----------------------------------------------------------------
  const setDraftName = (name: string | null) => {
    draftName = name;
    setDraftNameUi(name);
    persistDraftMeta();
  };

  const commitSave = (name: string) => {
    const result = saveTable(tables, { name, items: [...layout], background: null }, Date.now(), newTableId);
    tables = result.tables;
    setTableList(tables);
    persistTables();
    setDraftName(name);
    if (settings.vibration) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const saveCurrent = (raw: string) => {
    const name = cleanTableName(raw);
    if (!name) {
      Alert.alert('Name the table', 'Type a name to save it under.');
      return;
    }
    const clash = tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    // Re-saving the table you loaded is the normal case; replacing a different one asks.
    if (clash && clash.name.toLowerCase() !== (draftName ?? '').toLowerCase()) {
      Alert.alert(`Replace “${clash.name}”?`, 'A saved table already has this name.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: () => commitSave(name) },
      ]);
      return;
    }
    commitSave(name);
  };

  const loadSaved = (t: SavedTable) => {
    const apply = () => {
      layout = [...t.items];
      setBumperCount(layout.length);
      saveLayout();
      setDraftName(t.name);
      setTablesOpen(false);
    };
    if (layout.length === 0) {
      apply();
      return;
    }
    Alert.alert(`Load “${t.name}”?`, 'It replaces the table you are editing. Save that first if you want to keep it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Load', onPress: apply },
    ]);
  };

  const deleteSaved = (t: SavedTable) =>
    Alert.alert(`Delete “${t.name}”?`, 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          tables = deleteTable(tables, t.id);
          setTableList(tables);
          persistTables();
        },
      },
    ]);

  const newDraft = () =>
    Alert.alert('Start a new table?', 'The table you are editing is cleared. Save it first if you want to keep it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'New table',
        style: 'destructive',
        onPress: () => {
          layout = [];
          setBumperCount(0);
          saveLayout();
          setDraftName(null);
          setTablesOpen(false);
        },
      },
    ]);

  useEffect(() => {
    // Sound effects should survive the iOS silent switch, and should sit alongside
    // whatever the player is already listening to rather than seizing the audio session.
    setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(() => {});

    bounceBank = createBank(BOUNCE_SOURCES);
    pushBank = createBank(PUSH_SOURCES);

    // Module state outlives a Fast Refresh, so start from a known baseline.
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    lanes = freshLanes();
    gameLost = false;
    respawnPan = null;
    camera.y = 0;

    // Restore persisted settings. mergeSettings trusts nothing: unknown keys are dropped,
    // wrong types fall back to defaults, numbers are clamped into their slider ranges.
    AsyncStorage.getItem(SETTINGS_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const merged = mergeSettings(DEFAULTS, JSON.parse(raw), SETTING_RANGES);
        merged.laneCount = Math.round(merged.laneCount);
        Object.assign(settings, merged);
        setState({ ...merged });
        lanes = freshLanes();
      })
      .catch(() => {});
    // Restore the Creative layout. A blob that is not a layout at all is someone's table in
    // a shape this build cannot read: keep a copy aside rather than overwrite it.
    AsyncStorage.getItem(LAYOUT_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {}
        const result = parseLayout(parsed, TABLE_ASPECT);
        if (!result.valid) {
          AsyncStorage.setItem(`${LAYOUT_STORAGE_KEY}:corrupt`, raw).catch(() => {});
          return;
        }
        layout = result.items;
        setBumperCount(layout.length);
      })
      .catch(() => {});
    AsyncStorage.getItem(TABLES_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {}
        tables = parseTables(parsed, TABLE_ASPECT);
        setTableList(tables);
      })
      .catch(() => {});
    AsyncStorage.getItem(DRAFT_META_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const meta = JSON.parse(raw);
        const name = typeof meta?.name === 'string' ? cleanTableName(meta.name) : null;
        draftName = name;
        setDraftNameUi(name);
      })
      .catch(() => {});

    // Losing in Test hands straight back to Creative; in Game it raises the overlay.
    notifyLost = () => {
      if (mode === 'test') {
        exitTest();
        return;
      }
      lostRef.current = true;
      setLost(true);
    };

    // Both custom-sound slots restore the same way: the OS can reclaim the copied file,
    // so a stored uri that no longer exists has its key purged rather than left dangling.
    const restoreSound = async (
      key: string,
      assign: (player: AudioPlayer) => void,
      setName: (name: string) => void,
    ) => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (!raw) return;
        const saved: PersistedSound = JSON.parse(raw);
        const file = new File(saved.uri);
        if (!file.exists) {
          await AsyncStorage.removeItem(key);
          return;
        }
        const player = createAudioPlayer({ uri: saved.uri });
        player.shouldCorrectPitch = false;
        assign(player);
        setName(saved.name);
      } catch {
        await AsyncStorage.removeItem(key).catch(() => {});
      }
    };

    restoreSound(SOUND_STORAGE_KEY, (pl) => { customBouncePlayer = pl; }, setCustomSoundName);
    restoreSound(HIT_SOUND_STORAGE_KEY, (pl) => { customPushPlayer = pl; }, setCustomHitName);

    return () => {
      notifyLost = null;
      for (const player of [...bounceBank, ...pushBank]) player.remove();
      bounceBank = [];
      pushBank = [];
      customBouncePlayer?.remove();
      customBouncePlayer = null;
      customPushPlayer?.remove();
      customPushPlayer = null;
    };
  }, []);

  // Settings persist across launches (ADV-REV Q33, default: yes), written shortly after the
  // last change so dragging a slider does not hammer storage.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistSettings = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)).catch(() => {});
    }, 400);
  };

  // A different lane count is a different table: rebuild the lanes from scratch.
  const applySideEffects = (key: keyof SettingsState) => {
    if (key === 'laneCount') {
      releaseStop();
      lanes = freshLanes();
    }
  };

  const updateSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    settings[key] = value;
    setState((prev) => ({ ...prev, [key]: value }));
    applySideEffects(key);
    persistSettings();
  };

  // Each panel resets only the values it owns.
  const resetKeys = (keys: readonly (keyof SettingsState)[]) => {
    const patch: Partial<SettingsState> = {};
    for (const key of keys) (patch as Record<string, unknown>)[key] = DEFAULTS[key];
    Object.assign(settings, patch);
    setState((prev) => ({ ...prev, ...patch }));
    for (const key of keys) applySideEffects(key);
    persistSettings();
  };

  // Bounce and hit sounds are the same flow against different keys, so it is written
  // once. The fixed basename per slot means each new pick overwrites that slot's file —
  // there is only ever one custom bounce and one custom hit on disk.
  const pickSoundInto = async (
    basename: string,
    key: string,
    current: () => AudioPlayer | null,
    assign: (player: AudioPlayer | null) => void,
    setName: (name: string | null) => void,
  ) => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];

    const dotIndex = asset.name.lastIndexOf('.');
    const ext = dotIndex >= 0 ? asset.name.slice(dotIndex) : '.mp3';
    const dest = new File(Paths.document, `${basename}${ext}`);
    if (dest.exists) dest.delete();
    new File(asset.uri).copy(dest);

    current()?.remove();
    const player = createAudioPlayer({ uri: dest.uri });
    player.shouldCorrectPitch = false;
    assign(player);
    setName(asset.name);
    await AsyncStorage.setItem(
      key,
      JSON.stringify({ uri: dest.uri, name: asset.name } satisfies PersistedSound),
    );
  };

  const clearSoundFrom = async (
    key: string,
    current: () => AudioPlayer | null,
    assign: (player: AudioPlayer | null) => void,
    setName: (name: string | null) => void,
  ) => {
    // Dropping the custom player falls back to the bundled bank rather than to silence.
    current()?.remove();
    assign(null);
    setName(null);
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const saved: PersistedSound = JSON.parse(raw);
        const file = new File(saved.uri);
        if (file.exists) file.delete();
      }
    } catch {}
    await AsyncStorage.removeItem(key);
  };

  const pickSound = () =>
    pickSoundInto(SOUND_FILE_BASENAME, SOUND_STORAGE_KEY,
      () => customBouncePlayer, (pl) => { customBouncePlayer = pl; }, setCustomSoundName);
  const clearSound = () =>
    clearSoundFrom(SOUND_STORAGE_KEY,
      () => customBouncePlayer, (pl) => { customBouncePlayer = pl; }, setCustomSoundName);
  const pickHitSound = () =>
    pickSoundInto(HIT_SOUND_FILE_BASENAME, HIT_SOUND_STORAGE_KEY,
      () => customPushPlayer, (pl) => { customPushPlayer = pl; }, setCustomHitName);
  const clearHitSound = () =>
    clearSoundFrom(HIT_SOUND_STORAGE_KEY,
      () => customPushPlayer, (pl) => { customPushPlayer = pl; }, setCustomHitName);

  return (
    <View style={styles.container} {...swipe.panHandlers}>
      <GameEngine
        style={styles.gameContainer}
        systems={[GameSystem]}
        entities={gameEntities}
        running={running && screen !== 'menu'}
      >
        {state.debugBands && (screen === 'game' || screen === 'test') && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={[styles.debugBand, { height: SCREEN_HEIGHT * TOP_BAND, backgroundColor: 'rgba(255,0,0,0.22)' }]} />
            <View style={[styles.debugBand, { flex: 1, backgroundColor: 'rgba(0,255,0,0.14)' }]} />
            <View style={[styles.debugBand, { height: SCREEN_HEIGHT * BOTTOM_BAND - BOTTOM_GESTURE_GUARD, backgroundColor: 'rgba(0,90,255,0.26)' }]} />
            <View style={[styles.debugBand, { height: BOTTOM_GESTURE_GUARD, backgroundColor: 'rgba(0,0,0,0.55)' }]} />
          </View>
        )}

        {/*
          The app draws edge-to-edge and the status bar is transparent, so anything on the
          table scrolled above the view would show through behind the system icons.
        */}
        <View style={styles.statusBackdrop} pointerEvents="none" />

        {/*
          Clipped below the status bar, so the hidden bar never shows through the system's
          transparent status area. box-none keeps the playfield under it touchable.
        */}
        {(screen === 'game' || screen === 'test') && (
        <View style={styles.controls} pointerEvents="box-none">
          <Animated.View style={[styles.topBar, { transform: [{ translateY: barY }] }]}>
            {/*
              In game: Resume, Options, Debug (ADV-REV Q23), plus Menu — Game and Creative
              are separate modes, and without it there is no way from one to the other.
              In Test, pulling the bar down hands straight back to Creative instead.
            */}
            <View style={styles.buttonRow}>
              <TouchableOpacity style={[styles.button, styles.barButton]} onPress={() => settleBar(false)}>
                <Text style={styles.buttonText}>Resume</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.barButton, styles.secondaryButton]}
                onPress={() => setMenuOpen(true)}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Options</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.barButton, styles.secondaryButton]}
                onPress={() => setDebugOpen(true)}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Debug</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.barButton, styles.secondaryButton]}
                onPress={backToMenu}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Menu</Text>
              </TouchableOpacity>
            </View>
            {/*
              Android gives the top edge to the notification shade, so the drag starts
              anywhere in the top band instead, and tapping the grabber toggles the bar
              as a discoverable fallback.
            */}
            <TouchableOpacity
              onPress={() => settleBar(!barShown.current)}
              hitSlop={{ top: 12, bottom: 12, left: 40, right: 40 }}
            >
              <View style={styles.grabber} />
            </TouchableOpacity>
          </Animated.View>
        </View>
        )}

        {lost && (
          <View style={styles.lostOverlay}>
            <Text style={styles.lostTitle}>You lost!</Text>
            <TouchableOpacity style={styles.button} onPress={continueAfterLoss}>
              <Text style={styles.buttonText}>Continue</Text>
            </TouchableOpacity>
          </View>
        )}

        {screen === 'menu' && (
          // Android 12+ shows the native splash only as a small centred icon, so the full
          // portrait art lives here, on the first screen, under a scrim that keeps the buttons
          // readable.
          <ImageBackground
            source={require('./assets/menu-background.jpg')}
            resizeMode="cover"
            style={styles.startMenu}
          >
            <View style={styles.startScrim} pointerEvents="none" />
            <Text style={styles.startTitle}>Pinbolita</Text>
            <TouchableOpacity style={[styles.button, styles.menuButton]} onPress={() => setPickerOpen(true)}>
              <Text style={[styles.buttonText, styles.menuButtonText]}>Game</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.menuButton]} onPress={enterCreative}>
              <Text style={[styles.buttonText, styles.menuButtonText]}>Creative</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.menuButton, styles.secondaryButton]}
              onPress={() => setMenuOpen(true)}
            >
              <Text style={[styles.buttonText, styles.menuButtonText, styles.secondaryButtonText]}>
                Options
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.menuButton, styles.secondaryButton]}
              onPress={() => setDebugOpen(true)}
            >
              <Text style={[styles.buttonText, styles.menuButtonText, styles.secondaryButtonText]}>
                Debug
              </Text>
            </TouchableOpacity>
          </ImageBackground>
        )}

        {screen === 'creative' && (
          <>
            {/* The grid already signals the mode; the badge names it. */}
            <Text style={styles.creativeBadge} pointerEvents="none">
              CREATIVE · {draftNameUi ?? 'unsaved'} · {bumperCount}
            </Text>
            {buildingUi ? (
              // Building: the whole width is the grid. This bar is the way back out.
              <View style={styles.buildBar}>
                <TouchableOpacity style={styles.buildBarPart} onPress={() => setPartsOpen(true)}>
                  <PartGlyph type={kind} h={12} power={kind === 'wall' ? 1 : power} />
                  <Text style={styles.stripPartText}>{kind === 'wall' ? 'Wall' : `×${power}`}</Text>
                </TouchableOpacity>
                <Text style={styles.buildBarHint}>Tap to place · tap a part to remove · drag to scroll</Text>
                <TouchableOpacity style={[styles.button, styles.buildBarDone]} onPress={() => setBuild(false)}>
                  <Text style={styles.buttonText}>Done</Text>
                </TouchableOpacity>
              </View>
            ) : (
              // The right-side tool strip (ADV-REV Q3, Q23). Build hides it for placing.
              <View style={styles.strip}>
                <TouchableOpacity style={styles.stripPart} onPress={() => setPartsOpen(true)}>
                  <PartGlyph type={kind} h={14} power={kind === 'wall' ? 1 : power} />
                  <Text style={styles.stripPartText}>
                    {kind === 'wall' ? 'Wall' : `×${power}`}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.stripButton, styles.stripPrimary]}
                  onPress={() => setBuild(true)}
                >
                  <Text style={[styles.stripButtonText, styles.stripPrimaryText]}>Build</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.stripButton} onPress={() => setTablesOpen(true)}>
                  <Text style={styles.stripButtonText}>Tables</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.stripButton} onPress={startTest}>
                  <Text style={styles.stripButtonText}>Test</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.stripButton} onPress={() => setDebugOpen(true)}>
                  <Text style={styles.stripButtonText}>Debug</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.stripButton} onPress={backToMenu}>
                  <Text style={styles.stripButtonText}>Menu</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </GameEngine>

      <PartsMenu
        visible={partsOpen}
        onClose={() => setPartsOpen(false)}
        type={kind}
        onType={chooseType}
        power={power}
        onPower={choosePower}
        count={bumperCount}
        onClear={clearTable}
      />

      <OptionsMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        state={state}
        onChange={updateSetting}
        onReset={() => resetKeys(OPTION_KEYS)}
        onOpenSounds={() => setSoundsOpen(true)}
      />

      <TablesMenu
        visible={tablesOpen}
        onClose={() => setTablesOpen(false)}
        list={tableList}
        currentName={draftNameUi}
        partCount={bumperCount}
        onSave={saveCurrent}
        onLoad={loadSaved}
        onDelete={deleteSaved}
        onNew={newDraft}
      />

      <GamePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        list={tableList}
        onPick={startGame}
      />

      <DebugMenu
        visible={debugOpen}
        onClose={() => setDebugOpen(false)}
        state={state}
        onChange={updateSetting}
        onReset={() => resetKeys(DEBUG_KEYS)}
      />

      <SoundsMenu
        visible={soundsOpen}
        onClose={() => setSoundsOpen(false)}
        state={state}
        onChange={updateSetting}
        customSoundName={customSoundName}
        onPickSound={pickSound}
        onClearSound={clearSound}
        customHitName={customHitName}
        onPickHitSound={pickHitSound}
        onClearHitSound={clearHitSound}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // The table itself: plain dark grey, unless the table carries its own background.
  container: {
    flex: 1,
    backgroundColor: TABLE_COLOR,
  },
  gameContainer: {
    flex: 1,
  },
  controls: {
    position: 'absolute',
    top: TOP_INSET,
    height: BAR_HEIGHT,
    width: '100%',
    alignItems: 'center',
    overflow: 'hidden',
    pointerEvents: 'box-none',
  },
  topBar: {
    width: '100%',
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 14,
    backgroundColor: 'rgba(24,24,24,0.94)',
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
  },
  // Sits at the bar's bottom edge, so it stays on screen while the bar is hidden —
  // without it the swipe gesture has no affordance at all.
  grabber: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#555',
    marginBottom: 8,
  },
  debugBand: {
    width: '100%',
  },
  // `top` is set per frame from the camera.
  laneStrip: {
    position: 'absolute',
    left: 0,
    width: SCREEN_WIDTH,
    height: LANE_DEPTH,
    flexDirection: 'row',
    borderTopWidth: 2,
    borderTopColor: 'rgba(3,218,198,0.6)',
  },
  partBody: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  partFlash: {
    borderColor: 'white',
    borderWidth: 3,
  },
  wall: {
    backgroundColor: WALL_COLOR,
    borderColor: 'rgba(0,0,0,0.45)',
    borderRadius: 2,
  },
  bumperLabel: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold',
  },
  noBuild: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'rgba(231,76,60,0.12)',
  },
  gridCol: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  gridRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  ghost: {
    position: 'absolute',
    borderRadius: 6,
  },
  strip: {
    position: 'absolute',
    top: TOP_INSET + 8,
    right: 6,
    width: STRIP_WIDTH - 12,
    gap: 8,
    alignItems: 'stretch',
  },
  stripButton: {
    backgroundColor: 'rgba(30,30,30,0.92)',
    borderWidth: 1,
    borderColor: '#03dac6',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  stripButtonText: {
    color: '#03dac6',
    fontSize: 13,
    fontWeight: 'bold',
  },
  stripPrimary: {
    backgroundColor: '#03dac6',
  },
  stripPrimaryText: {
    color: 'black',
  },
  buildBar: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: BUILD_BAR_BOTTOM,
    height: BUILD_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(24,24,24,0.94)',
    borderWidth: 1,
    borderColor: '#03dac6',
  },
  buildBarPart: {
    alignItems: 'center',
    minWidth: 40,
  },
  buildBarHint: {
    flex: 1,
    color: '#bbb',
    fontSize: 11,
  },
  buildBarDone: {
    paddingHorizontal: 22,
  },
  stripPart: {
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(30,30,30,0.92)',
  },
  stripPartText: {
    color: 'white',
    fontSize: 11,
    marginTop: 4,
  },
  partGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  partTile: {
    width: 64,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#444',
    alignItems: 'center',
    gap: 6,
  },
  partTileOn: {
    borderColor: '#03dac6',
    backgroundColor: 'rgba(3,218,198,0.15)',
  },
  partTileText: {
    color: 'white',
    fontSize: 12,
  },
  creativeBadge: {
    position: 'absolute',
    top: TOP_INSET + 8,
    left: 10,
    color: '#03dac6',
    fontSize: 13,
    fontWeight: 'bold',
    backgroundColor: 'rgba(18,18,18,0.8)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
  },
  statusBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: TOP_INSET,
    backgroundColor: TABLE_COLOR,
  },
  guide: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  guideTop: {
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  hud: {
    position: 'absolute',
    top: TOP_INSET + GRABBER_PEEK + 4,
    right: 10,
    color: '#9fe',
    fontSize: 13,
    fontWeight: 'bold',
  },
  sectionLabel: {
    color: '#03dac6',
    fontSize: 13,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    marginTop: 16,
    marginBottom: 4,
  },
  choiceRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  choice: {
    minWidth: 48,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#03dac6',
    alignItems: 'center',
  },
  choiceOn: {
    backgroundColor: '#03dac6',
  },
  choiceText: {
    color: '#03dac6',
    fontWeight: 'bold',
  },
  choiceTextOn: {
    color: 'black',
  },
  // Four buttons must fit a 360 dp bar.
  barButton: {
    paddingHorizontal: 10,
  },
  startMenu: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1c2428',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  startScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  startTitle: {
    color: 'white',
    fontSize: 44,
    fontWeight: 'bold',
    marginBottom: 24,
    textShadowColor: 'black',
    textShadowRadius: 8,
  },
  menuButton: {
    width: 220,
    alignItems: 'center',
    paddingVertical: 14,
  },
  menuButtonText: {
    fontSize: 18,
  },
  menuButtonDisabled: {
    backgroundColor: '#333',
  },
  menuDisabledText: {
    color: '#888',
  },
  lane: {
    flex: 1,
  },
  laneFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  // At the top of the lane, where the ball enters: a ball sinking through the middle of the
  // band would otherwise sit on top of it and hide it.
  laneGlyph: {
    color: 'white',
    fontSize: 22,
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 2,
  },
  arrowShaft: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: 'white',
  },
  arrowHead: {
    position: 'absolute',
    width: 2 * HEAD_HALF,
    height: 2 * HEAD_HALF,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderColor: 'white',
  },
  laneDivider: {
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.25)',
  },
  lostOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  lostTitle: {
    color: 'white',
    fontSize: 40,
    fontWeight: 'bold',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    backgroundColor: '#03dac6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 25,
    elevation: 3,
  },
  buttonText: {
    color: 'black',
    fontWeight: 'bold',
    fontSize: 16,
  },
  // No elevation: on Android the shadow of a transparent button draws through it as a
  // stray line across the middle of the outline.
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#03dac6',
    elevation: 0,
  },
  secondaryButtonText: {
    color: '#03dac6',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#1e1e1e',
    borderRadius: 16,
    padding: 20,
    maxHeight: '86%',
  },
  modalTitle: {
    color: 'white',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  rowLabel: {
    color: 'white',
    fontSize: 16,
  },
  sliderBlock: {
    paddingVertical: 8,
  },
  modalScroll: {
    flexShrink: 1,
  },
  modalScrollContent: {
    paddingBottom: 4,
  },
  subMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  subMenuChevron: {
    color: '#03dac6',
    fontSize: 24,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 16,
  },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  nameInput: {
    flex: 1,
    color: 'white',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  tableMeta: {
    fontSize: 12,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2c2c2c',
  },
  soundBlock: {
    paddingVertical: 8,
    gap: 8,
  },
  soundButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  smallButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  muted: {
    color: '#bbb',
    fontWeight: 'normal',
  },
});
