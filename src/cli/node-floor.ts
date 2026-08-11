// The supported-Node floor, in a module that imports NOTHING. It is consumed by
// both the setup check (`init`) and `doctor`, and `doctor` is in turn reachable
// from `warmup`. Keeping this leaf free of `node:fs` matters: a partial
// `vi.mock('node:fs', ...)` anywhere in that graph fails on the first export the
// factory did not declare, so pulling a filesystem import along this path breaks
// unrelated suites.
//
// Keep MIN_NODE_MAJOR in lockstep with `engines.node` in package.json. Node 20
// "Iron" reached upstream end of life on 2026-03-24, so the floor tracks the
// current LTS line rather than an unmaintained one.
export const MIN_NODE_MAJOR = 22;

export interface NodeFloorResult {
  ok: boolean;
  version?: string;
  message?: string;
}

/** Check a Node version string (defaults to the running runtime) against the
 *  supported floor. Pure — takes the version as input so it is testable. */
export function checkNodeFloor(raw: string = process.version): NodeFloorResult {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return { ok: false, message: `unable to parse Node version '${raw}'` };
  }
  const major = parseInt(m[1], 10);
  const version = `${major}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`;
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      version,
      message: `wigolo requires Node ${MIN_NODE_MAJOR} or newer (found ${version})`,
    };
  }
  return { ok: true, version };
}
