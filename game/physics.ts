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
 * The arrow previewing a launch: where the ball will go, and how hard.
 *
 * Launches go in any direction — aiming into the drain is allowed — so the arrow simply
 * follows the swipe. Its length is the launch SPEED (capped), not the raw drag, so it
 * stops growing exactly where extra drag stops adding power. Null means "no launch":
 * the drag is still too short, and nothing should be drawn.
 */
export function launchArrow(
  dx: number,
  dy: number,
  minDistance: number,
  gain: number,
  maxSpeed: number,
  pxPerSpeed: number,
): { length: number; angle: number } | null {
  const launch = swipeLaunch(dx, dy, minDistance, gain, maxSpeed);
  if (!launch) return null;
  return {
    length: Math.hypot(launch.x, launch.y) * pxPerSpeed,
    angle: Math.atan2(launch.y, launch.x),
  };
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

/**
 * A lane is either ready or cooling down. It never "holds" the ball: its band is viscous
 * instead, so a ball in it keeps sinking slowly and drains if the player does nothing.
 * `readyAt` is only meaningful while cooling down: the clock time it becomes ready.
 */
export type LanePhase = 'ready' | 'cooldown';
export type Lane = { phase: LanePhase; readyAt: number };

/**
 * Launching starts this lane's own cooldown. A launch made inside the leniency window —
 * while the lane was still cooling — restarts it from now.
 */
export function laneAfterLaunch(_lane: Lane, now: number, cooldownMs: number): Lane {
  return { phase: 'cooldown', readyAt: now + cooldownMs };
}

export function laneTick(lane: Lane, now: number): Lane {
  if (lane.phase === 'cooldown' && now >= lane.readyAt) return { phase: 'ready', readyAt: 0 };
  return lane;
}

/**
 * Whether starting a swipe may stop the ball in this lane.
 *
 * Always when ready; while cooling, only in the last `leniencyMs` of the cooldown, so a
 * swipe begun a moment early is not punished. Inclusive at the window's edge.
 */
export function canSwipeCatch(lane: Lane, now: number, leniencyMs: number): boolean {
  return lane.phase === 'ready' || now >= lane.readyAt - leniencyMs;
}

/** Per-frame velocity retention inside a lane band: thickest when ready, thinner cooling. */
export function laneRetention(lane: Lane, readyRetention: number, coolingRetention: number): number {
  return lane.phase === 'ready' ? readyRetention : coolingRetention;
}

export type LaneVisual = { kind: 'standby' | 'holding' | 'cooldown'; progress: number };

/**
 * What a lane should show.
 *
 * holding — ready, with the ball sinking in it: a swipe will stop and launch it.
 * cooldown — `progress` runs 0 → 1 across the cooldown, for a gradual colour and fill.
 * standby — ready and empty.
 *
 * The leniency window deliberately does not show: it is a forgiveness, not a state.
 */
export function laneVisual(
  lane: Lane,
  now: number,
  cooldownMs: number,
  ballInLane: boolean,
): LaneVisual {
  if (lane.phase === 'cooldown') {
    const remaining = lane.readyAt - now;
    const progress = cooldownMs > 0 ? clamp(1 - remaining / cooldownMs, 0, 1) : 1;
    return { kind: 'cooldown', progress };
  }
  return { kind: ballInLane ? 'holding' : 'standby', progress: 1 };
}

/** Linear blend of two #rrggbb colours; `t` is clamped to 0..1. */
export function mixColor(from: string, to: string, t: number): string {
  const k = clamp(t, 0, 1);
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * k);
    out += v.toString(16).padStart(2, '0');
  }
  return out;
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

/**
 * The velocity a ball keeps as it falls into a lane band.
 *
 * The band's viscosity bleeds speed over roughly v·r/(1−r) of travel. On a table several
 * screens tall the ball arrives near the speed cap, which needs more than the whole band
 * to bleed off, so it punched straight through and drained with no time to react. Capping
 * the speed on the entry frame restores the slow sink the lanes are designed around.
 * Only a ball moving down is touched: a launch out of the band keeps all its power.
 */
