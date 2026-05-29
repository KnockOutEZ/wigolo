import { describe, it, expectTypeOf, expect } from 'vitest';
import type {
  CategoryDef,
  CategoryId,
  Ctx,
  FieldDef,
  FieldKind,
  FieldOption,
} from '../../../../../src/cli/tui/schema/types.js';

describe('schema/types', () => {
  it('FieldKind enumerates the supported renderers', () => {
    const kinds: FieldKind[] = [
      'text',
      'number',
      'select',
      'multiselect',
      'toggle',
      'masked',
      'path',
      'readonly',
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('CategoryId enumerates the six expected category buckets', () => {
    const ids: CategoryId[] = ['browser', 'search', 'llm', 'agents', 'cache', 'advanced'];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('FieldDef requires key/settingsPath/label/kind and accepts every modifier', () => {
    const visible: FieldDef['visible'] = (ctx: Ctx) =>
      typeof ctx.current === 'object' && typeof ctx.pending === 'object';
    const validate: FieldDef['validate'] = (v) => (typeof v === 'string' ? null : 'must be string');

    const opt: FieldOption = { value: 'chromium', label: 'Chromium', hint: 'default' };
    const field: FieldDef = {
      key: 'WIGOLO_BROWSER_TYPES',
      settingsPath: 'browserTypes',
      label: 'Engine',
      kind: 'select',
      help: 'help text',
      default: 'chromium',
      options: [opt],
      min: 1,
      max: 16,
      secret: true,
      propagateToAgents: true,
      visible,
      validate,
      futureNote: 'More engines coming soon.',
    };
    expectTypeOf(field).toEqualTypeOf<FieldDef>();
    expect(field.options?.[0]?.value).toBe('chromium');
  });

  it('CategoryDef carries an id/label/description plus a frozen-style readonly field list', () => {
    const cat: CategoryDef = {
      id: 'browser',
      label: 'Browser',
      description: 'Engine used for JS-rendered pages',
      fields: [],
      groups: [{ label: 'main', fieldKeys: ['WIGOLO_BROWSER_TYPES'] }],
    };
    expectTypeOf(cat.fields).toEqualTypeOf<ReadonlyArray<FieldDef>>();
    expect(cat.id).toBe('browser');
  });
});
