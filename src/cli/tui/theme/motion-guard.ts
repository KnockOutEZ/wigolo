export function reducedMotion(): boolean {
  if (process.env.WIGOLO_TUI_REDUCED_MOTION === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  if (process.stdout.isTTY === false) return true;
  return false;
}
