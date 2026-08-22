/**
 * Appear-animation compiler.
 *
 * This is the heart of the exporter. Framer ships entry animations as a
 * declarative JSON map in `<script type="framer/appear">`, keyed by the
 * `data-framer-appear-id` attribute on the element. The initial state is ALSO
 * written into the element's inline style as `opacity:0.001` plus a transform.
 *
 * That inline state is the trap: strip Framer's runtime without compiling the
 * JSON and every animated element stays permanently invisible. So this module
 * does two things together, and they must stay together:
 *
 *   1. compile the JSON into CSS keyframes, and
 *   2. neutralise the inline initial state so the CSS is what drives the element.
 *
 * Breakpoint scoping matters just as much. An id may carry per-breakpoint
 * variants keyed by hash, and Framer's own animator scopes them as
 * `:not(.hidden-<hash>) [data-framer-appear-id="<id>"]`. Collapsing everything
 * to `default` leaves elements hidden on every breakpoint it forgot.
 */

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { AppearSpec, AppearState, AppearVariant, Breakpoint } from './types.js';
import { toCssEasing, toCssDuration, toCssDelay } from './easing.js';
import { DEFAULT_VARIANT, breakpointsForDefault, mediaQueryFor } from './breakpoints.js';

export const APPEAR_ATTR = 'data-framer-appear-id';

/** Inline properties that encode the pre-animation state and must be removed. */
const INITIAL_STATE_PROPS = new Set(['opacity', 'transform', 'will-change']);

/** Read and parse `<script type="framer/appear">`. Returns {} when absent. */
export function parseAppearSpec($: CheerioAPI): AppearSpec {
  const raw = $('script[type="framer/appear"]').first().contents().text().trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AppearSpec) : {};
  } catch {
    return {};
  }
}

/**
 * Build a CSS transform from a Motion state.
 *
 * Order follows Motion's own `buildTransform`: perspective, translate, scale,
 * rotate, skew. Emitting these in a different order produces subtly different
 * matrices for combined transforms.
 */
export function buildTransform(state: AppearState | undefined): string {
  if (!state) return 'none';
  const parts: string[] = [];

  if (state.transformPerspective) parts.push(`perspective(${state.transformPerspective}px)`);
  if (state.x) parts.push(`translateX(${state.x}px)`);
  if (state.y) parts.push(`translateY(${state.y}px)`);
  if (state.z) parts.push(`translateZ(${state.z}px)`);
  if (state.scale !== undefined && state.scale !== 1) parts.push(`scale(${state.scale})`);
  if (state.rotate) parts.push(`rotate(${state.rotate}deg)`);
  if (state.rotateX) parts.push(`rotateX(${state.rotateX}deg)`);
  if (state.rotateY) parts.push(`rotateY(${state.rotateY}deg)`);
  if (state.skewX) parts.push(`skewX(${state.skewX}deg)`);
  if (state.skewY) parts.push(`skewY(${state.skewY}deg)`);

  return parts.length ? parts.join(' ') : 'none';
}

function opacityOf(state: AppearState | undefined, fallback: number): number {
  return typeof state?.opacity === 'number' ? state.opacity : fallback;
}

/** CSS-safe identifier fragment. */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

interface CompiledRule {
  keyframes: string;
  rule: string;
}

/** Compile one (id, variant) pair into a keyframes block plus its scoped rule. */
function compileVariant(
  id: string,
  variantKey: string,
  variant: AppearVariant,
  scopeHash: string | undefined,
  mediaQuery: string | undefined,
): CompiledRule | null {
  const { initial, animate } = variant;
  if (!initial && !animate) return null;

  const transition = animate?.transition;
  const name = `fx-${safe(id)}-${safe(variantKey)}`;

  const fromOpacity = opacityOf(initial, 1);
  const toOpacity = opacityOf(animate, 1);
  const fromTransform = buildTransform(initial);
  const toTransform = buildTransform(animate);

  const keyframes =
    `@keyframes ${name}{` +
    `from{opacity:${fromOpacity};transform:${fromTransform}}` +
    `to{opacity:${toOpacity};transform:${toTransform}}` +
    `}`;

  const duration = toCssDuration(transition);
  const delay = toCssDelay(transition);
  const easing = toCssEasing(transition);

  // The media query is what actually selects the right variant; the copies for
  // other breakpoints are `display:none` via their `.hidden-<hash>` classes.
  //
  // `:not(.hidden-<hash>)` mirrors Framer's own runtime selector and is kept for
  // parity, but note it does NOT narrow the match in CSS: a descendant
  // combinator matches if ANY ancestor qualifies, and <body> never carries the
  // class. It is harmless — the hidden copies are not rendered — but do not rely
  // on it for correctness.
  const scope = scopeHash ? `:not(.hidden-${scopeHash}) ` : '';
  const selector = `${scope}[${APPEAR_ATTR}="${id}"]`;
  const decl = `${selector}{animation:${name} ${duration}s ${easing} ${delay}s both}`;

  const rule = mediaQuery ? `@media ${mediaQuery}{${decl}}` : decl;
  return { keyframes, rule };
}

