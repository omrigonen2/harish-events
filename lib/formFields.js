const crypto = require('crypto');

const SYSTEM_TYPES = ['parent_first', 'parent_last', 'phone', 'children'];
const CUSTOM_TYPES = ['text', 'textarea', 'select', 'checkbox'];
const ALL_TYPES = [...SYSTEM_TYPES, ...CUSTOM_TYPES];
const SYSTEM_IDS_BY_TYPE = {
  parent_first: 'pf',
  parent_last: 'pl',
  phone: 'ph',
  children: 'ch',
};
const PLACEHOLDER_TYPES = ['parent_first', 'parent_last', 'phone', 'text', 'textarea'];

function resolveHasChildren(value) {
  return value !== false;
}

function requiredSystemTypes(hasChildren) {
  return hasChildren
    ? SYSTEM_TYPES
    : SYSTEM_TYPES.filter((t) => t !== 'children');
}

function defaultFields({ hasChildren = true } = {}) {
  const fields = [
    {
      id: 'pf',
      type: 'parent_first',
      label: 'שם פרטי הורה',
      placeholder: '',
      required: true,
      order: 0,
      options: [],
    },
    {
      id: 'pl',
      type: 'parent_last',
      label: 'שם משפחה הורה',
      placeholder: '',
      required: true,
      order: 1,
      options: [],
    },
    {
      id: 'ph',
      type: 'phone',
      label: 'טלפון נייד',
      placeholder: '',
      required: true,
      order: 2,
      options: [],
    },
  ];
  if (hasChildren) {
    fields.push({
      id: 'ch',
      type: 'children',
      label: 'ילדים',
      required: true,
      order: 3,
      options: [],
      childNameLabel: 'שם הילד/ה',
      childAgeLabel: 'גיל',
      collectAge: true,
      maxRows: null,
    });
  }
  return fields;
}

