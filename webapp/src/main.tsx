import { render } from 'preact';
import { App } from './ui/App.js';

/**
 * Entry point for the Studio web app. esbuild bundles this (and its Preact runtime) into a single
 * self-contained `app.js` with NO external/CDN fetches — the daemon serves it from `dist/webapp`.
 */
const mount = document.getElementById('app');
if (mount) {
  mount.textContent = '';
  render(<App />, mount);
}
