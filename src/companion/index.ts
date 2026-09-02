/**
 * Public surface of `src/companion/` for the companion split (`wigolo/companion`).
 *
 * Not a general barrel: it carries exactly what the extracted studio domain layer was measured
 * importing from this directory (2026-09-02). Every other kept file here is reached by core's own
 * seams — the daemon, the CLI, config, the fetch router — which import the module directly and do
 * not need a subpath at all.
 */
export { studioStateDir } from './paths.js';
