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
  /** Base URL of the source site, used to resolve relative links. */
  baseUrl?: string;
}

export const DEFAULT_OPTIONS: ExtractOptions = {
  assetMode: 'hotlink',
  compileAnimations: true,
  reducedMotion: true,
};

/** One class of thing the stripper removed. */
export interface RemovalRecord {
  kind: string;
  detail: string;
  count: number;
}

export interface AssetRef {
  url: string;
  kind: 'image' | 'font' | 'video' | 'other';
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
  assets: AssetRef[];
  warnings: string[];
}

/** A component we could not faithfully reconstruct. Surfaced to the user, never hidden. */
export interface UnsupportedComponent {
  selector: string;
  name?: string;
  reason: string;
}
