// Inline stroke icons (currentColor, no external font — CSP-safe + offline). 1.6px strokes at 16px
// read crisply on the dark chrome. Kept intentionally minimal to match the refined browser aesthetic.
import type { CSSProperties } from 'react';

const base = (size: number): { width: number; height: number; viewBox: string; fill: string; stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round'; style?: CSSProperties } => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
});

export const IconBack = ({ size = 18 }: { size?: number }) => (<svg {...base(size)}><path d="M15 18l-6-6 6-6" /></svg>);
export const IconForward = ({ size = 18 }: { size?: number }) => (<svg {...base(size)}><path d="M9 18l6-6-6-6" /></svg>);
export const IconReload = ({ size = 16 }: { size?: number }) => (<svg {...base(size)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>);
export const IconGlobe = ({ size = 15 }: { size?: number }) => (<svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" /></svg>);
export const IconStar = ({ size = 16 }: { size?: number }) => (<svg {...base(size)}><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9z" /></svg>);
export const IconLink = ({ size = 16 }: { size?: number }) => (<svg {...base(size)}><path d="M9 15l6-6M10.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1M13.5 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" /></svg>);
export const IconReader = ({ size = 16 }: { size?: number }) => (<svg {...base(size)}><path d="M4 6h16M4 10h16M4 14h11M4 18h11" /></svg>);
export const IconSearch = ({ size = 15 }: { size?: number }) => (<svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>);
export const IconClose = ({ size = 13 }: { size?: number }) => (<svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>);
export const IconSend = ({ size = 15 }: { size?: number }) => (<svg {...base(size)}><path d="M12 19V5M6 11l6-6 6 6" /></svg>);
export const IconPause = ({ size = 14 }: { size?: number }) => (<svg {...base(size)}><path d="M8 5v14M16 5v14" /></svg>);
export const IconClip = ({ size = 16 }: { size?: number }) => (<svg {...base(size)}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /></svg>);

/** The agent mark — a four-point spark (violet in use), the studio's identity glyph. */
export const IconSpark = ({ size = 15 }: { size?: number }) => (
  <svg {...base(size)}><path d="M12 3c.6 3.6 1.8 4.8 5.4 5.4-3.6.6-4.8 1.8-5.4 5.4-.6-3.6-1.8-4.8-5.4-5.4C10.2 7.8 11.4 6.6 12 3z" fill="currentColor" stroke="none" /><path d="M18.5 15c.3 1.8.9 2.4 2.7 2.7-1.8.3-2.4.9-2.7 2.7-.3-1.8-.9-2.4-2.7-2.7 1.8-.3 2.4-.9 2.7-2.7z" fill="currentColor" stroke="none" /></svg>
);
