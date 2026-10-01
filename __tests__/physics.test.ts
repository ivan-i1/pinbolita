import {
  FRAME_MS,
  capSpeed,
  frameScale,
  impactGain,
  impulseAwayFrom,
  frictionRetention,
  nextHue,
  swipeLaunch,
  pickVariant,
  stepBall,
  catchFraction,
  laneOf,
  laneAfterLaunch,
  laneTick,
  canSwipeCatch,
  laneRetention,
  laneVisual,
  mixColor,
  launchArrow,
  bandOf,
  hasFallenOut,
  type Lane,
  type Rng,
} from '../game/physics';

/** Deterministic rng stub: replays the given values, then repeats the last one. */
const rngOf = (...values: number[]): Rng => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const hypot = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

describe('frameScale', () => {
  it('is exactly 1 at the 60Hz baseline, so existing tuning is unchanged', () => {
    expect(frameScale(FRAME_MS)).toBeCloseTo(1, 5);
  });

  it('halves at 120Hz so the ball covers the same ground per second', () => {
    expect(frameScale(FRAME_MS / 2)).toBeCloseTo(0.5, 5);
  });

  it('doubles at 30Hz', () => {
    expect(frameScale(FRAME_MS * 2)).toBeCloseTo(2, 5);
  });

  it('clamps a long stall so the ball cannot teleport through a wall', () => {
    expect(frameScale(1000)).toBe(2);
  });

  it('clamps absurdly short frames to the lower bound', () => {
    expect(frameScale(1)).toBe(0.5);
  });

  it('falls back to 1 for the first frame and for junk input', () => {
    expect(frameScale(0)).toBe(1);
    expect(frameScale(-5)).toBe(1);
    expect(frameScale(NaN)).toBe(1);
    expect(frameScale(Infinity)).toBe(1);
  });
});

describe('impulseAwayFrom', () => {
  const rng = rngOf(0.25);

  it('pushes the ball RIGHT when the tap is to its left', () => {
    const v = impulseAwayFrom(100, 100, 40, 100, 9, rng);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeCloseTo(0, 6);
  });

  it('pushes the ball LEFT when the tap is to its right', () => {
    const v = impulseAwayFrom(100, 100, 160, 100, 9, rng);
    expect(v.x).toBeLessThan(0);
  });

  it('pushes the ball DOWN when the tap is above it (screen y grows downward)', () => {
    const v = impulseAwayFrom(100, 100, 100, 40, 9, rng);
    expect(v.y).toBeGreaterThan(0);
    expect(v.x).toBeCloseTo(0, 6);
  });

  it('pushes the ball UP when the tap is below it', () => {
    const v = impulseAwayFrom(100, 100, 100, 160, 9, rng);
    expect(v.y).toBeLessThan(0);
  });

  it('always applies the full magnitude regardless of tap distance', () => {
    expect(hypot(impulseAwayFrom(100, 100, 99, 100, 9, rng))).toBeCloseTo(9, 6);
    expect(hypot(impulseAwayFrom(100, 100, -500, 100, 9, rng))).toBeCloseTo(9, 6);
  });

  it('splits a diagonal tap evenly', () => {
    const v = impulseAwayFrom(100, 100, 90, 90, 10, rng);
    expect(v.x).toBeCloseTo(v.y, 6);
    expect(hypot(v)).toBeCloseTo(10, 6);
  });

  // Rainy path: tapping the ball's exact centre gives a zero direction vector.
  it('falls back to a random direction when the tap lands dead centre, never NaN', () => {
    const v = impulseAwayFrom(100, 100, 100, 100, 9, rngOf(0), 1);
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(hypot(v)).toBeCloseTo(9, 6);
  });

  it('uses the random fallback for any tap inside minDistance', () => {
    const v = impulseAwayFrom(100, 100, 100.4, 99.7, 9, rngOf(0.75), 1);
    expect(hypot(v)).toBeCloseTo(9, 6);
  });
});

describe('capSpeed', () => {
  it('leaves a slow ball alone', () => {
    expect(capSpeed(3, 4, 40)).toEqual({ x: 3, y: 4 });
  });

  it('clamps a runaway shake to exactly the cap', () => {
    expect(hypot(capSpeed(300, 400, 40))).toBeCloseTo(40, 6);
  });

  it('preserves direction while clamping', () => {
    const v = capSpeed(300, 400, 40);
    expect(v.x / v.y).toBeCloseTo(300 / 400, 6);
  });

  it('handles a stationary ball without dividing by zero', () => {
    const v = capSpeed(0, 0, 40);
    expect(v).toEqual({ x: 0, y: 0 });
  });
});

