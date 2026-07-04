import { describe, it, expect } from 'vitest';
import { extractWithSchemaDetailed } from '../../../src/extraction/schema.js';

const tiersSchema = {
  type: 'object',
  properties: {
    tiers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'string' },
          key_features: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// A full plan-tier grid: name + price + a per-card feature list, a handful of
// rows. Shape-complete and plausibly sized → HIGH confidence.
const planTierHtml = `<html><body><main><section class="pricing"><h2>Plans</h2>
  <div class="tiers">
    <div class="plan"><h3>Starter</h3><span class="price">$9</span><ul><li>10 seats</li><li>1 project</li></ul></div>
    <div class="plan"><h3>Pro</h3><span class="price">$29</span><ul><li>50 seats</li><li>10 projects</li></ul></div>
    <div class="plan"><h3>Enterprise</h3><span class="price">$99</span><ul><li>Unlimited seats</li><li>Unlimited projects</li></ul></div>
  </div>
</section></main></body></html>`;

// An add-on / marketplace grid: name + price only (no features), MANY rows.
// A schema asking for pricing tiers should read this as LOW confidence — wrong
// shape (no key_features) and an absurd cardinality for "tiers".
function addOnGrid(count: number): string {
  const cards = Array.from({ length: count }, (_, i) =>
    `<div class="addon"><h3>Add-on ${i + 1}</h3><span class="price">$${i + 1}</span></div>`,
  ).join('');
  return `<html><body><main><section class="marketplace"><h2>Add-ons</h2>
    <div class="addons">${cards}</div>
  </section></main></body></html>`;
}

describe('schema array-of-objects confidence signal', () => {
  it('exposes a confidence for a matched array field', () => {
    const det = extractWithSchemaDetailed(planTierHtml, tiersSchema);
    expect(Array.isArray(det.values.tiers)).toBe(true);
    expect(det.confidence).toBeDefined();
    expect(det.confidence!.tiers).toBeDefined();
  });

  it('a shape-complete plan-tier grid scores HIGH confidence', () => {
    const det = extractWithSchemaDetailed(planTierHtml, tiersSchema);
    const c = det.confidence!.tiers;
    expect(c.arrayFilled).toBe(true);
    expect(c.scalarMatches).toBeGreaterThanOrEqual(2);
    // score = scalar*10 (>=20) + arrayFill 10 + plausible-size 3 = >=33
    expect(c.score).toBeGreaterThanOrEqual(30);
    expect(c.rowCount).toBe(3);
  });

  it('a name+price-only add-on grid with absurd cardinality scores LOW confidence', () => {
    const det = extractWithSchemaDetailed(addOnGrid(36), tiersSchema);
    const c = det.confidence!.tiers;
    // key_features never filled → arrayFilled false, no +10; 36 rows → no size
    // prior. Shape-incomplete.
    expect(c.arrayFilled).toBe(false);
    expect(c.rowCount).toBe(36);
    // A shape-complete tier grid (>=30) clearly out-scores this add-on dump.
    expect(c.score).toBeLessThan(30);
  });
});
