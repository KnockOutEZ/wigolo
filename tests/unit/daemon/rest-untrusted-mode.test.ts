import { describe, it, expect } from 'vitest';
import {
  resolveUntrustedMode,
  UNTRUSTED_MODE_HEADER,
  UNTRUSTED_MODE_HEADER_NAME,
} from '../../../src/daemon/rest/untrusted-mode.js';

/**
 * The opt-in mechanism itself (R2 / decisions A10 + A11). One header selects where the trust boundary
 * travels; the two REST surfaces differ ONLY in which value they fall back to. These tests exist to
 * stop the mechanism drifting into two mechanisms, and to keep an unrecognized value from resolving
 * to whatever the surface default happens to be.
 */
describe('REST untrusted-content representation header', () => {
  it('MODE-1: an absent header takes the SURFACE default, and the two surfaces differ', () => {
    // The whole ruling rests on this asymmetry: native routes fence by default, the compat shim does
    // not. MUT: hardcode one fallback → one of these two flips → RED.
    expect(resolveUntrustedMode(undefined, 'inline')).toEqual({ ok: true, mode: 'inline' });
    expect(resolveUntrustedMode(undefined, 'envelope')).toEqual({ ok: true, mode: 'envelope' });
  });

  it('MODE-2: an explicit value overrides the surface default in BOTH directions', () => {
    // Opting IN to the envelope on a fencing surface, and opting IN to the fence on a byte-clean one.
    // MUT: ignore the header and always return `fallback` → RED.
    expect(resolveUntrustedMode('envelope', 'inline')).toEqual({ ok: true, mode: 'envelope' });
    expect(resolveUntrustedMode('inline', 'envelope')).toEqual({ ok: true, mode: 'inline' });
  });

  it('MODE-3: the value is case- and whitespace-insensitive', () => {
    // Header values are hand-typed by curl users; `Envelope` must not silently mean "fence it".
    expect(resolveUntrustedMode('  ENVELOPE ', 'inline')).toEqual({ ok: true, mode: 'envelope' });
    expect(resolveUntrustedMode('Inline', 'envelope')).toEqual({ ok: true, mode: 'inline' });
  });

  it('MODE-4: an UNRECOGNIZED value is refused, never silently defaulted', () => {
    // A silent fallback is the dangerous shape: on the compat surface a typo'd `envelop` would hand
    // back byte-clean text to a caller who had just asked for the fence. MUT: return
    // `{ok:true, mode:fallback}` for an unknown value → RED.
    const r = resolveUntrustedMode('envelop', 'envelope');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.value).toBe('envelop');
    expect(r.ok === false && r.hint).toContain(UNTRUSTED_MODE_HEADER_NAME);
  });

  it('MODE-5: an empty value is refused rather than read as "default"', () => {
    // `-H "X-Wigolo-Untrusted-Content:"` is a caller mistake, not a request for the default.
    expect(resolveUntrustedMode('', 'inline').ok).toBe(false);
    expect(resolveUntrustedMode('   ', 'inline').ok).toBe(false);
  });

  it('MODE-6: a REPEATED header is refused rather than guessed at', () => {
    // node surfaces a repeated non-special header as a joined string[]; picking first or last would be
    // an arbitrary tiebreak on a security-relevant switch.
    const r = resolveUntrustedMode(['inline', 'envelope'], 'inline');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.value).toContain('envelope');
  });

  it('MODE-7: the lookup key is lowercase, matching node\'s incoming header map', () => {
    // node lowercases request header names; a canonically-cased constant used as the lookup key would
    // never match and the header would be silently inert — a control that cannot be turned on.
    expect(UNTRUSTED_MODE_HEADER).toBe(UNTRUSTED_MODE_HEADER_NAME.toLowerCase());
  });
});
