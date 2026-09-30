/**
 * Pure game maths — no React, no sensors, no audio, no Dimensions.
 *
 * Everything the frame loop needs to *decide* lives here so it can be unit tested.
 * Everything that needs a device (playing a sound, reading the accelerometer,
 * rendering) stays in App.tsx. Keep this file import-free.
 */

export type Vec = { x: number; y: number };

/** Returns a float in [0, 1). Injected so random paths are testable. */
export type Rng = () => number;

/** One frame at the 60 Hz baseline the original constants were tuned against. */
export const FRAME_MS = 1000 / 60;

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

/**
 * Converts a frame's elapsed time into a multiplier against the 60 Hz baseline.
 *
 * The engine's loop is driven by requestAnimationFrame, so it ticks at the display
 * refresh rate — on a 120 Hz phone the ball would otherwise travel twice as fast and
 * friction would bite twice as hard. Scaling by this keeps the feel identical across
 * refresh rates, and returns exactly 1 at 60 Hz so existing tuning is untouched.
 *
 * The upper clamp matters: after a long stall (backgrounding, a GC pause) an unclamped
 * delta would integrate the ball straight through a wall.
 */
export function frameScale(deltaMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 1;
  return clamp(deltaMs / FRAME_MS, 0.5, 2);
}

/**
 * Impulse that shoves the ball directly away from a tap.
 *
 * Screen space: x grows right, y grows *down*. Tapping left of the ball pushes it
 * right; tapping above it pushes it down.
 *
 * Rainy path: a tap landing on the ball's centre gives a zero-length direction vector,
 * which would normalise to NaN and freeze the ball forever. Inside `minDistance` we
 * pick a random direction instead, so a dead-centre tap still launches it.
 */
export function impulseAwayFrom(
  ballX: number,
  ballY: number,
  tapX: number,
  tapY: number,
  magnitude: number,
  rng: Rng,
  minDistance = 1,
): Vec {
  const dx = ballX - tapX;
  const dy = ballY - tapY;
  const distance = Math.hypot(dx, dy);

  if (distance < minDistance) {
    const angle = rng() * Math.PI * 2;
    return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
  }

  return { x: (dx / distance) * magnitude, y: (dy / distance) * magnitude };
}

/** Caps total speed without changing heading, so a sustained shake cannot run away. */
export function capSpeed(vx: number, vy: number, max: number): Vec {
  const speed = Math.hypot(vx, vy);
  if (speed === 0 || speed <= max) return { x: vx, y: vy };
  const scale = max / speed;
  return { x: vx * scale, y: vy * scale };
}

/**
 * Snaps a barely-moving ball to a genuine stop.
 *
 * Friction alone decays velocity asymptotically, so the ball creeps at sub-pixel speed
 * forever. Only zero it when the phone is also flat — otherwise a tilted phone would
 * keep killing the very motion it is trying to create.
 */
export function applyRest(
  vx: number,
  vy: number,
  tiltMagnitude: number,
  restEpsilon: number,
  tiltDeadzone: number,
): Vec {
  const speed = Math.hypot(vx, vy);
  if (speed < restEpsilon && tiltMagnitude < tiltDeadzone) return { x: 0, y: 0 };
  return { x: vx, y: vy };
}

/**
 * One step of the low-pass gravity estimate.
 *
 * Accelerometer samples mix gravity (low frequency, follows orientation) with real
 * shaking (high frequency). This EMA tracks the gravity part; subtracting it leaves the
 * linear acceleration that actually represents a shake.
 */
export function stepGravity(
  gx: number,
  gy: number,
  sampleX: number,
  sampleY: number,
  lerp: number,
): Vec {
  return { x: gx + (sampleX - gx) * lerp, y: gy + (sampleY - gy) * lerp };
}

/** Maps impact speed to playback volume, so a slam is louder than a graze. */
export function impactGain(speed: number, loudSpeed: number, minGain: number): number {
  if (loudSpeed <= 0) return 1;
  return clamp(speed / loudSpeed, minGain, 1);
}

/**
 * Picks a sound variant, never repeating the one just played.
 *
 * Two jobs at once: consecutive hits sound different, and because each variant is a
 * distinct AudioPlayer, they also land on different players and so overlap instead of
 * cutting each other off. Pass `last = -1` when nothing has played yet.
 */
