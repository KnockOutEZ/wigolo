// Stub for `react-devtools-core`, an optional dev-only import inside ink. It is
// not installed as a runtime dependency, but esbuild hoists the external import
// to an eager top-level require in flat output, which crashes boot inside the
// binary. Aliasing to this no-op stub keeps the ink import resolvable while the
// TUI itself stays externalized/unavailable in the binary (headless-first).
export function connectToDevTools() {}
export function initialize() {}
export default {};
