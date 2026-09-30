/**
 * Generates the bundled sound effects into assets/.
 *
 *   node scripts/generate-sounds.mjs      (or: npm run sounds)
 *
 * Committed alongside its output so the WAVs are reproducible and reviewable rather
 * than opaque binaries of unknown origin. The RNG is seeded, so re-running produces
 * byte-identical files — a regenerate should show no diff.
 *
 * No dependencies: writes 16-bit mono PCM WAV by hand.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** Deterministic PRNG (mulberry32) so committed output never churns. */
const seededRandom = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Normalise to a target peak, then hard-guard against any residual overshoot. */
const normalise = (samples, peak = 0.89) => {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max === 0) return samples;
  const scale = peak / max;
  return samples.map((s) => Math.max(-1, Math.min(1, s * scale)));
};

/** Fade the last few ms to zero so the sample cannot end on a step (an audible tick). */
const fadeTail = (samples, ms = 4) => {
  const n = Math.min(Math.floor((SAMPLE_RATE * ms) / 1000), samples.length);
  for (let i = 0; i < n; i++) {
    samples[samples.length - n + i] *= 1 - i / n;
  }
  return samples;
};

const writeWav = (name, samples) => {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(samples[i] * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  const path = join(ASSETS, name);
  writeFileSync(path, Buffer.concat([header, data]));
  console.log(`  ${name.padEnd(14)} ${(header.length + data.length) / 1024 | 0} KB`);
};

/**
 * A percussive "thock" — what a ball hitting a wall should sound like.
 *
 * Three ingredients: a very short noise transient for the impact, a sine body whose
 * pitch drops as it decays (a fixed pitch sounds like a beep, not a knock), and an
 * exponential amplitude decay.
 */
const bounce = (baseFreq, seed) => {
  const rand = seededRandom(seed);
  const length = Math.floor(SAMPLE_RATE * 0.09);
  const out = new Array(length);

  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;

    // Pitch falls toward 55% of base — this is what reads as "knock" rather than "beep".
    const freq = baseFreq * (0.55 + 0.45 * Math.exp(-t * 55));
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;

    const body = Math.sin(phase) * Math.exp(-t * 42);

    // Impact transient: 3 ms of noise, linearly gone.
    const clickWindow = 0.003;
    const click = t < clickWindow ? (rand() * 2 - 1) * (1 - t / clickWindow) * 0.55 : 0;

    out[i] = body * 0.85 + click;
  }

  return fadeTail(normalise(out));
};

/**
 * A softer "whoosh" for the push/shake gesture — deliberately unlike the bounce so the
 * two events are tellable apart by ear.
 *
 * Lowpassed noise with a cutoff that opens then closes, and a short swell instead of an
 * instant attack, so it reads as a shove rather than an impact.
 */
const push = (cutoffHz, seed) => {
  const rand = seededRandom(seed);
  const length = Math.floor(SAMPLE_RATE * 0.16);
  const out = new Array(length);

  let lp = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / length;

    // One-pole lowpass whose cutoff sweeps up then back down.
    const sweep = Math.sin(Math.PI * progress);
    const cutoff = cutoffHz * (0.4 + 1.6 * sweep);
    const alpha = Math.min(1, (2 * Math.PI * cutoff) / SAMPLE_RATE);
    lp += alpha * (rand() * 2 - 1 - lp);

    const attack = 0.012;
    const env = t < attack ? t / attack : Math.exp(-(t - attack) * 26);

    out[i] = lp * env;
  }

  return fadeTail(normalise(out, 0.62)); // quieter than a bounce — it is a nudge, not a hit
};

mkdirSync(ASSETS, { recursive: true });
console.log('Generating sound effects into assets/');

writeWav('bounce-1.wav', bounce(420, 1));
writeWav('bounce-2.wav', bounce(520, 2));
writeWav('bounce-3.wav', bounce(640, 3));
writeWav('push-1.wav', push(900, 11));
writeWav('push-2.wav', push(1250, 12));

console.log('Done.');
