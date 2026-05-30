import { semantic } from './palette.js';

export const borders = {
  box:    { borderStyle: 'round' as const, borderColor: semantic.borderIdle },
  active: { borderStyle: 'round' as const, borderColor: semantic.borderActive },
} as const;
