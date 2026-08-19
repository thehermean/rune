// Typed names for the CSS custom properties defined in tokens.css.
//
// This is a convenience layer: it lets components reference a token by a typed
// constant (e.g. `cssVar(tokens.accent)`) instead of a stringly-typed literal,
// so a renamed token surfaces as a type error. The *values* live in tokens.css;
// this file only mirrors the NAMES. Keep the two in lockstep.

export const tokens = {
  // Color
  canvas: '--canvas',
  surface: '--surface',
  elevated: '--elevated',
  ink: '--ink',
  body: '--body',
  mute: '--mute',
  faint: '--faint',
  hairline: '--hairline',
  accent: '--accent',
  accentSoft: '--accent-soft',
  danger: '--danger',

  // Type families
  fontBody: '--font-body',
  fontChrome: '--font-chrome',

  // Spacing
  space1: '--space-1',
  space2: '--space-2',
  space3: '--space-3',
  space4: '--space-4',
  space5: '--space-5',
  space6: '--space-6',
  space7: '--space-7',
  space8: '--space-8',
  space9: '--space-9',
  rowPadY: '--row-pad-y',
  checkboxGap: '--checkbox-gap',
  sectionGap: '--section-gap',

  // Radius
  radiusRow: '--radius-row',
  radiusCard: '--radius-card',

  // Motion
  ease: '--ease',
  durState: '--dur-state',
  durExpand: '--dur-expand',
  durReflow: '--dur-reflow',
  durStrike: '--dur-strike',
} as const;

export type TokenName = (typeof tokens)[keyof typeof tokens];

/** `cssVar('--accent')` -> `var(--accent)`. */
export function cssVar(name: TokenName): string {
  return `var(${name})`;
}
