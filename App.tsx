import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GameEngine } from 'react-native-game-engine';
import { Accelerometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import { createAudioPlayer, setAudioModeAsync, AudioPlayer } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import {
  applyRest,
  capSpeed,
  frameScale,
  frictionRetention,
  impactGain,
  impulseAwayFrom,
  isShake,
  nextHue,
  pickVariant,
  stepGravity,
  swipeLaunch,
  tiltPitch,
} from './game/physics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const BALL_SIZE = 50;
const RADIUS = BALL_SIZE / 2;

const DEFAULTS = {
  tiltAccel: 1.3,
  bounciness: 0.7,
  // 0 = frictionless, 1 = grips hardest. See frictionRetention: this used to be the
  // retention factor itself, which made the slider run backwards.
  friction: 0.25,
  vibration: true,
  sound: true,
  basePitch: 1.0,
  tiltPitchAmount: 0.5,
  colorOnBounce: false,
  bounceVolume: 1.0,
  hitVolume: 1.0,
};

// Every slider is divided into four, so each has step = (max - min) / 4 and the defaults
// above sit exactly on a stop.
const SLIDERS = {
  tiltAccel: { min: 0.4, max: 4 },
  bounciness: { min: 0.1, max: 1.3 }, // above 1 the ball gains energy on a bounce
  friction: { min: 0, max: 1 },
  basePitch: { min: 0.5, max: 1.5 },
  tiltPitchAmount: { min: 0, max: 1 },
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
const GRAVITY_LERP = 0.08; // how quickly the gravity estimate follows a new orientation
const SHAKE_THRESHOLD = 0.15; // g of gravity-removed acceleration that counts as shaking
// Turning the phone only rotates the 1g vector, so its magnitude stays ~1; actually
// moving the phone does not. Without this second test a sustained tilt reads as a shake
// for its whole sweep, because the gravity estimate lags it by GRAVITY_LERP per frame.
const SHAKE_MAGNITUDE_THRESHOLD = 0.12;
const SHAKE_GAIN = 18; // linear acceleration -> velocity
const SHAKE_SOUND_COOLDOWN_MS = 110;
const TAP_IMPULSE = 11; // tuned by hand on device — 9 read as slightly underpowered
const TAP_MIN_DISTANCE = 1; // closer than this and the tap has no usable direction
const REST_EPSILON = 0.08;
const TILT_DEADZONE = 0.045;
const MAX_SPEED = 40; // so a sustained shake cannot fling the ball out of the world

// Sound variation.
const VOICES_PER_VARIANT = 2;
const RATE_MIN = 0.82;
const RATE_MAX = 1.22;
const VOLUME_JITTER = 0.15;
const LOUD_SPEED = 14; // impact speed that plays at full volume
const MIN_GAIN = 0.25;
// Applied every frame, so it stays small: 0.98 retention still sheds ~70% in a second.
const FRICTION_LOSS_AT_MAX = 0.02;
// Flick-to-launch. Below MIN the gesture falls back to the tap shove.
const SWIPE_MIN_DISTANCE = 20;
const SWIPE_GAIN = 0.09;
// The bottom strip belongs to the control bar; swipes above it launch the ball.
const BAR_GESTURE_ZONE = 0.85;
const MAX_TILT_PITCH_RISE = 0.8; // full tilt at amount 1 plays 1.8x rate
const RATE_HARD_MIN = 0.25; // expo-audio rejects rates outside roughly this range
const RATE_HARD_MAX = 3.0;

// Ball colour. The hue only moves when colourOnBounce is on; the default pink is the
// seed so the first random hue is already visibly away from it.
const BALL_DEFAULT_COLOR = '#ff4081';
const HUE_MIN_SEPARATION = 60;

// Swipe-up control bar. The playfield is otherwise bare, so a permanently visible
// grabber is the only affordance telling the player the gesture exists at all.
const BAR_HEIGHT = 108;
// The bar never hides completely: this much stays on screen so the grabber remains a
// visible affordance. Hiding it entirely leaves the gesture undiscoverable.
// 8 (bar paddingTop) + 5 (grabber) + slack. Must stay below 27, where the button row
// starts, or the buttons peek above the bottom edge while the bar is "hidden".
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
const tilt = { x: 0, y: 0 };
const settings = { ...DEFAULTS };

// Taps and shakes land here and are drained once per frame. The sensor fires
// independently of the render loop, so deriving impulses inside the frame would only
// ever see the newest sample — and the samples in between are the shake.
const pendingImpulse = { x: 0, y: 0 };

// The low-frequency part of the accelerometer is gravity, i.e. how the phone is held.
// Subtracting it leaves the movement. Seeded from the first sample, because starting at
// zero would make that first reading look like a 1g shove.
const gravity = { x: 0, y: 0 };
let gravityReady = false;

// Mirrors the `running` React state. The sensor listener keeps firing while the game is
// paused, so without this a shake during a pause would bank up an impulse and fire the
// whole thing the moment play resumes.
let engineRunning = true;

let bounceBank: AudioPlayer[] = [];
let pushBank: AudioPlayer[] = [];
let customBouncePlayer: AudioPlayer | null = null;
let customPushPlayer: AudioPlayer | null = null;
// Set while a finger is holding the ball. TiltSystem must see it, because otherwise it
// re-accelerates the ball from tilt between touch events and the hold does not hold.
let holdingBall = false;
let ballHue = 340;
let ballColor = BALL_DEFAULT_COLOR;
let lastBounceVariant = -1;
let lastPushVariant = -1;
let lastPushSoundAt = 0;
let voiceCursor = 0;

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

// How far the phone is tilted right now, as a playback-rate multiplier. Read at play
// time rather than stored, because the physics loop and the sensor both move faster
// than React state does.
const currentPitch = () =>
  tiltPitch(
    Math.hypot(tilt.x, tilt.y),
    settings.basePitch,
    settings.tiltPitchAmount,
    MAX_TILT_PITCH_RISE,
  );

const playPlayer = (player: AudioPlayer, gain: number, pitch: number) => {
  try {
    // Must be setPlaybackRate(), not `player.playbackRate = x`. The type definitions
    // declare playbackRate as an assignable property, but the runtime object exposes
    // only a getter, so assigning throws — which typecheck and unit tests both miss.
    // The per-hit random variation still applies; tilt multiplies it. Clamped because
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

// Shaking crosses the threshold many times a second; without a cooldown the push sound
// turns into a machine gun.
const maybePlayPushSound = () => {
  const now = Date.now();
  if (now - lastPushSoundAt < SHAKE_SOUND_COOLDOWN_MS) return;
  lastPushSoundAt = now;
  playPushSound();
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

const TiltSystem = (entities: any, { time }: any) => {
  const box = entities.box;

  // A held ball is frozen: no tilt, no banked impulses, no integration.
  if (holdingBall) {
    box.velocity.x = 0;
    box.velocity.y = 0;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    box.color = settings.colorOnBounce ? ballColor : BALL_DEFAULT_COLOR;
    return entities;
  }

  // The loop is driven by requestAnimationFrame, so it ticks at the display's refresh
  // rate. Without this a 120Hz phone runs the ball twice as fast on the same numbers.
  const dtf = frameScale(time?.delta);

  // Whatever the tap and shake handlers accumulated since the last frame.
  box.velocity.x += pendingImpulse.x;
  box.velocity.y += pendingImpulse.y;
  pendingImpulse.x = 0;
  pendingImpulse.y = 0;

  // The accelerometer reads +g on whichever axis points AWAY from the ground, so a
  // positive reading means that edge is RAISED and the ball must roll the other way.
  // Both axes were previously un-negated/negated the wrong way round, which made the
  // ball drift toward the raised edge like a spirit-level bubble.
  const ax = -tilt.x * settings.tiltAccel;
  const ay = tilt.y * settings.tiltAccel;

  const damping = Math.pow(frictionRetention(settings.friction, FRICTION_LOSS_AT_MAX), dtf);
  box.velocity.x = (box.velocity.x + ax * dtf) * damping;
  box.velocity.y = (box.velocity.y + ay * dtf) * damping;

  const capped = capSpeed(box.velocity.x, box.velocity.y, MAX_SPEED);
  box.velocity.x = capped.x;
  box.velocity.y = capped.y;

  box.position.x += box.velocity.x * dtf;
  box.position.y += box.velocity.y * dtf;

  if (box.position.x < RADIUS) {
    box.position.x = RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.x));
    box.velocity.x = -box.velocity.x * settings.bounciness;
  } else if (box.position.x > SCREEN_WIDTH - RADIUS) {
    box.position.x = SCREEN_WIDTH - RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.x));
    box.velocity.x = -box.velocity.x * settings.bounciness;
  }

  if (box.position.y < RADIUS) {
    box.position.y = RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.y));
    box.velocity.y = -box.velocity.y * settings.bounciness;
  } else if (box.position.y > SCREEN_HEIGHT - RADIUS) {
    box.position.y = SCREEN_HEIGHT - RADIUS;
    triggerBounceFeedback(Math.abs(box.velocity.y));
    box.velocity.y = -box.velocity.y * settings.bounciness;
  }

  // Friction only ever approaches zero, so without this the ball creeps forever and
  // "put the phone down and it stops" is never quite true.
  const rested = applyRest(
    box.velocity.x,
    box.velocity.y,
    Math.hypot(tilt.x, tilt.y),
    REST_EPSILON,
    TILT_DEADZONE,
  );
  box.velocity.x = rested.x;
  box.velocity.y = rested.y;

  box.color = settings.colorOnBounce ? ballColor : BALL_DEFAULT_COLOR;

  return entities;
};

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

