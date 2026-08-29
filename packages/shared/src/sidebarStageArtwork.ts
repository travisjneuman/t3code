export type SidebarStageArtworkVariant = "nightly" | "dev";

const STAGE_BACKDROP_VIEW_BOX = "0 0 8192 96";
const SAFE_ID_PREFIX = /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/;

const NIGHTLY_STARS: ReadonlyArray<{
  cx: number;
  cy: number;
  r: number;
  opacity: number;
}> = [
  { cx: 14, cy: 10, r: 0.6, opacity: 0.85 },
  { cx: 38, cy: 22, r: 0.4, opacity: 0.55 },
  { cx: 58, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 84, cy: 16, r: 0.4, opacity: 0.5 },
  { cx: 104, cy: 7, r: 0.6, opacity: 0.8 },
  { cx: 126, cy: 20, r: 0.4, opacity: 0.55 },
  { cx: 148, cy: 11, r: 0.5, opacity: 0.7 },
  { cx: 170, cy: 24, r: 0.4, opacity: 0.5 },
  { cx: 192, cy: 9, r: 0.6, opacity: 0.8 },
  { cx: 214, cy: 18, r: 0.4, opacity: 0.55 },
  { cx: 236, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 258, cy: 20, r: 0.45, opacity: 0.6 },
  { cx: 278, cy: 11, r: 0.55, opacity: 0.75 },
  { cx: 26, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 118, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 202, cy: 32, r: 0.4, opacity: 0.5 },
  { cx: 268, cy: 34, r: 0.4, opacity: 0.45 },
];

const NIGHTLY_SPARKLES: ReadonlyArray<{ x: number; y: number }> = [
  { x: 70, y: 28 },
  { x: 160, y: 36 },
  { x: 246, y: 26 },
];

const safeIdPrefix = (value: string): string =>
  SAFE_ID_PREFIX.test(value) ? value : "t3code-stage-art";

