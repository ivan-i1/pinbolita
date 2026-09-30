import {
  FRAME_MS,
  applyRest,
  capSpeed,
  frameScale,
  impactGain,
  impulseAwayFrom,
  frictionRetention,
  isShake,
  nextHue,
  swipeLaunch,
  pickVariant,
  stepGravity,
  tiltPitch,
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

describe('applyRest', () => {
  it('stops a crawling ball dead when the phone is flat', () => {
    expect(applyRest(0.01, -0.02, 0.001, 0.08, 0.045)).toEqual({ x: 0, y: 0 });
  });

  it('leaves a crawling ball moving if the phone is tilted', () => {
    expect(applyRest(0.01, -0.02, 0.9, 0.08, 0.045)).toEqual({ x: 0.01, y: -0.02 });
  });

  it('never stops a ball that is actually moving', () => {
    expect(applyRest(5, 5, 0.001, 0.08, 0.045)).toEqual({ x: 5, y: 5 });
  });

  it('uses a strict threshold — exactly at the epsilon it keeps moving', () => {
    const v = applyRest(0.08, 0, 0, 0.08, 0.045);
    expect(v).toEqual({ x: 0.08, y: 0 });
  });
});

describe('stepGravity', () => {
  it('snaps straight to the sample when lerp is 1', () => {
    expect(stepGravity(0, 0, 0.5, -1, 1)).toEqual({ x: 0.5, y: -1 });
  });

  it('ignores the sample entirely when lerp is 0', () => {
    expect(stepGravity(0.3, 0.4, 9, 9, 0)).toEqual({ x: 0.3, y: 0.4 });
  });

  it('moves halfway when lerp is 0.5', () => {
    const g = stepGravity(0, 0, 1, -1, 0.5);
    expect(g.x).toBeCloseTo(0.5, 6);
    expect(g.y).toBeCloseTo(-0.5, 6);
  });

  it('converges on a steady orientation after repeated samples', () => {
    let g = { x: 0, y: 0 };
    for (let i = 0; i < 200; i++) g = stepGravity(g.x, g.y, 0, -1, 0.08);
    expect(g.y).toBeCloseTo(-1, 3);
    expect(g.x).toBeCloseTo(0, 3);
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
describe('isShake', () => {
  const RES = 0.15;
  const MAG = 0.12;

  it('rejects a tilt: big residual, but magnitude still 1g', () => {
    expect(isShake(0.4, 0.3, 1.0, RES, MAG)).toBe(false);
  });

  it('accepts a shake: big residual and magnitude well off 1g', () => {
    expect(isShake(0.4, 0.3, 1.5, RES, MAG)).toBe(true);
  });

  it('rejects a shake that is too gentle, however far off 1g', () => {
    expect(isShake(0.02, 0.01, 1.9, RES, MAG)).toBe(false);
  });

  it('accepts acceleration below 1g too — free-fall is movement', () => {
    expect(isShake(0.4, 0.3, 0.4, RES, MAG)).toBe(true);
  });

  it('is strict at both thresholds — exactly at them is not a shake', () => {
    expect(isShake(RES, 0, 1 + MAG, RES, MAG)).toBe(false);
  });

  it('holds across a whole simulated tilt sweep', () => {
    // Rotate from flat to upright; gravity lags, so residuals are large throughout,
    // but the magnitude never leaves 1g. Not one sample may read as a shake.
    let gx = 0;
    for (let deg = 0; deg <= 90; deg += 2) {
      const rad = (deg * Math.PI) / 180;
      const x = Math.sin(rad);
      gx += (x - gx) * 0.08; // the same lerp the app uses
      expect(isShake(x - gx, 0, 1.0, RES, MAG)).toBe(false);
    }
  });
});

describe('tiltPitch', () => {
  const RISE = 0.8;

  it('is the base pitch when the phone is flat', () => {
    expect(tiltPitch(0, 1, 0.6, RISE)).toBeCloseTo(1);
  });

  it('rises with tilt', () => {
    expect(tiltPitch(1, 1, 1, RISE)).toBeCloseTo(1 + RISE);
  });

  it('an amount of 0 disables the effect entirely', () => {
    expect(tiltPitch(1, 1, 0, RISE)).toBeCloseTo(1);
  });

  it('scales with the base pitch', () => {
    expect(tiltPitch(0, 1.5, 0.6, RISE)).toBeCloseTo(1.5);
  });

  it('is monotonic in tilt', () => {
    const a = tiltPitch(0.2, 1, 0.6, RISE);
    const b = tiltPitch(0.7, 1, 0.6, RISE);
    expect(b).toBeGreaterThan(a);
  });

  it('clamps tilt outside 0..1 rather than running away', () => {
    expect(tiltPitch(4, 1, 1, RISE)).toBeCloseTo(1 + RISE);
    expect(tiltPitch(-2, 1, 1, RISE)).toBeCloseTo(1);
  });
});

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
