import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractWithSchema, extractWithSchemaDetailed } from '../../../src/extraction/schema.js';

const structuredFixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/structured-data', name), 'utf-8');

const productHtml = readFileSync(
  join(import.meta.dirname, '../../fixtures/extraction/product-page.html'),
  'utf-8',
);

describe('extractWithSchema', () => {
  // --- Core field matching ---

  it('extracts fields matching schema from product page', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
        description: { type: 'string' },
      },
    };

    const result = extractWithSchema(productHtml, schema);
    expect(result.name).toBe('Widget Pro');
    expect(result.price).toContain('29.99');
    expect(result.description).toContain('widget');
  });

  it('returns partial results when some fields not found', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        nonexistent_field: { type: 'string' },
      },
    };

    const result = extractWithSchema(productHtml, schema);
    expect(result.name).toBe('Widget Pro');
    expect(result.nonexistent_field).toBeUndefined();
  });

  it('returns empty object for completely unmatched schema', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const schema = {
      type: 'object',
      properties: {
        zzz_no_match: { type: 'string' },
        yyy_no_match: { type: 'string' },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result).toEqual({});
  });

  // --- CSS class matching ---

  it('matches fields by CSS class name containing field name', () => {
    const html = '<div class="product-rating">4.5</div>';
    const schema = {
      type: 'object',
      properties: { rating: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.rating).toBe('4.5');
  });

  it('matches hyphenated class name from underscore field name', () => {
    const html = '<span class="review-count">42 reviews</span>';
    const schema = {
      type: 'object',
      properties: { review_count: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.review_count).toBe('42 reviews');
  });

  // --- ARIA label matching ---

  it('matches fields by aria-label', () => {
    const html = '<span aria-label="price">$19.99</span>';
    const schema = {
      type: 'object',
      properties: { price: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.price).toBe('$19.99');
  });

  it('matches field by aria-label case-insensitively', () => {
    const html = '<div aria-label="Product Name">Super Widget</div>';
    const schema = {
      type: 'object',
      properties: { product_name: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.product_name).toBe('Super Widget');
  });

  // --- ID matching ---

  it('matches fields by element id', () => {
    const html = '<span id="total-price">$49.99</span>';
    const schema = {
      type: 'object',
      properties: { total_price: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.total_price).toBe('$49.99');
  });

  // --- data-* attribute matching ---

  it('matches fields by data attribute value', () => {
    const html = '<div data-sku="WDG-PRO-001">Widget Pro</div>';
    const schema = {
      type: 'object',
      properties: { sku: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.sku).toBe('WDG-PRO-001');
  });

  // --- Microdata (itemprop) matching ---

  it('matches fields by itemprop attribute', () => {
    const html = '<span itemprop="brand">Acme Corp</span>';
    const schema = {
      type: 'object',
      properties: { brand: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.brand).toBe('Acme Corp');
  });

  it('reads itemprop content attribute over text content', () => {
    const html = '<meta itemprop="datePublished" content="2026-04-10">';
    const schema = {
      type: 'object',
      properties: { datePublished: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.datePublished).toBe('2026-04-10');
  });

  it('handles nested microdata with itemprop on child elements', () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Gadget</span>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <span itemprop="price" content="15.00">$15.00</span>
        </div>
      </div>
    `;
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result.name).toBe('Gadget');
    expect(result.price).toBe('15.00');
  });

  // --- Array extraction ---

  it('extracts array values from repeated elements', () => {
    const html = `
      <ul class="features">
        <li class="feature">Fast</li>
        <li class="feature">Reliable</li>
        <li class="feature">Cheap</li>
      </ul>
    `;
    const schema = {
      type: 'object',
      properties: {
        features: { type: 'array', items: { type: 'string' } },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result.features).toEqual(['Fast', 'Reliable', 'Cheap']);
  });

  it('extracts array from container with list items', () => {
    const html = `
      <div class="tags">
        <li>typescript</li>
        <li>javascript</li>
      </div>
    `;
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result.tags).toEqual(['typescript', 'javascript']);
  });

  // --- Edge cases ---

  it('returns empty object for empty HTML', () => {
    const result = extractWithSchema('', { type: 'object', properties: {} });
    expect(result).toEqual({});
  });

  it('returns empty object for schema with no properties', () => {
    const result = extractWithSchema('<html><body>content</body></html>', { type: 'object' });
    expect(result).toEqual({});
  });

  it('returns empty object for undefined schema properties', () => {
    const result = extractWithSchema('<html><body>content</body></html>', {
      type: 'object',
      properties: undefined,
    } as any);
    expect(result).toEqual({});
  });

  it('handles HTML with no matching elements for any strategy', () => {
    const html = '<html><body><p>Just a paragraph</p></body></html>';
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result).toEqual({});
  });

  it('prioritizes JSON-LD data over heuristic matching when both available', () => {
    const result = extractWithSchema(productHtml, {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    });
    // JSON-LD has name="Widget Pro", price="29.99"
    expect(result.name).toBe('Widget Pro');
    expect(result.price).toBe('29.99');
  });
});

describe('extractWithSchemaDetailed', () => {
  it('returns name + price + description with json-ld provenance for Product (spec AC#2)', () => {
    const html = structuredFixture('product-jsonld.html');
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
        description: { type: 'string' },
      },
    };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.name).toBeTruthy();
    expect(result.values.price).toBeTruthy();
    expect(result.values.description).toBeTruthy();
    expect(result.provenance.name).toBe('json-ld');
    expect(result.provenance.price).toBe('json-ld');
    expect(result.provenance.description).toBe('json-ld');
  });

  it('falls back to heuristic provenance when no structured data is present', () => {
    const html = '<html><body><div class="product-name">Foo</div></body></html>';
    const schema = { type: 'object', properties: { product_name: { type: 'string' } } };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.product_name).toBeTruthy();
    expect(result.provenance.product_name).toBe('heuristic');
  });

  it('marks fields sourced from microdata-only HTML as microdata', () => {
    const html = '<html><body><div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Foo</span></div></body></html>';
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.name).toBe('Foo');
    expect(result.provenance.name).toBe('microdata');
  });
});

// WHY: keyless schema returning {} then falling to prose is why both Extract
// AND the agent tool failed structured requests. When the data lives in a
// <table>, <dl>, or key:value structure rather than in class-named DOM nodes
// or JSON-LD, the old keyless path returned {}. Fuzzy-matching the requested
// schema fields against the extracted structures recovers those values —
// without manufacturing false positives from unrelated text.
describe('extractWithSchemaDetailed structure fuzzy-match (keyless)', () => {
  it('populates fields from a <table> whose header matches the schema field', () => {
    const html = `<html><body>
      <table>
        <thead><tr><th>Plan</th><th>Price</th></tr></thead>
        <tbody><tr><td>Pro</td><td>$29</td></tr></tbody>
      </table>
    </body></html>`;
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' }, price: { type: 'string' } },
    };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.plan).toBe('Pro');
    expect(result.values.price).toBe('$29');
    expect(result.provenance.plan).toBe('structured');
    expect(result.provenance.price).toBe('structured');
  });

  it('matches a schema field against a <dl> definition term (snake/space folding)', () => {
    const html = `<html><body>
      <dl><dt>Plan Name</dt><dd>Enterprise</dd></dl>
    </body></html>`;
    const schema = { type: 'object', properties: { plan_name: { type: 'string' } } };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.plan_name).toBe('Enterprise');
    expect(result.provenance.plan_name).toBe('structured');
  });

  it('matches a schema field against a key:value pair', () => {
    const html = `<html><body>
      <ul><li>Status: Active</li><li>Owner: platform-team</li></ul>
    </body></html>`;
    const schema = { type: 'object', properties: { status: { type: 'string' } } };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.status).toBe('Active');
    expect(result.provenance.status).toBe('structured');
  });

  it('does NOT manufacture false positives from unrelated structures', () => {
    // A page with structures that do NOT match the requested fields must
    // still return {} — fuzzy match must not grab any near-miss. This mirrors
    // the extractWithSchema "completely unmatched schema -> {}" invariant.
    const html = `<html><body>
      <table>
        <thead><tr><th>Weather</th><th>Temperature</th></tr></thead>
        <tbody><tr><td>Sunny</td><td>72F</td></tr></tbody>
      </table>
    </body></html>`;
    const schema = {
      type: 'object',
      properties: {
        zzz_no_match: { type: 'string' },
        yyy_no_match: { type: 'string' },
      },
    };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values).toEqual({});
  });

  it('rejects near-miss substring headers (no false positives)', () => {
    // The loose compact-substring branch matched plan→planet, card→cardholder,
    // tier→frontier, name→username — breaking the "no false positives"
    // invariant. Token-set overlap with plural-tolerant equality must reject
    // these while still matching the legitimate forms.
    const nonMatches: [string, string][] = [
      ['plan', 'Planet'],
      ['plan', 'Planning'],
      ['card', 'Cardholder'],
      ['tier', 'Frontier'],
      ['name', 'Username'],
    ];
    for (const [field, header] of nonMatches) {
      const html = `<table><thead><tr><th>${header}</th></tr></thead>` +
        `<tbody><tr><td>VAL</td></tr></tbody></table>`;
      const result = extractWithSchemaDetailed(html, {
        type: 'object',
        properties: { [field]: { type: 'string' } },
      });
      expect(result.values).toEqual({});
    }

    const shouldMatch: [string, string][] = [
      ['plan', 'Plan Name'],
      ['plan', 'Plans'],
      ['plan', 'Plan'],
    ];
    for (const [field, header] of shouldMatch) {
      const html = `<table><thead><tr><th>${header}</th></tr></thead>` +
        `<tbody><tr><td>VAL</td></tr></tbody></table>`;
      const result = extractWithSchemaDetailed(html, {
        type: 'object',
        properties: { [field]: { type: 'string' } },
      });
      expect(result.values[field]).toBe('VAL');
    }
  });

  it('prefers JSON-LD/microdata over structure fuzzy-match when both present', () => {
    const html = `<html><body>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="price">$10</span>
      </div>
      <table>
        <thead><tr><th>Price</th></tr></thead>
        <tbody><tr><td>$999</td></tr></tbody>
      </table>
    </body></html>`;
    const schema = { type: 'object', properties: { price: { type: 'string' } } };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.price).toBe('$10');
    expect(result.provenance.price).toBe('microdata');
  });
});

// WHY: `wigolo agent` with a pricing schema like {tiers:[{name,price,
// key_features}]} matched 0 fields and fell back to prose, even against a page
// whose tier facts sat in a clean <table>/div-grid. The flat fuzzy matcher only
// resolved a schema field NAME to a single scalar; a top-level array-of-objects
// field ("tiers") had no structure literally named "tiers", so it fell through
// to the crude class-name heuristic which returned run-on garbage. Nested
// array-of-objects fields must map to the best-matching grid: one item object
// per row, each item property fuzzy-matched to a header. This engine is shared
// by both the extract tool and the agent pipeline, so both benefit.
describe('extractWithSchemaDetailed nested array-of-objects (pricing tiers)', () => {
  const pricingTable = `<html><body>
    <table>
      <thead><tr><th>Name</th><th>Price</th><th>Seats</th></tr></thead>
      <tbody>
        <tr><td>Starter</td><td>$29</td><td>5</td></tr>
        <tr><td>Pro</td><td>$99</td><td>25</td></tr>
        <tr><td>Enterprise</td><td>Contact sales</td><td>Unlimited</td></tr>
      </tbody>
    </table>
  </body></html>`;

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
          },
        },
      },
    },
  };

  it('populates a tiers[] array with one object per row from a pricing table', () => {
    const result = extractWithSchemaDetailed(pricingTable, tiersSchema);
    const tiers = result.values.tiers as Array<Record<string, string>>;
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toEqual({ name: 'Starter', price: '$29' });
    expect(tiers[1]).toEqual({ name: 'Pro', price: '$99' });
    // Non-numeric price is preserved verbatim (Part B interplay).
    expect(tiers[2]).toEqual({ name: 'Enterprise', price: 'Contact sales' });
    expect(result.provenance.tiers).toBe('structured');
  });

  it('maps item properties from a div/flex pricing grid (no <table> markup)', () => {
    const grid = `<html><body>
      <div class="pricing">
        <div class="tier"><h3>Free</h3><span class="price">$0</span></div>
        <div class="tier"><h3>Team</h3><span class="price">$12</span></div>
        <div class="tier"><h3>Business</h3><span class="price">$40</span></div>
      </div>
    </body></html>`;
    const result = extractWithSchemaDetailed(grid, tiersSchema);
    const tiers = result.values.tiers as Array<Record<string, string>>;
    expect(tiers).toHaveLength(3);
    expect(tiers[0].name).toBe('Free');
    expect(tiers[0].price).toBe('$0');
    expect(tiers[2].name).toBe('Business');
    expect(tiers[2].price).toBe('$40');
    expect(result.provenance.tiers).toBe('structured');
  });

  it('folds an array item property against a synonym-ish header (key_features -> Features)', () => {
    const html = `<html><body>
      <table>
        <thead><tr><th>Plan</th><th>Features</th></tr></thead>
        <tbody>
          <tr><td>Basic</td><td>SSO</td></tr>
          <tr><td>Pro</td><td>SSO, Audit</td></tr>
          <tr><td>Max</td><td>SSO, Audit, SLA</td></tr>
        </tbody>
      </table>
    </body></html>`;
    const schema = {
      type: 'object',
      properties: {
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              plan: { type: 'string' },
              features: { type: 'string' },
            },
          },
        },
      },
    };
    const result = extractWithSchemaDetailed(html, schema);
    const plans = result.values.plans as Array<Record<string, string>>;
    expect(plans).toHaveLength(3);
    expect(plans[0]).toEqual({ plan: 'Basic', features: 'SSO' });
  });

  it('collects a card feature list into an array-typed item property (key_features)', () => {
    // The full pricing schema {tiers:[{name,price,key_features}]}: the div-grid
    // detector emits per-card list items as feature_1/feature_2/... columns, so
    // an array-typed key_features property harvests them into a string[].
    const grid = `<html><body>
      <main><h2>Pricing</h2><div class="pricing">
        <div class="tier"><h3>Starter</h3><span class="price">$29</span><ul><li>10 seats</li><li>Email support</li></ul></div>
        <div class="tier"><h3>Pro</h3><span class="price">$99</span><ul><li>50 seats</li><li>Priority support</li></ul></div>
        <div class="tier"><h3>Enterprise</h3><span class="price">Contact sales</span><ul><li>Unlimited seats</li><li>SSO</li></ul></div>
      </div></main>
    </body></html>`;
    const schema = {
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
    const result = extractWithSchemaDetailed(grid, schema);
    const tiers = result.values.tiers as Array<Record<string, unknown>>;
    expect(tiers).toHaveLength(3);
    expect(tiers[0].name).toBe('Starter');
    expect(tiers[0].price).toBe('$29');
    expect(tiers[0].key_features).toEqual(['10 seats', 'Email support']);
    expect(tiers[2].price).toBe('Contact sales');
    expect(tiers[2].key_features).toEqual(['Unlimited seats', 'SSO']);
    expect(result.provenance.tiers).toBe('structured');
  });

  it('does NOT manufacture a tiers[] from an unrelated grid (no matching columns)', () => {
    // A weather/spec grid whose headers do not fuzzy-match ANY item property
    // must NOT populate the array — the no-false-positive invariant holds for
    // nested schemas too.
    const html = `<html><body>
      <table>
        <thead><tr><th>City</th><th>Temperature</th></tr></thead>
        <tbody>
          <tr><td>Oslo</td><td>2C</td></tr>
          <tr><td>Cairo</td><td>30C</td></tr>
          <tr><td>Lima</td><td>18C</td></tr>
        </tbody>
      </table>
    </body></html>`;
    const schema = {
      type: 'object',
      properties: {
        tiers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              plan_name: { type: 'string' },
              monthly_price: { type: 'string' },
            },
          },
        },
      },
    };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.tiers).toBeUndefined();
  });

  it('leaves a flat (non-array) schema behaviour unchanged', () => {
    // Regression: the nested-array path must not perturb scalar field matching.
    const html = `<html><body>
      <table><thead><tr><th>Plan</th><th>Price</th></tr></thead>
      <tbody><tr><td>Pro</td><td>$29</td></tr></tbody></table>
    </body></html>`;
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' }, price: { type: 'string' } },
    };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.values.plan).toBe('Pro');
    expect(result.values.price).toBe('$29');
  });
});
