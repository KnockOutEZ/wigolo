import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(process.cwd(), "..");

/**
 * Last commit date touching `paths` (repo-relative), for sitemap <lastmod>.
 * Needs full history (the Pages workflow checks out with fetch-depth 0); on a
 * shallow clone or without git it returns undefined rather than a wrong date.
 */
export function lastModified(...paths: string[]): Date | undefined {
  try {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO, encoding: "utf8" }).trim();
    if (shallow === "true") return undefined;
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", ...paths], { cwd: REPO, encoding: "utf8" }).trim();
    return iso ? new Date(iso) : undefined;
  } catch {
    return undefined;
  }
}