export function bandEntryVelocity(
  vx: number,
  vy: number,
  entering: boolean,
  maxEntrySpeed: number,
): Vec {
  if (!entering || vy <= 0) return { x: vx, y: vy };
  return capSpeed(vx, vy, maxEntrySpeed);
}

/**
 * Where the camera wants to be: the ball held `anchor` of the way down the viewport,
 * clamped so the view never leaves the table. At the bottom it pins, which is what puts
 * the lanes at the bottom of the screen exactly when the ball can reach them.
 */
export function cameraTarget(
  ballY: number,
  viewportHeight: number,
  worldHeight: number,
  anchor: number,
): number {
  const maxScroll = Math.max(0, worldHeight - viewportHeight);
  return clamp(ballY - viewportHeight * anchor, 0, maxScroll);
}

/**
 * Ease the camera toward its target. `follow` is the share of the gap closed per 60 Hz
 * frame; raising the retention to the power of dtf keeps the pace per second identical
 * at any refresh rate, like every other per-frame factor here.
 */
export function stepCamera(camera: number, target: number, dtf: number, follow: number): number {
  const kept = Math.pow(1 - clamp(follow, 0, 1), dtf);
  return target + (camera - target) * kept;
}

/** A touch on the screen, as a point on the scrolled table. */
export function screenToWorld(
  screenX: number,
  screenY: number,
  camera: number,
  topInset: number,
): Vec {
  return { x: screenX, y: screenY - topInset + camera };
}

/** Eased 0 → 1 progress of a timed pan (smoothstep): gentle start and landing. */
export function panProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  const t = clamp(elapsedMs / durationMs, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Each lane's cooldown: the base split across the lanes. One lane covers the whole width
 * and waits longest; with more, each covers less and recovers sooner.
 */
export function laneCooldownMs(baseSeconds: number, laneCount: number): number {
  return (baseSeconds * 1000) / Math.max(1, Math.floor(laneCount) || 1);
}

/**
 * Rebuild settings from whatever was persisted, trusting nothing.
 *
 * Only keys the defaults know survive; a value of the wrong type falls back to its
 * default; numbers are clamped into their slider range, and NaN or infinities rejected.
 * A stored blob from an older or newer build therefore can never put the game into a
 * state its own controls could not reach.
 */
export function mergeSettings<T extends Record<string, number | boolean>>(
  defaults: T,
  saved: unknown,
  ranges: Partial<Record<keyof T, { min: number; max: number }>>,
): T {
  const out = { ...defaults };
  if (saved === null || typeof saved !== 'object') return out;
  const source = saved as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = source[key as string];
    if (typeof value !== typeof defaults[key]) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      const range = ranges[key];
      (out as Record<string, unknown>)[key as string] = range
        ? clamp(value, range.min, range.max)
        : value;
    } else {
      (out as Record<string, unknown>)[key as string] = value;
    }
  }
  return out;
}

/**
 * How many pieces to split a frame's movement into, so no piece is longer than `maxStep`.
 *
 * Bumpers are small and the ball can move 80 px in a stalled frame: integrated in one
 * piece it can jump clean over a bumper, or land past its centre and be pushed out the
 * far side. Capped, because a pathological frame should cost bounded work.
 */
export function substepCount(travel: number, maxStep: number, maxSubsteps: number): number {
  if (!(travel > 0) || !(maxStep > 0)) return 1;
  return clamp(Math.ceil(travel / maxStep), 1, maxSubsteps);
}

/**
 * Ball against a round bumper.
 *
 * If they overlap, the ball is pushed out to touching distance along the line between the
 * centres. If it was moving in, its normal velocity is reflected and the bumper adds
 * `kick` outward — the bumper gives energy back, which is what makes it a bumper rather
 * than a post. A ball already moving away is only separated. `impact` is the inward
 * normal speed, for sound and haptics.
 */
