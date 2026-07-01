# wigolo brand

The wigolo mark is a heavy, tight, lowercase wordmark in a single solid color.

## Assets

| File | Use |
|------|-----|
| `wigolo-wordmark-dark.png` | Wordmark for **dark** backgrounds (off-white text, transparent bg) |
| `wigolo-wordmark-light.png` | Wordmark for **light** backgrounds (near-black text, transparent bg) |
| `wigolo-icon.png` | App icon — `w` monogram on a rounded square (1536×1536) |

## Spec (reproducible)

- **Wordmark:** the word `wigolo`, always lowercase.
- **Font:** [Inter](https://rsms.me/inter/), weight **800** (ExtraBold).
- **Letter-spacing:** `-0.055em` (≈ −5.5% tracking) — scales with size.
- **Colors:**
  - Warm off-white `#f5f3ee`
  - Near-black `#1a1a1a`
  - On dark → off-white text; on light → near-black text.
- **App icon:** the `w` monogram, off-white on a near-black rounded square
  (corner radius ≈ 22.5% of the side).

Minimal CSS recipe:

```css
.wigolo-wordmark {
  font-family: Inter, system-ui, sans-serif;
  font-weight: 800;
  letter-spacing: -0.055em;
  text-transform: lowercase;
  color: #f5f3ee; /* or #1a1a1a on light backgrounds */
}
```

## Regenerating the PNGs

The PNGs are rendered from the spec with the bundled browser engine:

```bash
node assets/brand/generate.cjs
```

The script downloads Inter (ExtraBold/Black), renders the wordmark and icon, and
writes the PNGs into this directory at 3× for crisp scaling.

## Usage notes

- Keep the wordmark lowercase and in one solid color.
- Don't recolor, add effects, or stretch it.
- The name "wigolo" is a trademark — see [`TRADEMARK.md`](../../TRADEMARK.md).