describe('impactGain', () => {
  it('floors a feather-light graze at the minimum gain', () => {
    expect(impactGain(0, 14, 0.25)).toBeCloseTo(0.25, 6);
  });

  it('reaches full volume at the loud threshold', () => {
    expect(impactGain(14, 14, 0.25)).toBeCloseTo(1, 6);
  });

  it('never exceeds full volume however hard the slam', () => {
    expect(impactGain(9999, 14, 0.25)).toBe(1);
  });

  it('is louder for a harder hit', () => {
    expect(impactGain(10, 14, 0.25)).toBeGreaterThan(impactGain(5, 14, 0.25));
  });
});

describe('pickVariant', () => {
  it('returns the only variant when there is just one', () => {
    expect(pickVariant(1, 0, rngOf(0))).toBe(0);
  });

  it('never repeats the previous variant', () => {
    for (let i = 0; i <= 10; i++) {
      const r = i / 10 - 1e-9;
      expect(pickVariant(3, 1, rngOf(Math.max(r, 0)))).not.toBe(1);
    }
  });

  it('always returns an in-range index', () => {
    for (let i = 0; i <= 10; i++) {
      const idx = pickVariant(3, 2, rngOf(Math.min(i / 10, 0.999)));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  it('can return any variant when there is no previous one', () => {
    expect(pickVariant(3, -1, rngOf(0))).toBe(0);
    expect(pickVariant(3, -1, rngOf(0.99))).toBe(2);
  });

  it('reaches every other variant across the rng range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(pickVariant(3, 0, rngOf(i / 100)));
    expect(seen).toEqual(new Set([1, 2]));
  });
});

// A sustained tilt was being read as a shake: the gravity estimate lags the raw sample
// by GRAVITY_LERP per frame, so the residual stays large for the whole rotation. These
// pin the extra test that tells the two apart — rotating the phone keeps total
// acceleration at ~1g, while actually moving it does not.
describe('nextHue', () => {
  const seq = (values: number[]): Rng => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it('returns a hue inside 0..360', () => {
    const h = nextHue(0, seq([0.5]), 60);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });

  it('never lands within the minimum separation of the previous hue', () => {
    for (let i = 0; i <= 20; i++) {
      const h = nextHue(100, seq([i / 20]), 60);
      const gap = Math.min(Math.abs(h - 100), 360 - Math.abs(h - 100));
      expect(gap).toBeGreaterThanOrEqual(60 - 1e-9);
    }
  });

  it('can reach hues either side of the previous one', () => {
    const lo = nextHue(180, seq([0]), 60);
    const hi = nextHue(180, seq([0.999]), 60);
    expect(lo).not.toBeCloseTo(hi);
  });
});

// The slider said "Friction" but wrote a velocity *retention* factor, so turning it up
// made the ball slipperier. These pin the corrected direction.
describe('frictionRetention', () => {
  const LOSS = 0.02;

  it('zero friction keeps all velocity — the ball never slows', () => {
    expect(frictionRetention(0, LOSS)).toBeCloseTo(1);
  });

  it('full friction loses the most', () => {
    expect(frictionRetention(1, LOSS)).toBeCloseTo(1 - LOSS);
  });

  it('is DECREASING in friction — more friction must retain less', () => {
    expect(frictionRetention(0.75, LOSS)).toBeLessThan(frictionRetention(0.25, LOSS));
  });

  it('preserves the hand-tuned 0.995 at the default quarter stop', () => {
    expect(frictionRetention(0.25, LOSS)).toBeCloseTo(0.995);
  });

  it('clamps out-of-range input rather than producing a rate above 1', () => {
    expect(frictionRetention(-1, LOSS)).toBeCloseTo(1);
    expect(frictionRetention(9, LOSS)).toBeCloseTo(1 - LOSS);
  });
});

describe('swipeLaunch', () => {
  const MIN = 20;
  const GAIN = 0.08;

  it('returns null below the minimum distance, so a tap can take over', () => {
    expect(swipeLaunch(4, 3, MIN, GAIN, 40)).toBeNull();
  });

  it('launches along the swipe direction', () => {
    const v = swipeLaunch(100, 0, MIN, GAIN, 40)!;
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeCloseTo(0);
  });

  it('launches downward for a downward swipe — screen y grows down', () => {
    const v = swipeLaunch(0, 100, MIN, GAIN, 40)!;
    expect(v.y).toBeGreaterThan(0);
  });

  it('a longer swipe launches harder', () => {
    const slow = swipeLaunch(40, 0, MIN, GAIN, 40)!;
    const fast = swipeLaunch(160, 0, MIN, GAIN, 40)!;
    expect(Math.hypot(fast.x, fast.y)).toBeGreaterThan(Math.hypot(slow.x, slow.y));
  });

  it('never exceeds the speed cap however long the swipe', () => {
    const v = swipeLaunch(5000, 5000, MIN, GAIN, 40)!;
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(40 + 1e-9);
  });

  it('exactly at the minimum distance is still a tap, not a launch', () => {
    expect(swipeLaunch(MIN, 0, MIN, GAIN, 40)).toBeNull();
  });

  it('preserves direction after the cap is applied', () => {
    const v = swipeLaunch(3000, 4000, MIN, GAIN, 40)!;
    expect(v.y / v.x).toBeCloseTo(4 / 3);
  });
});

describe('stepBall', () => {
  const at = (x: number, y: number, vx = 0, vy = 0) => ({ x, y, vx, vy });

  it('starts a ball at rest falling under a weak pull, even at 120Hz', () => {
    // The engine's rest clamp zeroed any speed under 0.08 px/frame, so a pull this weak
    // left a respawned ball hanging in mid-air forever. There is no clamp any more.
    const next = stepBall(at(100, 100), 0.05, 0.5, 0.995, 40);
    expect(next.vy).toBeGreaterThan(0);
    expect(next.y).toBeGreaterThan(100);
  });

  it('keeps accelerating a ball under a constant pull', () => {
    let ball = at(0, 0);
    const speeds: number[] = [];
    for (let i = 0; i < 5; i++) {
      ball = stepBall(ball, 0.2, 1, 0.995, 40);
      speeds.push(ball.vy);
    }
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
  });

  it('pulls only downward — sideways velocity just decays', () => {
    const next = stepBall(at(0, 0, 10, 0), 0.2, 1, 0.9, 40);
    expect(next.vx).toBeCloseTo(9, 5);
    expect(next.vy).toBeGreaterThan(0);
  });

  it('never exceeds the speed cap', () => {
    const next = stepBall(at(0, 0, 0, 39.9), 5, 1, 1, 40);
    expect(Math.hypot(next.vx, next.vy)).toBeCloseTo(40, 5);
  });

  it('covers the same ground per second at 60Hz and 120Hz', () => {
    let a = at(0, 0, 0, 10);
    let b = at(0, 0, 0, 10);
    for (let i = 0; i < 60; i++) a = stepBall(a, 0, 1, 1, 40);
    for (let i = 0; i < 120; i++) b = stepBall(b, 0, 0.5, 1, 40);
    expect(b.y).toBeCloseTo(a.y, 5);
  });
});

describe('catchFraction', () => {
  const r = 10;

  it('is 0 while the ball is wholly above the band edge', () => {
    expect(catchFraction(100 - r - 1, 100, r)).toBe(0);
  });

  it('is 1 once the ball is wholly inside the band', () => {
    expect(catchFraction(100 + r + 1, 100, r)).toBe(1);
  });

  it('is exactly half when the centre sits on the edge', () => {
    expect(catchFraction(100, 100, r)).toBeCloseTo(0.5, 10);
  });

  it('reaches 35% with the centre still 0.238r above the edge', () => {
    // Solved numerically in the design loop: the leading edge has gone 0.762r into the
    // band while the centre is still outside it.
    expect(catchFraction(100 - 0.2379 * r, 100, r)).toBeCloseTo(0.35, 3);
  });

  it('grows as the ball sinks into the band', () => {
    let last = -1;
    for (let y = 85; y <= 115; y += 1) {
      const f = catchFraction(y, 100, r);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });
});

describe('laneOf', () => {
  it('puts every x in lane 0 when there is one lane', () => {
    expect(laneOf(0, 400, 1)).toBe(0);
    expect(laneOf(399, 400, 1)).toBe(0);
  });

  it('splits the width into equal lanes, left to right', () => {
    expect(laneOf(50, 400, 4)).toBe(0);
    expect(laneOf(150, 400, 4)).toBe(1);
    expect(laneOf(250, 400, 4)).toBe(2);
    expect(laneOf(350, 400, 4)).toBe(3);
  });

  it('assigns a centre exactly on a boundary to exactly one lane', () => {
    expect(laneOf(200, 400, 2)).toBe(1);
  });

  it('clamps positions outside the table to the edge lanes', () => {
    expect(laneOf(-5, 400, 2)).toBe(0);
    expect(laneOf(400, 400, 2)).toBe(1);
  });
});

describe('lane state', () => {
  const ready: Lane = { phase: 'ready', readyAt: 0 };
  const coolingUntil = (readyAt: number): Lane => ({ phase: 'cooldown', readyAt });

  it('launching starts the lane on its own cooldown', () => {
    expect(laneAfterLaunch(ready, 1000, 1500)).toEqual({ phase: 'cooldown', readyAt: 2500 });
  });

  it('a launch caught inside the leniency window restarts the cooldown', () => {
    expect(laneAfterLaunch(coolingUntil(1200), 1000, 1500)).toEqual(coolingUntil(2500));
  });

  it('comes back ready once the cooldown has elapsed, not before', () => {
    expect(laneTick(coolingUntil(2500), 2499).phase).toBe('cooldown');
    expect(laneTick(coolingUntil(2500), 2500).phase).toBe('ready');
  });

  it('a ready lane can always stop the ball for a swipe', () => {
    expect(canSwipeCatch(ready, 0, 500)).toBe(true);
  });

  it('a cooling lane cannot, until the last leniency window of its cooldown', () => {
    expect(canSwipeCatch(coolingUntil(2500), 1999, 500)).toBe(false);
    expect(canSwipeCatch(coolingUntil(2500), 2000, 500)).toBe(true);
  });

  it('a ready lane is the most viscous, a cooling lane less so', () => {
    expect(laneRetention(ready, 0.8, 0.95)).toBe(0.8);
    expect(laneRetention(coolingUntil(9), 0.8, 0.95)).toBe(0.95);
  });
});

describe('viscous band', () => {
  it('bleeds a fast ball down to the terminal speed pull·r/(1−r)', () => {
    let ball = { x: 0, y: 0, vx: 0, vy: 10 };
    for (let i = 0; i < 200; i++) ball = stepBall(ball, 0.2, 1, 0.8, 40);
    expect(ball.vy).toBeCloseTo((0.2 * 0.8) / 0.2, 5);
  });
});

describe('laneVisual', () => {
  const ready: Lane = { phase: 'ready', readyAt: 0 };

  it('is standby while ready with no ball in it', () => {
    expect(laneVisual(ready, 0, 1500, false)).toEqual({ kind: 'standby', progress: 1 });
  });

  it('is holding while ready with the ball in it', () => {
    expect(laneVisual(ready, 0, 1500, true)).toEqual({ kind: 'holding', progress: 1 });
  });

  it('shows how far the cooldown has run, ball or no ball', () => {
    const lane: Lane = { phase: 'cooldown', readyAt: 2500 };
    expect(laneVisual(lane, 1000, 1500, false)).toEqual({ kind: 'cooldown', progress: 0 });
    expect(laneVisual(lane, 1750, 1500, true).progress).toBeCloseTo(0.5, 10);
    expect(laneVisual(lane, 2499, 1500, false).progress).toBeLessThan(1);
  });

  it('never reports progress outside 0..1', () => {
    const lane: Lane = { phase: 'cooldown', readyAt: 2500 };
    expect(laneVisual(lane, 0, 1500, false).progress).toBe(0);
  });
});

describe('mixColor', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(mixColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('blends channel by channel', () => {
    expect(mixColor('#000000', '#ff8040', 0.5)).toBe('#804020');
  });

  it('clamps t outside 0..1', () => {
    expect(mixColor('#102030', '#405060', 2)).toBe('#405060');
  });
});

describe('launchArrow', () => {
  it('shows nothing for a drag too short to launch', () => {
    expect(launchArrow(0, -10, 20, 0.09, 40, 4)).toBeNull();
  });

  it('points the way the ball will go, any direction — the drain included', () => {
    expect(launchArrow(0, -100, 20, 0.09, 40, 4)!.angle).toBeCloseTo(-Math.PI / 2, 10);
    expect(launchArrow(0, 100, 20, 0.09, 40, 4)!.angle).toBeCloseTo(Math.PI / 2, 10);
  });

  it('grows with the drag and stops growing at the launch cap', () => {
    const short = launchArrow(0, -100, 20, 0.09, 40, 4)!;
    const long = launchArrow(0, -300, 20, 0.09, 40, 4)!;
    const huge = launchArrow(0, -3000, 20, 0.09, 40, 4)!;
    expect(long.length).toBeGreaterThan(short.length);
    expect(huge.length).toBeCloseTo(40 * 4, 10);
  });
});

describe('bandOf', () => {
  // 1000 tall: top band 0..150, bottom band 780..1000, dead strip below 952.
  const band = (y: number) => bandOf(y, 1000, 0.15, 0.22, 48);

  it('classifies the three horizontal bands', () => {
    expect(band(10)).toBe('top');
    expect(band(500)).toBe('middle');
    expect(band(900)).toBe('bottom');
  });

  it("refuses a touch starting in Android's bottom gesture strip", () => {
    expect(band(960)).toBe('none');
  });

  it('places the band edges exactly on the fractions', () => {
    expect(band(149.9)).toBe('top');
    expect(band(150)).toBe('middle');
    expect(band(780)).toBe('middle');
    expect(band(780.1)).toBe('bottom');
  });
});

describe('hasFallenOut', () => {
  it('is false while any part of the ball is still on the table', () => {
    expect(hasFallenOut(1005, 10, 1000)).toBe(false);
  });

  it('is true once the whole ball has passed the bottom edge', () => {
    expect(hasFallenOut(1010.1, 10, 1000)).toBe(true);
  });
});
