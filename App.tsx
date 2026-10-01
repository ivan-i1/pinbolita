import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
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
  bandOf,
  catchFraction,
  frameScale,
  frictionRetention,
  hasFallenOut,
  impactGain,
  impulseAwayFrom,
  laneAfterCatch,
  laneAfterLaunch,
  laneLight,
  laneOf,
  laneTick,
  nextHue,
  pickVariant,
  stepBall,
  upwardLaunch,
  type Band,
  type Lane,
  type LaneLight,
} from './game/physics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const BALL_SIZE = 28;
const RADIUS = BALL_SIZE / 2;

const DEFAULTS = {
  // Constant downward pull, px/frame² at 60 Hz. The table's only gravity: the
  // accelerometer is not used at all.
  pull: 0.2,
  laneCooldown: 1.5, // seconds a lane stays dark after it launches the ball
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
};

// Every slider is divided into four, so each has step = (max - min) / 4 and the defaults
// above sit exactly on a stop.
const SLIDERS = {
  pull: { min: 0.1, max: 0.5 },
  laneCooldown: { min: 0.5, max: 2.5 },
  bounciness: { min: 0.1, max: 1.3 }, // above 1 the ball gains energy on a bounce
  friction: { min: 0, max: 1 },
  basePitch: { min: 0.5, max: 1.5 },
  bounceVolume: { min: 0, max: 1 },
  hitVolume: { min: 0, max: 1 },
} as const;
const quarterStep = (k: keyof typeof SLIDERS) => (SLIDERS[k].max - SLIDERS[k].min) / 4;

// Bounces below this impact speed don't fire feedback — keeps the ball quiet when it's resting against a wall.
const FEEDBACK_VELOCITY_THRESHOLD = 1.0;

const SOUND_STORAGE_KEY = '@pinbolita:bounce_sound';
const SOUND_FILE_BASENAME = 'bounce-sound';
const HIT_SOUND_STORAGE_KEY = '@pinbolita:hit_sound';
const HIT_SOUND_FILE_BASENAME = 'hit-sound';

// Input and feel. Starting values — expect to tune these against a real device.
const TAP_IMPULSE = 11; // tuned by hand on device — 9 read as slightly underpowered
const TAP_MIN_DISTANCE = 1; // closer than this and the tap has no usable direction
const MAX_SPEED = 40; // so repeated nudges and launches cannot fling the ball out of the world

// Sound variation.
const VOICES_PER_VARIANT = 2;
const RATE_MIN = 0.82;
const RATE_MAX = 1.22;
const VOLUME_JITTER = 0.15;
const LOUD_SPEED = 14; // impact speed that plays at full volume
const MIN_GAIN = 0.25;
// Applied every frame, so it stays small: 0.98 retention still sheds ~70% in a second.
const FRICTION_LOSS_AT_MAX = 0.02;
// Flick-to-launch. A drag no longer than MIN is a tap, not a swipe.
const SWIPE_MIN_DISTANCE = 20;
const SWIPE_GAIN = 0.09;

// Touch bands, by where a touch STARTS: top swipes open the bar and pause, middle taps
// nudge the ball, bottom swipes launch it out of a lane.
const TOP_BAND = 0.15;
const BOTTOM_BAND = 0.22;
// Android's home gesture owns the bottom 32 dp and no app can exclude it; a swipe
// starting inside it never reaches us. Refuse the strip outright, with some margin.
const BOTTOM_GESTURE_GUARD = 48;

// Lanes are the flippers: a ready lane catches the ball, a swipe launches it, then that
// lane cools down on its own timer. 1a ships a single lane across the full width.
const LANE_COUNT = 1;
const CATCH_FRACTION = 0.35; // share of the ball's area inside the lane before it catches
const CATCH_EDGE_Y = SCREEN_HEIGHT * (1 - BOTTOM_BAND);
// The worst single step is MAX_SPEED × the dtf clamp of 2 = 80 px. A shallower catch
// band would let a stalled frame carry the ball straight over it.
if (__DEV__ && SCREEN_HEIGHT - CATCH_EDGE_Y <= MAX_SPEED * 2 + BALL_SIZE) {
  console.warn('[lanes] catch band is shallower than one worst-case step');
}

// The status bar area belongs to the system; the top bar and spawn point sit below it.
const TOP_INSET = StatusBar.currentHeight ?? 0;
const SPAWN = { x: SCREEN_WIDTH / 2, y: TOP_INSET + RADIUS + 24 };
const RATE_HARD_MIN = 0.25; // expo-audio rejects rates outside roughly this range
const RATE_HARD_MAX = 3.0;