export function pickVariant(count: number, last: number, rng: Rng): number {
  if (count <= 1) return 0;

  if (last < 0 || last >= count) {
    return Math.min(Math.floor(rng() * count), count - 1);
  }

  const pool = count - 1;
  let index = Math.min(Math.floor(rng() * pool), pool - 1);
  if (index >= last) index += 1;
  return index;
}

/**
 * Tell a shake apart from a tilt.
 *
 * The residual alone cannot do this. `stepGravity` follows the raw sample by only
 * GRAVITY_LERP per frame, so rotating the phone leaves a large residual for the whole
 * sweep — which read as a sustained shake, firing the push sound on a ~110ms cadence
 * and shoving the ball with impulses the player never asked for.
 *
 * The extra fact that separates them is total acceleration. Rotating a phone only
 * turns the 1g gravity vector, so its magnitude stays ~1; actually moving the phone
 * adds to or subtracts from it. Requiring both a real residual *and* a departure from
 * 1g keeps shake responsive while rejecting tilt outright.
 *
 * Both comparisons are strict, so a value sitting exactly on a threshold is not a shake.
 */
export function isShake(
  linearX: number,
  linearY: number,
  accelMagnitude: number,
  residualThreshold: number,
  magnitudeThreshold: number,
): boolean {
  if (Math.hypot(linearX, linearY) <= residualThreshold) return false;
  return Math.abs(accelMagnitude - 1) > magnitudeThreshold;
}

/**
 * Playback rate for a sound, given how far the phone is tilted.
 *
 * `tiltMagnitude` is hypot(tilt.x, tilt.y): 0 lying flat, 1 stood on edge. It is
 * clamped because the accelerometer overshoots past 1g when the phone is moved as
 * well as turned, and an unclamped rate runs the pitch away.
 *
 * `amount` is the user's slider; at 0 the effect is off and the base pitch is returned
 * untouched, which is what makes the control feel like a real disable.
 */
export function tiltPitch(
  tiltMagnitude: number,
  basePitch: number,
  amount: number,
  maxRise: number,
): number {
  const t = Math.max(0, Math.min(1, tiltMagnitude));
  return basePitch * (1 + t * amount * maxRise);
}

/**
 * Pick the next ball hue, never landing within `minSeparation` degrees of the last one.
 *
 * Same reasoning as `pickVariant`: a uniform random hue repeatedly produces colours too
 * close to the previous bounce to read as a change at all. Restricting the draw to the
 * arc beyond the separation guarantees every bounce is visibly different, without ever
 * rejecting-and-retrying (which would make the number of rng() calls unpredictable and
 * the function untestable with a fixed sequence).
 */
export function nextHue(prevHue: number, rng: Rng, minSeparation: number): number {
  const arc = 360 - 2 * minSeparation;
  return (prevHue + minSeparation + rng() * arc) % 360;
}

/**
 * Per-frame velocity retention for a given friction setting.
 *
 * The setting used to BE the retention factor, exposed on a slider labelled "Friction".
 * That inverted the control: turning it up meant retaining more velocity, so the ball
 * slid further the more "friction" you asked for. Friction is now 0..1 in the direction
 * a player expects — 0 is frictionless, 1 grips hardest — and the retention is derived.
 *
 * `lossAtMax` stays small because this is applied every frame: at 60fps a retention of
 * 0.98 still sheds ~70% of the velocity in a second.
 */
export function frictionRetention(friction: number, lossAtMax: number): number {
  const f = Math.max(0, Math.min(1, friction));
  return 1 - f * lossAtMax;
}

/**
 * Velocity for a flick, or null when the gesture was too short to be one.
 *
 * Returning null rather than a tiny vector is what lets the caller fall back to the tap
 * behaviour: a swipe the player did not really mean should shove the ball away from the
 * finger as a tap always has, not launch it a few pixels in a random direction.
 *
 * The comparison is strict, so a drag of exactly `minDistance` is still a tap — the same
 * convention the shake and rest thresholds use.
 */
export function swipeLaunch(
  dx: number,
  dy: number,
  minDistance: number,
  gain: number,
  maxSpeed: number,
): Vec | null {
  const distance = Math.hypot(dx, dy);
  if (distance <= minDistance) return null;

  const speed = Math.min(distance * gain, maxSpeed);
  // Scale the raw delta onto the target speed, so direction survives the cap intact.
  return { x: (dx / distance) * speed, y: (dy / distance) * speed };
}
