export class FieldCatalog {
  constructor(fields = []) {
    this.byId = new Map(fields.map((field) => [field.id, field]));
  }

  describe(id) {
    const field = this.byId.get(id) || {};
    return {id, name: field.name || id, schema_type: field.schema?.type || "unknown"};
  }

  customFields(fields) {
    return Object.entries(fields || {})
      .filter(([id, value]) => id.startsWith("customfield_") && !isEmpty(value))
      .map(([id, value]) => ({...this.describe(id), value: clean(value)}));
  }
}

export function isEmpty(value) {
  return value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

export function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter((item) => !isEmpty(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmpty(item)).map(([key, item]) => [key, clean(item)]));
  return value;
}