// Ball colour. The hue only moves when colourOnBounce is on; the default pink is the
// seed so the first random hue is already visibly away from it.
const BALL_DEFAULT_COLOR = '#ff4081';
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
  Array.from({ length: LANE_COUNT }, () => ({ phase: 'ready' as const, readyAt: 0 }));
let lanes: Lane[] = freshLanes();
let gameLost = false;
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

const heldLane = () => lanes.findIndex((lane) => lane.phase === 'holding');

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

const GameSystem = (entities: any, { time }: any) => {
  const box = entities.box;

  // Cooldowns run on the wall clock, so a lane recovers even while the ball is elsewhere.
  const now = Date.now();
  lanes = lanes.map((lane) => laneTick(lane, now));
  entities.lanes.lights = lanes.map(laneLight);
  box.color = settings.colorOnBounce ? ballColor : BALL_DEFAULT_COLOR;

  // A caught ball is frozen until a bottom swipe launches it: no pull, no nudges.
  if (gameLost || heldLane() >= 0) {
    box.velocity.x = 0;
    box.velocity.y = 0;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    return entities;
  }

  // The loop is driven by requestAnimationFrame, so it ticks at the display's refresh
  // rate. Without this a 120Hz phone runs the ball twice as fast on the same numbers.
  const dtf = frameScale(time?.delta);

  // Whatever the tap handler banked since the last frame.
  box.velocity.x += pendingImpulse.x;
  box.velocity.y += pendingImpulse.y;
  pendingImpulse.x = 0;
  pendingImpulse.y = 0;

  const next = stepBall(
    { x: box.position.x, y: box.position.y, vx: box.velocity.x, vy: box.velocity.y },
    settings.pull,
    dtf,
    frictionRetention(settings.friction, FRICTION_LOSS_AT_MAX),
    MAX_SPEED,
  );
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

  // Top wall only: the bottom is open, which is how the ball is lost.
  if (box.position.y < TOP_INSET + RADIUS) {
    box.position.y = TOP_INSET + RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.y));
    box.velocity.y = -box.velocity.y * settings.bounciness;
  }

  // A ready lane catches the ball once 35% of it has entered the lane band. The lane is
  // chosen by the ball's centre, never by where the player's finger is.
  if (catchFraction(box.position.y, CATCH_EDGE_Y, RADIUS) >= CATCH_FRACTION) {
    const k = laneOf(box.position.x, SCREEN_WIDTH, LANE_COUNT);
    const caught = laneAfterCatch(lanes[k]);
    if (caught !== lanes[k]) {
      lanes = lanes.map((lane, i) => (i === k ? caught : lane));
      box.velocity.x = 0;
      box.velocity.y = 0;
      entities.lanes.lights = lanes.map(laneLight);
      if (settings.vibration) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return entities;
    }
  }

  if (hasFallenOut(box.position.y, RADIUS, SCREEN_HEIGHT)) {
    gameLost = true;
    notifyLost?.();
  }

  return entities;
};

// The lane strip along the bottom of the table. Lights: lit = a swipe will launch,
// dark = cooling down, gray = standby.
const LANE_COLORS: Record<LaneLight, string> = {
  lit: 'rgba(3,218,198,0.45)',
  dark: 'rgba(255,255,255,0.02)',
  gray: 'rgba(255,255,255,0.10)',
};

const LaneStrip = ({ lights }: { lights: LaneLight[] }) => (
  <View style={styles.laneStrip} pointerEvents="none">
    {lights.map((light, i) => (
      <View
        key={i}
        style={[
          styles.lane,
          { backgroundColor: LANE_COLORS[light] },
          i > 0 && styles.laneDivider,
        ]}
      />
    ))}
  </View>
);

const Box = ({ position, size, color }: any) => {
  return (
    <View
      style={{
        position: 'absolute',
        left: position.x - size[0] / 2,
        top: position.y - size[1] / 2,
        width: size[0],
        height: size[1],
        backgroundColor: color ?? BALL_DEFAULT_COLOR,
        borderRadius: size[0] / 2,
      }}
    />
  );
};

