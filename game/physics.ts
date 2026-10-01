/**
 * Pure game maths — no React, no audio, no Dimensions.
 *
 * Everything the frame loop and the touch router need to *decide* lives here so it can
 * be unit tested. Everything that needs a device (playing a sound, reading touches,
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

/**
 * The launch a lane gives a caught ball: a flick, but only an upward one.
 *
 * A downward or sideways swipe from the bottom lanes would throw the ball straight into
 * the drain, which is never what the player meant. Screen y grows down, so "upward" is
 * a negative dy.
 */
export function upwardLaunch(
  dx: number,
  dy: number,
  minDistance: number,
  gain: number,
  maxSpeed: number,
): Vec | null {
  if (dy >= 0) return null;
  return swipeLaunch(dx, dy, minDistance, gain, maxSpeed);
}

export type Ball = { x: number; y: number; vx: number; vy: number };

/**
 * One frame of free flight: constant downward pull, friction, speed cap, integration.
 *
 * There is deliberately no rest clamp. The engine used to zero any speed below 0.08
 * px/frame when the phone was flat, which under a weak constant pull left a ball at rest
 * hanging in mid-air forever — and at 120 Hz the threshold effectively doubled. With a
 * pull that never switches off, a ball never legitimately rests in open space.
 *
 * `pull` is in px/frame² at the 60 Hz baseline and, like every force, is scaled by dtf.
 */
export function stepBall(
  ball: Ball,
  pull: number,
  dtf: number,
  retention: number,
  maxSpeed: number,
): Ball {
  const damping = Math.pow(retention, dtf);
  const capped = capSpeed(ball.vx * damping, (ball.vy + pull * dtf) * damping, maxSpeed);
  return {
    x: ball.x + capped.x * dtf,
    y: ball.y + capped.y * dtf,
    vx: capped.x,
    vy: capped.y,
  };
}

/**
 * Fraction of the ball's AREA that lies below a horizontal edge.
 *
 * This is the lanes' 35% rule, computed exactly rather than by heuristic: it is the area
 * of a circular segment, one acos and one sqrt per frame. At 35% the centre is still
 * 0.238·r above the edge.
 */
export function catchFraction(centreY: number, edgeY: number, radius: number): number {
  const u = (edgeY - centreY) / radius; // centre's height above the edge, in radii
  if (u >= 1) return 0;
  if (u <= -1) return 1;
  return (Math.acos(u) - u * Math.sqrt(1 - u * u)) / Math.PI;
}

/**
 * Which lane a ball belongs to: the one containing its centre.
 *
 * Membership by centre is a partition — lanes never overlap, so a ball straddling a
 * boundary still belongs to exactly one of them and no tie-break is needed.
 */
export function laneOf(x: number, width: number, laneCount: number): number {
  if (laneCount <= 1) return 0;
  return clamp(Math.floor((x / width) * laneCount), 0, laneCount - 1);
}

export type LanePhase = 'ready' | 'holding' | 'cooldown';
/** `readyAt` is only meaningful while cooling down: the clock time it becomes ready. */
export type Lane = { phase: LanePhase; readyAt: number };

/** A ready lane catches the ball; a lane on cooldown lets it fall through to the drain. */
export function laneAfterCatch(lane: Lane): Lane {
  return lane.phase === 'ready' ? { phase: 'holding', readyAt: 0 } : lane;
}

/** Launching releases the ball and starts this lane's own cooldown. */
export function laneAfterLaunch(lane: Lane, now: number, cooldownMs: number): Lane {
  if (lane.phase !== 'holding') return lane;
  return { phase: 'cooldown', readyAt: now + cooldownMs };
}

export function laneTick(lane: Lane, now: number): Lane {
  if (lane.phase === 'cooldown' && now >= lane.readyAt) return { phase: 'ready', readyAt: 0 };
  return lane;
}

export type LaneLight = 'lit' | 'dark' | 'gray';

/** Lit when a swipe will launch, dark while cooling down, gray on standby. */
export function laneLight(lane: Lane): LaneLight {
  if (lane.phase === 'holding') return 'lit';
  if (lane.phase === 'cooldown') return 'dark';
  return 'gray';
}

export type Band = 'top' | 'middle' | 'bottom' | 'none';

/**
 * Which horizontal band a touch STARTED in.
 *
 * The bottom `bottomGuard` px are Android's home-gesture strip, which the system claims
 * and no app can exclude; a touch starting there is refused rather than half-handled.
 * Edges are half-open so every y belongs to exactly one band.
 */
export function bandOf(
  y: number,
  height: number,
  topFraction: number,
  bottomFraction: number,
  bottomGuard: number,
): Band {
  if (y < height * topFraction) return 'top';
  if (y <= height * (1 - bottomFraction)) return 'middle';
  if (y > height - bottomGuard) return 'none';
  return 'bottom';
}

/** True once the whole ball has left the table through its open bottom. */
export function hasFallenOut(centreY: number, radius: number, floorY: number): boolean {
  return centreY - radius > floorY;
}
