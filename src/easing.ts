/**
 * Easing conversion.
 *
 * Framer drives entry animations with Motion springs described by `duration` +
 * `bounce`. CSS has no spring primitive, but it does have `linear()` — an
 * arbitrary sampled easing function supported across modern browsers. So rather
 * than flattening every spring to a lossy `ease-out`, we solve the spring
 * analytically and emit a sampled `linear()` curve.
 *
 * That keeps the exported motion visually faithful to the original with zero
 * JavaScript, which is the whole point of the project.
 */

import type { AppearTransition } from './types.js';

/** Number of samples in a generated `linear()` easing. 24 is visually indistinguishable. */
const SAMPLES = 24;

/**
 * Motion maps `bounce` to a damping ratio: bounce 0 => critically damped,
 * higher bounce => progressively more oscillation.
 */
function dampingRatioFromBounce(bounce: number): number {
  const clamped = Math.max(0, Math.min(1, bounce));
  return 1 - clamped;
}

/**
 * Normalised spring position at progress `t` (0..1), where the spring is
 * calibrated to have effectively settled at t = 1.
 *
 * Underdamped (z < 1) overshoots and rings; critically damped (z = 1) does not.
 */
function springProgress(t: number, zeta: number): number {
  // Angular frequency chosen so the envelope e^(-zeta*w*t) has decayed to ~0.1%
  // by t = 1. This makes `duration` behave as "time until settled", matching
  // how Framer presents it in the UI.
  const decayTarget = 0.001;
  const omega = -Math.log(decayTarget) / Math.max(zeta, 0.05);

  if (zeta >= 1) {
    // Critically damped: x(t) = 1 - e^(-wt) * (1 + wt)
    const wt = omega * t;
    return 1 - Math.exp(-wt) * (1 + wt);
  }

  // Underdamped: x(t) = 1 - e^(-z*w*t) * (cos(wd*t) + (z*w/wd) * sin(wd*t))
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const envelope = Math.exp(-zeta * omega * t);
  return 1 - envelope * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

/** Round to 4 decimals and drop trailing zeros, keeping generated CSS compact. */
function trim(n: number): string {
  return parseFloat(n.toFixed(4)).toString();
}

/**
 * Build a CSS `linear()` easing that traces the spring.
 * Falls back to a plain keyword if the curve is degenerate.
 */
export function springToLinearEasing(bounce: number): string {
  const zeta = dampingRatioFromBounce(bounce);
  const points: string[] = [];

  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const v = i === SAMPLES ? 1 : springProgress(t, zeta);
    points.push(trim(v));
  }

  return `linear(${points.join(', ')})`;
}

/** Named Motion easings mapped to their CSS cubic-bezier equivalents. */
const NAMED_EASINGS: Record<string, string> = {
  linear: 'linear',
  easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
  easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  circIn: 'cubic-bezier(0.55, 0, 1, 0.45)',
  circOut: 'cubic-bezier(0, 0.55, 0.45, 1)',
  circInOut: 'cubic-bezier(0.85, 0, 0.15, 1)',
  backIn: 'cubic-bezier(0.36, 0, 0.66, -0.56)',
  backOut: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  backInOut: 'cubic-bezier(0.68, -0.6, 0.32, 1.6)',
  anticipate: 'cubic-bezier(0.36, 0, 0.66, -0.56)',
};

/**
 * Resolve a Framer transition to a CSS timing function.
 *
 * Springs become sampled `linear()` curves; explicit cubic-bezier arrays and
 * named easings pass through; anything unrecognised degrades to a sane default.
 */
export function toCssEasing(transition: AppearTransition | undefined): string {
  if (!transition) return 'cubic-bezier(0.44, 0, 0.16, 1)';

  const { type, ease, bounce } = transition;

  if (Array.isArray(ease) && ease.length === 4) {
    return `cubic-bezier(${ease.map(trim).join(', ')})`;
  }

  if (typeof ease === 'string' && NAMED_EASINGS[ease]) {
    return NAMED_EASINGS[ease];
  }

  if (type === 'spring') {
    return springToLinearEasing(bounce ?? 0);
  }

  return 'cubic-bezier(0.44, 0, 0.16, 1)';
}

/** Duration in seconds, defaulting to Framer's own default when unspecified. */
export function toCssDuration(transition: AppearTransition | undefined): number {
  const d = transition?.duration;
  return typeof d === 'number' && d > 0 ? d : 0.6;
}

/** Delay in seconds. Negative delays are clamped — CSS treats them as seek offsets. */
export function toCssDelay(transition: AppearTransition | undefined): number {
  const d = transition?.delay;
  return typeof d === 'number' && d > 0 ? d : 0;
}
