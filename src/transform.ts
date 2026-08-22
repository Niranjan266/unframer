/**
 * Transform splitting.
 *
 * A Framer element's inline transform routinely mixes two unrelated things:
 *
 *   transform: translate(-50%, -50%) translateY(40px)
 *
 * `translate(-50%, -50%)` is *layout* — it is how the element is centred, and it
 * must hold for the element's whole life. `translateY(40px)` is *animation* —
 * the offset the element animates away from.
 *
 * Treating the whole declaration as animation state and resolving it to
 * `transform: none` on reveal is what silently destroys the centring, shifting
 * every affected element right by exactly half its own width. On one real site
 * that hit 59 elements and made the entire page look misaligned, while content
 * and pixel-diff checks still passed — position was the one thing nothing
 * measured.
 *
 * Percentage translates are the reliable signal: they resolve against the
 * element's own box, which is a layout concern. Framer expresses animation
 * offsets in px, degrees and unitless scale.
 */

/** A transform declaration split into the part that must persist and the part that animates. */
export interface SplitTransform {
  /** Layout transforms that must apply in every state, e.g. `translate(-50%, -50%)`. */
  layout: string;
  /** Animation transforms that the element moves away from, e.g. `translateY(40px)`. */
  animation: string;
}

/** Matches one transform function and its arguments. */
const FUNCTION_RE = /([a-zA-Z0-9]+)\s*\(([^()]*)\)/g;

/** CSS custom property holding an element's persistent layout transform. */
export const BASE_TRANSFORM_VAR = '--uf-base';

/**
 * Split a transform declaration into layout and animation halves.
 *
 * Classification is per function, not per argument: Framer emits centring and
 * motion as separate functions, so a function whose arguments contain a
 * percentage is treated as layout in full. That errs toward preserving
 * position, which is the failure that is visible to a person.
 */
export function splitTransform(value: string | undefined): SplitTransform {
  if (!value || value.trim() === '' || value.trim() === 'none') {
    return { layout: '', animation: '' };
  }

  const layout: string[] = [];
  const animation: string[] = [];

  FUNCTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FUNCTION_RE.exec(value)) !== null) {
    const [whole, name, args] = match;
    const isTranslate = /^translate/i.test(name);
    if (isTranslate && args.includes('%')) layout.push(whole.trim());
    else animation.push(whole.trim());
  }

  return { layout: layout.join(' '), animation: animation.join(' ') };
}

/**
 * Compose a transform value that keeps an element's layout transform intact.
 *
 * The layout half lives in a custom property on the element, so a rule shared
 * across many elements can still respect each one's own positioning:
 *
 *   transform: var(--uf-base,) translateY(40px);
 *
 * The empty fallback matters — an element with no layout transform resolves to
 * just the animation part rather than to an invalid declaration.
 */
export function composeTransform(animation: string): string {
  const anim = animation.trim();
  if (!anim) return `var(${BASE_TRANSFORM_VAR}, none)`;
  return `var(${BASE_TRANSFORM_VAR},) ${anim}`;
}

/** The settled transform: layout only, never `none` when layout exists. */
export function settledTransform(): string {
  return `var(${BASE_TRANSFORM_VAR}, none)`;
}
