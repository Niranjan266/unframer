/** Shared types for the Unframer extraction pipeline. */

/** One responsive breakpoint as published by Framer in `#__framer__breakpoints`. */
export interface Breakpoint {
  /** Short hash, e.g. "1p4axj2". Matches the `.hidden-<hash>` class in the breakpoint stylesheet. */
  hash: string;
  /** Raw media query, e.g. "(max-width: 809px)". */
  mediaQuery: string;
}

/** A single animation state (the `initial` or `animate` half of a variant). */
export interface AppearState {
  opacity?: number;
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  rotate?: number;
  rotateX?: number;
  rotateY?: number;
  skewX?: number;
  skewY?: number;
  transformPerspective?: number;
  transition?: AppearTransition;
}

/** Framer/Motion transition descriptor. */
export interface AppearTransition {
  type?: 'spring' | 'tween' | string;
  duration?: number;
  delay?: number;
  bounce?: number;
  ease?: number[] | string;
  stiffness?: number;
  damping?: number;
  mass?: number;
}

export interface AppearVariant {
  initial?: AppearState;
  animate?: AppearState;
}

/**
 * The full appear spec: element id -> variant key -> states.
 * The variant key is either "default" or a breakpoint hash.
 */
export type AppearSpec = Record<string, Record<string, AppearVariant>>;

export type AssetMode = 'hotlink' | 'offline';

export interface ExtractOptions {
  /** How to resolve framerusercontent assets. Phase 01 implements `hotlink`. */
  assetMode: AssetMode;
  /** Compile appear animations to CSS. When false, elements are simply made visible. */
  compileAnimations: boolean;
  /** Emit a prefers-reduced-motion escape hatch. */
  reducedMotion: boolean;
  /**
   * Reconstruct interactions Framer's runtime used to drive (scroll reveals,
   * tickers). Disabling forces every hidden element visible instead — safe, but
   * static.
   */
  interactions: boolean;
  /**
   * Keep Framer's own runtime bundle instead of stripping it.
   *
   * This is the high-fidelity mode: every animation, scroll effect, hover
   * variant and responsive behaviour keeps working exactly as published,
   * because the code that drives them is still there. Trackers and the
   * watermark are still removed. The trade is that the output contains
   * Framer's React bundle rather than being framework-free.
   */
  keepRuntime: boolean;
  /**
   * Process a page even when it is not recognisably Framer.
   *
   * The Framer-specific transforms are skipped entirely — there is no appear
   * spec to compile and no runtime to reason about — so the generic path is
   * limited to what is safe on unknown markup: remove trackers, localise
   * assets, rewrite links. Running the Framer strip list against arbitrary
   * HTML would mangle it rather than clean it.
   */
  allowNonFramer: boolean;
  /** Base URL of the source site, used to resolve relative links. */
  baseUrl?: string;
}

export const DEFAULT_OPTIONS: ExtractOptions = {
  assetMode: 'hotlink',
  compileAnimations: true,
  reducedMotion: true,
  interactions: true,
  keepRuntime: false,
  allowNonFramer: false,
};

/** One class of thing the stripper removed. */
export interface RemovalRecord {
  kind: string;
  detail: string;
  count: number;
}

export interface AssetRef {
  url: string;
  kind: 'image' | 'font' | 'video' | 'script' | 'style' | 'other';
}

export interface ExtractReport {
  sourceUrl?: string;
  isFramerSite: boolean;
  framerBuild?: string;
  bytesBefore: number;
  bytesAfter: number;
  removals: RemovalRecord[];
  breakpoints: Breakpoint[];
  appearIds: number;
  appearRulesEmitted: number;
  animatedElements: number;
  /** Elements that were hidden inline with no appear data, now reveal-driven. */
  scrollReveals: number;
  /** Distinct reveal from-states, i.e. emitted reveal rules. */
  revealGroups: number;
  /** Ticker tracks reconstructed as CSS marquees. */
  tickers: number;
  /** Bytes of shim JavaScript added. */
  shimBytes: number;
  /** Framer runtime modules kept and localised (high-fidelity mode). */
  runtimeModules: number;
  /** Which pipeline ran. */
  platform: 'framer' | 'generic';
  assets: AssetRef[];
  warnings: string[];
}

/** A component we could not faithfully reconstruct. Surfaced to the user, never hidden. */
export interface UnsupportedComponent {
  selector: string;
  name?: string;
  reason: string;
}