// Built once, deliberately. GameEngine reads entities only at mount, and the root touch
// responder needs a stable handle on the ball to work out which way "away from the tap"
// is. Lanes come first so the ball draws on top of them.
const gameEntities = {
  lanes: {
    lights: lanes.map(laneLight),
    renderer: <LaneStrip lights={[]} />,
  },
  box: {
    position: { x: SPAWN.x, y: SPAWN.y },
    velocity: { x: 0, y: 0 },
    size: [BALL_SIZE, BALL_SIZE],
    color: BALL_DEFAULT_COLOR,
    renderer: <Box />,
  },
};

type SettingsState = typeof DEFAULTS;

const SettingsMenu = ({
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

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Show touch bands (debug)</Text>
          <Switch value={state.debugBands} onValueChange={(v) => onChange('debugBands', v)} />
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

        <View style={styles.sliderBlock}>
          <Text style={styles.rowLabel}>Pull: {state.pull.toFixed(2)}</Text>
          <Slider
            minimumValue={SLIDERS.pull.min}
            maximumValue={SLIDERS.pull.max}
            step={quarterStep('pull')}
            value={state.pull}
            onValueChange={(v) => onChange('pull', v)}
            minimumTrackTintColor="#03dac6"
            maximumTrackTintColor="#444"
            thumbTintColor="#03dac6"
          />
        </View>

        <View style={styles.sliderBlock}>
          <Text style={styles.rowLabel}>Lane cooldown: {state.laneCooldown.toFixed(1)} s</Text>
          <Slider
            minimumValue={SLIDERS.laneCooldown.min}
            maximumValue={SLIDERS.laneCooldown.max}
            step={quarterStep('laneCooldown')}
            value={state.laneCooldown}
            onValueChange={(v) => onChange('laneCooldown', v)}
            minimumTrackTintColor="#03dac6"
            maximumTrackTintColor="#444"
            thumbTintColor="#03dac6"
          />
        </View>

        <View style={styles.sliderBlock}>
          <Text style={styles.rowLabel}>Bounciness: {state.bounciness.toFixed(2)}</Text>
          <Slider
            minimumValue={SLIDERS.bounciness.min}
            maximumValue={SLIDERS.bounciness.max}
            step={quarterStep('bounciness')}
            value={state.bounciness}
            onValueChange={(v) => onChange('bounciness', v)}
            minimumTrackTintColor="#03dac6"
            maximumTrackTintColor="#444"
            thumbTintColor="#03dac6"
          />
        </View>

        <View style={styles.sliderBlock}>
          <Text style={styles.rowLabel}>Friction: {state.friction.toFixed(2)}</Text>
          <Slider
            minimumValue={SLIDERS.friction.min}
            maximumValue={SLIDERS.friction.max}
            step={quarterStep('friction')}
            value={state.friction}
            onValueChange={(v) => onChange('friction', v)}
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


// Each sound gets its own file picker and its own volume, so a loud custom bounce can be
// tamed without turning the hit sound down with it.
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
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [state, setState] = useState<SettingsState>(DEFAULTS);
  const [customSoundName, setCustomSoundName] = useState<string | null>(null);
  const [customHitName, setCustomHitName] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  // The responder is created once, so it reads the loss through a ref, not state.
  const lostRef = useRef(false);

  // The bar lives translated up behind the top edge; 0 is shown, -BAR_HIDDEN_Y is hidden.
  // Animated.Value rather than state so dragging never re-renders the game.
  const barY = useRef(new Animated.Value(-BAR_HIDDEN_Y)).current;
  const barShown = useRef(false);

  // Pulling the bar down pauses the table; putting it away resumes it. Banked nudges are
  // dropped either way, so resuming never discharges a stored-up shove.
  const settleBar = (show: boolean) => {
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
        // While the loss overlay is up, its Continue button owns every touch.
        if (lostRef.current) return false;
        band.current = bandOf(
          evt.nativeEvent.pageY,
          SCREEN_HEIGHT,
          TOP_BAND,
          BOTTOM_BAND,
          BOTTOM_GESTURE_GUARD,
        );
        // Top: let the bar's buttons take their own taps; a drag is claimed on move.
        return band.current === 'middle' || band.current === 'bottom';
      },
      onMoveShouldSetPanResponder: (_evt, g) =>
        !lostRef.current &&
        band.current === 'top' &&
        Math.abs(g.dy) > SWIPE_CLAIM &&
        Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_evt, g) => {
        if (band.current !== 'top') return;
        const base = barShown.current ? 0 : -BAR_HIDDEN_Y;
        barY.setValue(Math.max(-BAR_HIDDEN_Y, Math.min(0, base + g.dy)));
      },
      onPanResponderRelease: (evt, g) => {
        const box = gameEntities.box;

        if (band.current === 'top') {
          if (g.dy > SWIPE_TRIGGER) settleBar(true);
          else if (g.dy < -SWIPE_TRIGGER) settleBar(false);
          else settleBar(barShown.current);
          return;
        }

        if (band.current === 'bottom') {
          const k = heldLane();
          if (k < 0) return; // nothing to launch: no lane is holding the ball
          const launch = upwardLaunch(g.dx, g.dy, SWIPE_MIN_DISTANCE, SWIPE_GAIN, MAX_SPEED);
          if (!launch) return;
          lanes = lanes.map((lane, i) =>
            i === k ? laneAfterLaunch(lane, Date.now(), settings.laneCooldown * 1000) : lane,
          );
          box.velocity.x = launch.x;
          box.velocity.y = launch.y;
          playPushSound();
          return;
        }

        // Middle band. A drag is not a tap, and a caught ball ignores nudges: only a
        // launch releases it.
        if (Math.hypot(g.dx, g.dy) > SWIPE_MIN_DISTANCE || heldLane() >= 0) return;
        const impulse = impulseAwayFrom(
          box.position.x,
          box.position.y,
          evt.nativeEvent.pageX,
          evt.nativeEvent.pageY,
          TAP_IMPULSE,
          Math.random,
          TAP_MIN_DISTANCE,
        );
        pendingImpulse.x += impulse.x;
        pendingImpulse.y += impulse.y;
        playPushSound();
      },
      onPanResponderTerminate: () => {
        if (band.current === 'top') settleBar(barShown.current);
      },
    }),
  ).current;

  // The ball fell through the open bottom: show the overlay and wait for Continue.
  const continueAfterLoss = () => {
    const box = gameEntities.box;
    box.position.x = SPAWN.x;
    box.position.y = SPAWN.y;
    box.velocity.x = 0;
    box.velocity.y = 0;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    lanes = freshLanes();
    gameLost = false;
    lostRef.current = false;
    setLost(false);
  };

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
    notifyLost = () => {
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

  const updateSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    settings[key] = value;
    setState((prev) => ({ ...prev, [key]: value }));
  };

  const resetSettings = () => {
    Object.assign(settings, DEFAULTS);
    setState({ ...DEFAULTS });
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
        running={running}
      >
        {state.debugBands && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={[styles.debugBand, { height: SCREEN_HEIGHT * TOP_BAND, backgroundColor: 'rgba(255,0,0,0.22)' }]} />
            <View style={[styles.debugBand, { flex: 1, backgroundColor: 'rgba(0,255,0,0.14)' }]} />
            <View style={[styles.debugBand, { height: SCREEN_HEIGHT * BOTTOM_BAND - BOTTOM_GESTURE_GUARD, backgroundColor: 'rgba(0,90,255,0.26)' }]} />
            <View style={[styles.debugBand, { height: BOTTOM_GESTURE_GUARD, backgroundColor: 'rgba(0,0,0,0.55)' }]} />
          </View>
        )}

        {/*
          Clipped below the status bar, so the hidden bar never shows through the system's
          transparent status area. box-none keeps the playfield under it touchable.
        */}
        <View style={styles.controls} pointerEvents="box-none">
          <Animated.View style={[styles.topBar, { transform: [{ translateY: barY }] }]}>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.button} onPress={() => settleBar(false)}>
                <Text style={styles.buttonText}>Resume</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={() => setMenuOpen(true)}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Options</Text>
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

        {lost && (
          <View style={styles.lostOverlay}>
            <Text style={styles.lostTitle}>You lost!</Text>
            <TouchableOpacity style={styles.button} onPress={continueAfterLoss}>
              <Text style={styles.buttonText}>Continue</Text>
            </TouchableOpacity>
          </View>
        )}
      </GameEngine>

      <SettingsMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        state={state}
        onChange={updateSetting}
        onReset={resetSettings}
        onOpenSounds={() => setSoundsOpen(true)}
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
  container: {
    flex: 1,
    backgroundColor: '#121212',
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
  laneStrip: {
    position: 'absolute',
    left: 0,
    top: CATCH_EDGE_Y,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT - CATCH_EDGE_Y,
    flexDirection: 'row',
    borderTopWidth: 2,
    borderTopColor: 'rgba(3,218,198,0.6)',
  },
  lane: {
    flex: 1,
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
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#03dac6',
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
