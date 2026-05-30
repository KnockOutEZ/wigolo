export const palette = {
  pink:   '#FF6AC1',
  purple: '#A78BFA',
  white:  '#F5F5F5',
  gray:   '#9CA3AF',
  dim:    '#525252',
  green:  '#34D399',
  yellow: '#FBBF24',
  red:    '#F87171',
  bg:     undefined,
} as const;

export const semantic = {
  accent:        palette.pink,
  accentAlt:     palette.purple,
  text:          palette.white,
  textDim:       palette.gray,
  textMuted:     palette.dim,
  ok:            palette.green,
  warn:          palette.yellow,
  err:           palette.red,
  borderActive:  palette.pink,
  borderIdle:    palette.dim,
} as const;