export function collideCircle(
  ball: Ball,
  cx: number,
  cy: number,
  radiusSum: number,
  kick: number,
): { ball: Ball; hit: boolean; impact: number } {
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  const distance = Math.hypot(dx, dy);
  if (distance >= radiusSum) return { ball, hit: false, impact: 0 };

  // Dead centre has no direction: push straight up, out of the way of the pull.
  const nx = distance > 1e-9 ? dx / distance : 0;
  const ny = distance > 1e-9 ? dy / distance : -1;
  const x = cx + nx * radiusSum;
  const y = cy + ny * radiusSum;

  const vn = ball.vx * nx + ball.vy * ny;
  if (vn >= 0) return { ball: { x, y, vx: ball.vx, vy: ball.vy }, hit: true, impact: 0 };

  return {
    ball: {
      x,
      y,
      vx: ball.vx - 2 * vn * nx + kick * nx,
      vy: ball.vy - 2 * vn * ny + kick * ny,
    },
    hit: true,
    impact: -vn,
  };
}

/** The grid cell under a point, in table-width units. Columns are clamped to the table. */
export function cellOf(x: number, y: number, cells: number): { col: number; row: number } {
  return { col: clamp(Math.floor(x * cells), 0, cells - 1), row: Math.floor(y * cells) };
}

/** Centre of a grid cell, in table-width units. */
export function cellCenter(col: number, row: number, cells: number): Vec {
  return { x: (col + 0.5) / cells, y: (row + 0.5) / cells };
}

export type Bumper = { id: string; type: 'bumper'; x: number; y: number; r: number; power: number };

/**
 * Whether a bumper of radius `r` may go in this cell: on the grid, off the spawn row, clear
 * of the lane band (a bumper there would sit in the flippers), and not overlapping another.
 */
export function canPlace(
  col: number,
  row: number,
  items: Bumper[],
  cells: number,
  aspect: number,
  laneDepth: number,
  r: number,
): boolean {
  if (col < 0 || col >= cells || row < 1 || row >= aspect * cells) return false;
  const c = cellCenter(col, row, cells);
  if (c.y + r > aspect - laneDepth) return false;
  return items.every((it) => Math.hypot(it.x - c.x, it.y - c.y) >= it.r + r - 1e-9);
}

export type Layout = {
  v: 1;
  units: 'tw';
  aspect: number;
  grid: number;
  items: Bumper[];
};

/** The persisted form of a table. Positions are table-width units, so it fits any phone. */
export function serializeLayout(items: Bumper[], aspect: number, grid: number): Layout {
  return { v: 1, units: 'tw', aspect, grid, items };
}

/**
 * Read a stored layout, trusting nothing.
 *
 * `valid: false` means the blob is not a v1 layout at all — the caller should keep it aside
 * rather than overwrite it, because it is someone's hand-built table. Inside a valid
 * layout, unknown part types are skipped (later deliverables add pads and more),
 * malformed bumpers are dropped, the rest are clamped onto the table, and duplicate ids
 * keep the first.
 */
export function parseLayout(raw: unknown, aspect: number): { valid: boolean; items: Bumper[] } {
  if (raw === null || typeof raw !== 'object') return { valid: false, items: [] };
  const layout = raw as Record<string, unknown>;
  if (layout.v !== 1 || !Array.isArray(layout.items)) return { valid: false, items: [] };

  const items: Bumper[] = [];
  const seen = new Set<string>();
  for (const entry of layout.items) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== 'bumper' || typeof e.id !== 'string' || seen.has(e.id)) continue;
    const nums = [e.x, e.y, e.r, e.power];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const r = clamp(e.r as number, 0.02, 0.2);
    items.push({
      id: e.id,
      type: 'bumper',
      x: clamp(e.x as number, r, 1 - r),
      y: clamp(e.y as number, r, aspect - r),
      r,
      power: clamp(e.power as number, 0.5, 2),
    });
    seen.add(e.id);
  }
  return { valid: true, items };
}