// Built once, deliberately. GameEngine reads entities only at mount, and TouchSystem
// needs a stable handle on the ball to work out which way "away from the tap" is.
const gameEntities = {
  box: {
    position: { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 },
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
          <Text style={styles.rowLabel}>Tilt pitch amount: {state.tiltPitchAmount.toFixed(2)}</Text>
          <Slider
            minimumValue={SLIDERS.tiltPitchAmount.min}
            maximumValue={SLIDERS.tiltPitchAmount.max}
            step={quarterStep('tiltPitchAmount')}
            value={state.tiltPitchAmount}
            onValueChange={(v) => onChange('tiltPitchAmount', v)}
            minimumTrackTintColor="#03dac6"
            maximumTrackTintColor="#444"
            thumbTintColor="#03dac6"
          />
        </View>

        <View style={styles.sliderBlock}>
          <Text style={styles.rowLabel}>Tilt sensitivity: {state.tiltAccel.toFixed(2)}</Text>
          <Slider
            minimumValue={SLIDERS.tiltAccel.min}
            maximumValue={SLIDERS.tiltAccel.max}
            step={quarterStep('tiltAccel')}
            value={state.tiltAccel}
            onValueChange={(v) => onChange('tiltAccel', v)}
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

  // The bar lives translated off the bottom edge; 0 is shown, BAR_HEIGHT is hidden.
  // Animated.Value rather than state so dragging never re-renders the game.
  const barY = useRef(new Animated.Value(BAR_HIDDEN_Y)).current;
  const barShown = useRef(false);

  const settleBar = (show: boolean) => {
    barShown.current = show;
    Animated.timing(barY, {
      toValue: show ? 0 : BAR_HIDDEN_Y,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  // One responder, two jobs, split by where the finger lands. The bottom strip drives
  // the control bar (as before); anywhere above it the finger catches the ball, holds it
  // while dragging, and flicks it on release.
  const onBar = useRef(false);

  const swipe = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => {
        onBar.current = evt.nativeEvent.pageY > SCREEN_HEIGHT * BAR_GESTURE_ZONE;
        if (onBar.current) return false; // let the bar's buttons take their own taps
        holdingBall = true; // catch the ball the instant the finger lands
        return true;
      },
      onMoveShouldSetPanResponder: (_evt, g) =>
        onBar.current && Math.abs(g.dy) > SWIPE_CLAIM && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_evt, g) => {
        if (!onBar.current) return; // the ball is held; nothing to do until release
        const base = barShown.current ? 0 : BAR_HIDDEN_Y;
        barY.setValue(Math.max(0, Math.min(BAR_HIDDEN_Y, base + g.dy)));
      },
      onPanResponderRelease: (evt, g) => {
        if (onBar.current) {
          if (g.dy < -SWIPE_TRIGGER) settleBar(true);
          else if (g.dy > SWIPE_TRIGGER) settleBar(false);
          else settleBar(barShown.current);
          return;
        }

        holdingBall = false;
        const box = gameEntities.box;
        const launch = swipeLaunch(g.dx, g.dy, SWIPE_MIN_DISTANCE, SWIPE_GAIN, MAX_SPEED);
        if (launch) {
          box.velocity.x = launch.x;
          box.velocity.y = launch.y;
          playPushSound();
          return;
        }

        // Too short to be a flick, so it was a tap: shove away from the finger, exactly
        // as the old TouchSystem did.
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
        holdingBall = false;
        if (onBar.current) settleBar(barShown.current);
      },
    }),
  ).current;

  useEffect(() => {
    // Sound effects should survive the iOS silent switch, and should sit alongside
    // whatever the player is already listening to rather than seizing the audio session.
    setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(() => {});

    bounceBank = createBank(BOUNCE_SOURCES);
    pushBank = createBank(PUSH_SOURCES);

    // Module state outlives a Fast Refresh, so start from a known baseline.
    engineRunning = true;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;

    Accelerometer.setUpdateInterval(16);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      tilt.x = x;
      tilt.y = y;

      if (!gravityReady) {
        gravity.x = x;
        gravity.y = y;
        gravityReady = true;
        return;
      }

      const next = stepGravity(gravity.x, gravity.y, x, y, GRAVITY_LERP);
      gravity.x = next.x;
      gravity.y = next.y;

      // What gravity does not account for is the phone actually being moved. Note this
      // is the residual, not the difference between samples: differences telescope back
      // to zero over a shake cycle, which would leave the ball jittering in place.
      const linearX = x - gravity.x;
      const linearY = y - gravity.y;

      // Keep tracking gravity while paused so the estimate is current on resume, but do
      // not bank impulses the player will never see applied.
      if (!engineRunning) return;

      // Residual alone cannot tell a tilt from a shake — see isShake.
      if (isShake(linearX, linearY, Math.hypot(x, y, z), SHAKE_THRESHOLD, SHAKE_MAGNITUDE_THRESHOLD)) {
        pendingImpulse.x += linearX * SHAKE_GAIN;
        pendingImpulse.y += -linearY * SHAKE_GAIN; // flip y, same convention as the tilt
        maybePlayPushSound();
      }
    });

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
      sub.remove();
      for (const player of [...bounceBank, ...pushBank]) player.remove();
      bounceBank = [];
      pushBank = [];
      customBouncePlayer?.remove();
      customBouncePlayer = null;
      customPushPlayer?.remove();
      customPushPlayer = null;
      gravityReady = false;
    };
  }, []);

  // Dual write, the same contract as `settings`: React state drives the button label,
  // the module flag is what the sensor callback can actually read. Anything banked while
  // paused is dropped, so resuming does not discharge a stored-up shove.
  const toggleRunning = () => {
    const next = !running;
    engineRunning = next;
    pendingImpulse.x = 0;
    pendingImpulse.y = 0;
    setRunning(next);
  };

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
        systems={[TiltSystem]}
        entities={gameEntities}
        running={running}
      >
        {/*
          box-none so the bare playfield keeps receiving taps: only the bar itself and
          the grabber are hit-testable, and the pan responder declines plain touches, so
          a tap anywhere still reaches TouchSystem and shoves the ball.
        */}
        <View style={styles.controls} pointerEvents="box-none">
          <Animated.View style={[styles.bottomBar, { transform: [{ translateY: barY }] }]}>
            {/*
              Android reserves the bottom-edge upward swipe for Home and does not let an
              app exclude it, so an edge swipe can never reach us. The drag is therefore
              handled at the root (anywhere on screen), and tapping the grabber toggles
              the bar as a discoverable fallback.
            */}
            <TouchableOpacity
              onPress={() => settleBar(!barShown.current)}
              hitSlop={{ top: 12, bottom: 12, left: 40, right: 40 }}
            >
              <View style={styles.grabber} />
            </TouchableOpacity>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.button} onPress={toggleRunning}>
                <Text style={styles.buttonText}>{running ? 'Pause' : 'Resume'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={() => setMenuOpen(true)}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Options</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
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
    bottom: 0,
    width: '100%',
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  bottomBar: {
    width: '100%',
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 8,
    backgroundColor: 'rgba(24,24,24,0.94)',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  // Sits above the bar's own top edge, so it stays on screen while the bar is hidden —
  // without it the swipe gesture has no affordance at all.
  grabber: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#555',
    marginBottom: 14,
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