export interface CompileResult {
  css: string;
  rulesEmitted: number;
  idsCompiled: number;
  warnings: string[];
}

/**
 * Compile the whole appear spec to a stylesheet.
 *
 * An id with only a `default` variant is emitted unscoped, so it applies at
 * every width. An id with hashed variants is emitted once per breakpoint —
 * including the breakpoints that `default` implicitly covers.
 */
export function compileAppearCss(
  spec: AppearSpec,
  breakpoints: Breakpoint[],
  reducedMotion = true,
): CompileResult {
  const keyframes: string[] = [];
  const rules: string[] = [];
  const warnings: string[] = [];
  let idsCompiled = 0;

  for (const [id, variants] of Object.entries(spec)) {
    const variantKeys = Object.keys(variants);
    if (variantKeys.length === 0) continue;

    const explicit = variantKeys.filter((k) => k !== DEFAULT_VARIANT);
    let emittedForId = 0;

    if (explicit.length === 0) {
      // No responsive specialisation — one unscoped rule covers all widths.
      const compiled = compileVariant(id, DEFAULT_VARIANT, variants[DEFAULT_VARIANT], undefined, undefined);
      if (compiled) {
        keyframes.push(compiled.keyframes);
        rules.push(compiled.rule);
        emittedForId++;
      }
    } else {
      for (const hash of explicit) {
        const mq = mediaQueryFor(hash, breakpoints);
        if (!mq) {
          warnings.push(`Appear id "${id}" references unknown breakpoint hash "${hash}"; emitting unscoped.`);
        }
        const compiled = compileVariant(id, hash, variants[hash], mq ? hash : undefined, mq);
        if (compiled) {
          keyframes.push(compiled.keyframes);
          rules.push(compiled.rule);
          emittedForId++;
        }
      }

      // `default` covers whatever breakpoints have no explicit variant.
      const base = variants[DEFAULT_VARIANT];
      if (base) {
        const remaining = breakpointsForDefault(explicit, breakpoints);
        if (remaining.length === 0 && breakpoints.length > 0) {
          warnings.push(`Appear id "${id}" has a default variant with no breakpoint left to cover.`);
        }
        for (const bp of remaining) {
          const compiled = compileVariant(id, `${DEFAULT_VARIANT}-${bp.hash}`, base, bp.hash, bp.mediaQuery);
          if (compiled) {
            keyframes.push(compiled.keyframes);
            rules.push(compiled.rule);
            emittedForId++;
          }
        }
        // No breakpoint data at all: fall back to one unscoped rule so the
        // element still animates rather than staying hidden.
        if (breakpoints.length === 0) {
          const compiled = compileVariant(id, DEFAULT_VARIANT, base, undefined, undefined);
          if (compiled) {
            keyframes.push(compiled.keyframes);
            rules.push(compiled.rule);
            emittedForId++;
          }
        }
      }
    }

    if (emittedForId > 0) idsCompiled++;
  }

  // Safety net: if motion is reduced, or if anything above failed to match,
  // never leave an element stuck at its invisible initial state.
  const guard = reducedMotion
    ? `@media (prefers-reduced-motion:reduce){[${APPEAR_ATTR}]{animation:none!important;opacity:1!important;transform:none!important}}`
    : '';

  const css = [...keyframes, ...rules, guard].filter(Boolean).join('\n');

  return { css, rulesEmitted: rules.length, idsCompiled, warnings };
}

/**
 * Remove the inline pre-animation state from every animated element.
 *
 * Only `opacity`, `transform` and `will-change` are dropped — the same style
 * attribute often carries layout properties (`display:flex`, `flex-shrink`)
 * that the page genuinely needs, so a blanket attribute wipe would break it.
 *
 * Returns the number of elements touched.
 */
export function neutralizeInlineInitialState($: CheerioAPI): number {
  let touched = 0;

  $(`[${APPEAR_ATTR}]`).each((_, el) => {
    const $el = $(el) as Cheerio<AnyNode>;
    const style = $el.attr('style');
    if (!style) return;

    const kept = style
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => {
        const prop = d.slice(0, d.indexOf(':')).trim().toLowerCase();
        return !INITIAL_STATE_PROPS.has(prop);
      });

    if (kept.length === style.split(';').filter((s) => s.trim()).length) return;

    touched++;
    if (kept.length === 0) $el.removeAttr('style');
    else $el.attr('style', kept.join(';'));
  });

  return touched;
}

/**
 * When animations are intentionally not compiled, elements still must not be
 * left invisible. This drops the inline state and emits nothing else.
 */
export function forceVisibleCss(): string {
  return `[${APPEAR_ATTR}]{opacity:1!important;transform:none!important}`;
}
