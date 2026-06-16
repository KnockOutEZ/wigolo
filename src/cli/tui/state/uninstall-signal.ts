let _uninstalled = false;

export function signalUninstall(): void {
  _uninstalled = true;
}

export function wasUninstalled(): boolean {
  return _uninstalled;
}
