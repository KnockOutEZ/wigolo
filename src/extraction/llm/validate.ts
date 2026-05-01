// Minimal recursive JSON Schema validator: required + type checks.
// Sufficient for post-hoc validation of provider responses where the SDK
// does not enforce a schema natively (e.g. Groq json_object).

export interface ValidationError {
  path: string;
  message: string;
}

interface SchemaShape {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaShape>;
  items?: SchemaShape;
}

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  walk(value, schema as SchemaShape, '$', errors);
  return errors;
}

function walk(
  value: unknown,
  schema: SchemaShape,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `expected type ${types.join('|')} but got ${actualType(value)}`,
      });
      return;
    }
  }

  if (schema.type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined) {
        errors.push({ path: `${path}.${req}`, message: 'required' });
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[k] !== undefined) {
        walk(obj[k], sub, `${path}.${k}`, errors);
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) =>
      walk(item, schema.items as SchemaShape, `${path}[${i}]`, errors),
    );
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