function sortByOrder(fields) {
  return [...(fields || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

/**
 * Merge legacy customFields into fields; ensure system fields are present.
 *
 * @param {object} doc - FormConfig document or plain object.
 * @param {object} [options]
 * @param {boolean} [options.hasChildren=true] - When false, the children system field is dropped if present and never re-injected.
 */
function normalizeStoredFields(doc, { hasChildren = true } = {}) {
  const allowChildren = resolveHasChildren(hasChildren);
  if (!doc) return defaultFields({ hasChildren: allowChildren });
  let raw = [];
  if (doc.fields && doc.fields.length) {
    raw = doc.fields.map((f) =>
      typeof f.toObject === 'function' ? f.toObject() : { ...f }
    );
  } else if (doc.customFields && doc.customFields.length) {
    raw = [...defaultFields({ hasChildren: allowChildren })];
    let o = raw.length;
    for (const c of doc.customFields) {
      const x = typeof c.toObject === 'function' ? c.toObject() : c;
      raw.push({
        id: x.id || crypto.randomBytes(8).toString('hex'),
        type: CUSTOM_TYPES.includes(x.type) ? x.type : 'text',
        label: x.label || 'שדה',
        placeholder: typeof x.placeholder === 'string' ? x.placeholder : '',
        required: Boolean(x.required),
        checkedByDefault: Boolean(x.checkedByDefault),
        order: typeof x.order === 'number' ? x.order : o,
        options: Array.isArray(x.options) ? x.options : [],
      });
      o += 1;
    }
  } else {
    raw = defaultFields({ hasChildren: allowChildren });
  }

  const seen = new Set();
  const deduped = [];
  for (const f of sortByOrder(raw)) {
    const t = f.type;
    if (SYSTEM_TYPES.includes(t)) {
      if (seen.has(t)) continue;
      seen.add(t);
    }
    const coerced = !allowChildren && t === 'children' ? { ...f, collectAge: false } : f;
    deduped.push(normalizeFieldShape(coerced, deduped.length));
  }

  for (const st of requiredSystemTypes(allowChildren)) {
    if (!seen.has(st)) {
      const d = defaultFields({ hasChildren: allowChildren }).find((x) => x.type === st);
      if (d) deduped.push(normalizeFieldShape({ ...d, order: deduped.length }, deduped.length));
    }
  }

  return sortByOrder(deduped).map((f, i) => ({ ...f, order: i }));
}

function cleanFieldId(raw) {
  const value = String(raw || '').trim();
  if (!value || value === 'undefined' || value === 'null' || value === '[object Object]') return '';
  return value.replace(/[^\w-]/g, '_').slice(0, 64);
}

function fallbackFieldId(f, index) {
  const seed = `${f.type || 'field'}|${f.label || ''}|${index}`;
  return `f_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10)}`;
}

function uniqueFieldId(base, used) {
  let id = base;
  let n = 1;
  while (used.has(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function normalizeFieldShape(f, index = 0) {
  const type = ALL_TYPES.includes(f.type) ? f.type : 'text';
  const id = SYSTEM_IDS_BY_TYPE[type] || cleanFieldId(f.id) || fallbackFieldId(f, index);
  const base = {
    id,
    type,
    label: String(f.label || '').trim() || 'שדה',
    required: Boolean(f.required),
    order: typeof f.order === 'number' ? f.order : 0,
    options: Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [],
  };
  if (PLACEHOLDER_TYPES.includes(type)) {
    base.placeholder = String(f.placeholder || '').trim();
  }
  if (type === 'children') {
    base.childNameLabel = String(f.childNameLabel || 'שם הילד/ה').trim();
    base.childAgeLabel = String(f.childAgeLabel || 'גיל').trim();
    /* Explicit false wins; missing stays legacy-default true (collect ages). */
    const ca = f.collectAge;
    const caStr = typeof ca === 'string' ? ca.trim().toLowerCase() : '';
    base.collectAge = !(
      ca === false ||
      ca === 0 ||
      ca === 'false' ||
      ca === '0' ||
      caStr === 'false' ||
      caStr === '0'
    );
    const rawMax = f.maxRows;
    let maxRows = null;
    if (rawMax !== undefined && rawMax !== null && rawMax !== '') {
      const n = parseInt(rawMax, 10);
      if (!Number.isNaN(n) && n >= 1) maxRows = n;
    }
    base.maxRows = maxRows;
  } else if (type === 'checkbox') {
    base.checkedByDefault = Boolean(f.checkedByDefault);
  }
  return base;
}

function ensureUniqueCustomFieldIds(fields) {
  const usedCustomIds = new Set();
  return fields.map((field, index) => {
    if (!CUSTOM_TYPES.includes(field.type)) return field;
    const id = uniqueFieldId(cleanFieldId(field.id) || fallbackFieldId(field, index), usedCustomIds);
    return id === field.id ? field : { ...field, id };
  });
}

function sanitizeFieldsFromBuilder(arr, { hasChildren = true } = {}) {
  const allowChildren = resolveHasChildren(hasChildren);
  if (!Array.isArray(arr)) return defaultFields({ hasChildren: allowChildren });
  const coerced = arr.map((f) => {
    if (!allowChildren && f && f.type === 'children') {
      return { ...f, collectAge: false };
    }
    return f;
  });
  const mapped = ensureUniqueCustomFieldIds(coerced.map((f, i) => normalizeFieldShape({ ...f, order: i }, i)));
  const seen = new Set();
  const out = [];
  for (const f of mapped) {
    if (SYSTEM_TYPES.includes(f.type)) {
      if (seen.has(f.type)) continue;
      seen.add(f.type);
    }
    out.push(f);
  }
  for (const st of requiredSystemTypes(allowChildren)) {
    if (!seen.has(st)) {
      const d = defaultFields({ hasChildren: allowChildren }).find((x) => x.type === st);
      if (d)
        out.push(
          normalizeFieldShape({ ...d, order: out.length }, out.length)
        );
    }
  }
  return out.map((f, i) => ({ ...f, order: i }));
}

function isCustomFieldType(type) {
  return CUSTOM_TYPES.includes(type);
}

function getCustomFieldDefs(fields) {
  return sortByOrder(fields).filter((f) => isCustomFieldType(f.type));
}

function getFieldsForRender(configDoc, { hasChildren = true } = {}) {
  const allowChildren = resolveHasChildren(hasChildren);
  return sortByOrder(
    ensureUniqueCustomFieldIds(
      normalizeStoredFields(configDoc || {}, { hasChildren: allowChildren })
    )
  );
}

module.exports = {
  defaultFields,
  SYSTEM_TYPES,
  CUSTOM_TYPES,
  ALL_TYPES,
  PLACEHOLDER_TYPES,
  sortByOrder,
  normalizeStoredFields,
  sanitizeFieldsFromBuilder,
  getCustomFieldDefs,
  getFieldsForRender,
  isCustomFieldType,
};