const buildNightlyArtwork = (idPrefix: string, compact: boolean): string => {
  const skyId = `${idPrefix}-stage-night-sky`;
  const glowId = `${idPrefix}-stage-night-glow`;
  const cloudId = `${idPrefix}-stage-night-cloud`;
  const softId = `${idPrefix}-stage-night-soft`;
  const starsId = `${idPrefix}-stage-night-stars`;
  const glowsId = `${idPrefix}-stage-night-glows`;
  const stars = NIGHTLY_STARS.map(
    ({ cx, cy, r, opacity }) =>
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill-opacity="${opacity}"/>`,
  ).join("");
  const sparkles = NIGHTLY_SPARKLES.map(
    ({ x, y }) =>
      `<g><path d="M${x - 1.5} ${y}H${x + 1.5}"/><path d="M${x} ${y - 1.5}V${y + 1.5}"/></g>`,
  ).join("");

  return `<svg class="stage-art stage-nightly h-full w-full" fill="none" preserveAspectRatio="xMinYMin slice" viewBox="${compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="${skyId}" x1="24" y1="0" x2="264" y2="96" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop style="stop-color:var(--stage-night-bottom)"/><stop offset="0.5" style="stop-color:var(--stage-night-mid)"/><stop offset="1" style="stop-color:var(--stage-night-top)"/></linearGradient>
<radialGradient id="${glowId}" cx="0" cy="0" r="1" gradientTransform="translate(216 18) rotate(137) scale(120 84)" gradientUnits="userSpaceOnUse"><stop style="stop-color:var(--stage-night-glow-highlight)" stop-opacity="0.4"/><stop offset="0.5" style="stop-color:var(--stage-night-glow-secondary)" stop-opacity="0.16"/><stop offset="1" style="stop-color:var(--stage-night-bottom)" stop-opacity="0"/></radialGradient>
<linearGradient id="${cloudId}" x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse"><stop style="stop-color:var(--stage-night-highlight)" stop-opacity="0.5"/><stop offset="0.52" style="stop-color:var(--stage-night-secondary)" stop-opacity="0.62"/><stop offset="1" style="stop-color:var(--stage-night-tertiary)" stop-opacity="0.5"/></linearGradient>
<filter id="${softId}" x="-24" y="-24" width="336" height="144" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="4"/></filter>
<pattern id="${starsId}" width="288" height="96" patternUnits="userSpaceOnUse"><g style="fill:var(--stage-night-line)">${stars}</g><g style="stroke:var(--stage-night-sparkle)" stroke-linecap="round" stroke-opacity="0.7" stroke-width="0.6">${sparkles}</g></pattern>
<pattern id="${glowsId}" width="640" height="96" patternUnits="userSpaceOnUse"><rect width="640" height="96" fill="url(#${glowId})"/></pattern>
</defs>
<rect width="100%" height="96" fill="url(#${skyId})"/><rect width="100%" height="96" fill="url(#${glowsId})"/><rect width="100%" height="96" fill="url(#${starsId})"/>
<g filter="url(#${softId})"><path d="M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82C132 83 138 88 141 96H-12V88Z" fill="url(#${cloudId})"/></g>
<g filter="url(#${softId})"><path d="M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87C250 87 257 91 260 96H150Z" fill="url(#${cloudId})" fill-opacity="0.8"/></g>
</svg>`;
};

const buildDevArtwork = (idPrefix: string, compact: boolean): string => {
  const paperId = `${idPrefix}-stage-bp-paper`;
  const glowId = `${idPrefix}-stage-bp-glow`;
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`;
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`;
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`;
  const majorGridId = `${idPrefix}-stage-bp-grid-major`;
  const rulerId = `${idPrefix}-stage-bp-ruler`;
  const glowsId = `${idPrefix}-stage-bp-glows`;
  const annotationsId = `${idPrefix}-stage-bp-annotations`;

  return `<svg class="stage-art stage-blueprint h-full w-full" fill="none" preserveAspectRatio="xMinYMin slice" viewBox="${compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="${paperId}" x1="60" y1="0" x2="220" y2="96" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop style="stop-color:var(--stage-art-bottom)"/><stop offset="0.5" style="stop-color:var(--stage-art-mid)"/><stop offset="1" style="stop-color:var(--stage-art-top)"/></linearGradient>
<radialGradient id="${glowId}" cx="0" cy="0" r="1" gradientTransform="translate(216 14) rotate(137) scale(120 84)" gradientUnits="userSpaceOnUse"><stop style="stop-color:var(--stage-art-highlight)" stop-opacity="0.4"/><stop offset="0.52" style="stop-color:var(--stage-art-secondary)" stop-opacity="0.16"/><stop offset="1" style="stop-color:var(--stage-art-bottom)" stop-opacity="0"/></radialGradient>
<radialGradient id="${celesteGlowId}" cx="0" cy="0" r="1" gradientTransform="translate(474 44) rotate(166) scale(156 92)" gradientUnits="userSpaceOnUse"><stop style="stop-color:var(--stage-art-celeste-highlight)" stop-opacity="0.34"/><stop offset="0.5" style="stop-color:var(--stage-art-celeste-secondary)" stop-opacity="0.18"/><stop offset="1" style="stop-color:var(--stage-art-bottom)" stop-opacity="0"/></radialGradient>
<radialGradient id="${violetGlowId}" cx="0" cy="0" r="1" gradientTransform="translate(704 18) rotate(145) scale(132 88)" gradientUnits="userSpaceOnUse"><stop style="stop-color:var(--stage-art-violet-highlight)" stop-opacity="0.3"/><stop offset="0.52" style="stop-color:var(--stage-art-tertiary)" stop-opacity="0.14"/><stop offset="1" style="stop-color:var(--stage-art-bottom)" stop-opacity="0"/></radialGradient>
<pattern id="${minorGridId}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M8 0H0V8" style="stroke:var(--stage-art-grid-line)" stroke-opacity="0.14" stroke-width="0.5"/></pattern>
<pattern id="${majorGridId}" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" style="stroke:var(--stage-art-grid-line)" stroke-opacity="0.26" stroke-width="0.6"/></pattern>
<pattern id="${rulerId}" width="32" height="6" patternUnits="userSpaceOnUse"><path d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5" style="stroke:var(--stage-art-line)" stroke-opacity="0.5" stroke-width="0.5"/></pattern>
<pattern id="${glowsId}" width="768" height="96" patternUnits="userSpaceOnUse"><rect width="768" height="96" fill="url(#${glowId})"/><rect width="768" height="96" fill="url(#${celesteGlowId})"/><rect width="768" height="96" fill="url(#${violetGlowId})"/></pattern>
<pattern id="${annotationsId}" width="768" height="96" patternUnits="userSpaceOnUse">
<g style="stroke:var(--stage-art-line)" stroke-linecap="round" stroke-opacity="0.6" stroke-width="0.7"><path d="M180 64H264" stroke-dasharray="5 4"/><path d="M180 61V67M264 61V67"/><path d="M276 10V44" stroke-dasharray="4 4" stroke-opacity="0.5"/><path d="M273 10H279M273 44H279" stroke-opacity="0.5"/><path d="M348 30H428" stroke-dasharray="3.5 5" stroke-opacity="0.5"/><path d="M348 27V33M428 27V33" stroke-opacity="0.5"/><path d="M512 48V80" stroke-dasharray="5 3" stroke-opacity="0.45"/><path d="M509 48H515M509 80H515" stroke-opacity="0.45"/><path d="M590 70H724" stroke-dasharray="7 4" stroke-opacity="0.55"/><path d="M590 67V73M724 67V73" stroke-opacity="0.55"/></g>
<g style="stroke:var(--stage-art-line)" stroke-linecap="round" stroke-opacity="0.55" stroke-width="0.6"><g><path d="M34 60L38 64M38 60L34 64"/></g><g><path d="M228 26H234M231 23V29"/></g><g><path d="M143 51H149M146 48V54"/></g><g><path d="M316 16L322 22M322 16L316 22"/></g><g><path d="M468 70H476M472 66V74"/></g><g><path d="M558 28L564 34M564 28L558 34"/></g><g><path d="M742 44H750M746 40V48"/></g></g>
<g style="stroke:var(--stage-art-line)" stroke-opacity="0.35" stroke-width="0.6"><circle cx="196" cy="38" r="13" stroke-dasharray="3.5 4"/><path d="M196 33V43M191 38H201" stroke-opacity="0.6" stroke-width="0.4"/><circle cx="414" cy="64" r="10" stroke-dasharray="2.5 3.5"/><path d="M414 60V68M410 64H418" stroke-opacity="0.6" stroke-width="0.4"/><circle cx="648" cy="32" r="15" stroke-dasharray="4 5"/><path d="M648 26V38M642 32H654" stroke-opacity="0.6" stroke-width="0.4"/></g>
</pattern>
</defs>
<rect width="100%" height="96" fill="url(#${paperId})"/><rect width="100%" height="96" fill="url(#${glowsId})"/><rect width="100%" height="96" fill="url(#${minorGridId})"/><rect width="100%" height="96" fill="url(#${majorGridId})"/><rect width="100%" height="6" fill="url(#${rulerId})"/><rect width="100%" height="96" fill="url(#${annotationsId})"/>
</svg>`;
};

/** Canonical stage artwork shared by the native sidebar and isolated remote surface. */
export function buildSidebarStageArtworkSvg({
  variant,
  idPrefix,
  compact = false,
}: {
  readonly variant: SidebarStageArtworkVariant;
  readonly idPrefix: string;
  readonly compact?: boolean;
}): string {
  const prefix = safeIdPrefix(idPrefix);
  return variant === "nightly"
    ? buildNightlyArtwork(prefix, compact)
    : buildDevArtwork(prefix, compact);
}
