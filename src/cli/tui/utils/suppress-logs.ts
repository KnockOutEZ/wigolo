export function enableTuiMode(): void {
  process.env.WIGOLO_TUI_MODE = 'true';
}

export function isTuiMode(): boolean {
  return process.env.WIGOLO_TUI_MODE === 'true';
}
