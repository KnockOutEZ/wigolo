import { describe, it, expect } from "vitest";
import { ALTERNATIVES } from "../src/content/alternatives";

// The tools an agent actually sees. A mapping to anything else would tell a
// reader to call a tool that doesn't exist.
const TOOLS = new Set(["search", "fetch", "crawl", "cache", "extract", "find_similar", "research", "agent", "diff", "watch"]);

describe("comparison pages", () => {
  it("cite at least one vendor source per page, since every price on them is theirs", () => {
    for (const a of ALTERNATIVES) {
      expect(a.sources.length, a.slug).toBeGreaterThan(0);
      for (const s of a.sources) expect(s.url, a.slug).toMatch(/^https:\/\//);
    }
  });

  it("map every vendor endpoint onto real wigolo tools", () => {
    for (const a of ALTERNATIVES) {
      for (const m of a.mapping) {
        for (const tool of m.wigolo.split(" / ")) expect(TOOLS.has(tool), `${a.slug}: ${m.wigolo}`).toBe(true);
      }
    }
  });

  it("keep titles and descriptions inside what search results display", () => {
    for (const a of ALTERNATIVES) {
      expect(`${a.title} · wigolo`.length, a.slug).toBeLessThanOrEqual(62);
      expect(a.title.toLowerCase(), a.slug).toContain(`${a.name.toLowerCase()} alternative`);
      expect(a.description.length, a.slug).toBeLessThanOrEqual(170);
    }
  });

  it("have unique slugs", () => {
    const slugs = ALTERNATIVES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
