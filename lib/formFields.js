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

function defaultFields() {
  return [
    {
      id: 'pf',
      type: 'parent_first',
      label: 'שם פרטי הורה',
      required: true,
      order: 0,
      options: [],
    },
    {
      id: 'pl',
      type: 'parent_last',
      label: 'שם משפחה הורה',
      required: true,
      order: 1,
      options: [],
    },
    {
      id: 'ph',
      type: 'phone',
      label: 'טלפון נייד',
      required: true,
      order: 2,
      options: [],
    },
    {
      id: 'ch',
      type: 'children',
      label: 'ילדים',
      required: true,
      order: 3,
      options: [],
      childNameLabel: 'שם הילד/ה',
      childAgeLabel: 'גיל',
    },
  ];
}

function sortByOrder(fields) {
  return [...(fields || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

/**
 * Merge legacy customFields into fields; ensure defaults exist once.
 */
function normalizeStoredFields(doc) {
  if (!doc) return defaultFields();
  let raw = [];
  if (doc.fields && doc.fields.length) {
    raw = doc.fields.map((f) =>
      typeof f.toObject === 'function' ? f.toObject() : { ...f }
    );
  } else if (doc.customFields && doc.customFields.length) {
    raw = [...defaultFields()];
    let o = raw.length;
    for (const c of doc.customFields) {
      const x = typeof c.toObject === 'function' ? c.toObject() : c;
      raw.push({
        id: x.id || crypto.randomBytes(8).toString('hex'),
        type: CUSTOM_TYPES.includes(x.type) ? x.type : 'text',
        label: x.label || 'שדה',
        required: Boolean(x.required),
        checkedByDefault: Boolean(x.checkedByDefault),
        order: typeof x.order === 'number' ? x.order : o,
        options: Array.isArray(x.options) ? x.options : [],
      });
      o += 1;
    }
  } else {
    raw = defaultFields();
  }

  const seen = new Set();
  const deduped = [];
  for (const f of sortByOrder(raw)) {
    const t = f.type;
    if (SYSTEM_TYPES.includes(t)) {
      if (seen.has(t)) continue;
      seen.add(t);
    }
    deduped.push(normalizeFieldShape(f, deduped.length));
  }

  for (const st of SYSTEM_TYPES) {
    if (!seen.has(st)) {
      const d = defaultFields().find((x) => x.type === st);
      if (d) deduped.push({ ...d });
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
  if (type === 'children') {
    base.childNameLabel = String(f.childNameLabel || 'שם הילד/ה').trim();
    base.childAgeLabel = String(f.childAgeLabel || 'גיל').trim();
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

function sanitizeFieldsFromBuilder(arr) {
  if (!Array.isArray(arr)) return defaultFields();
  const mapped = ensureUniqueCustomFieldIds(arr.map((f, i) => normalizeFieldShape({ ...f, order: i }, i)));
  const seen = new Set();
  const out = [];
  for (const f of mapped) {
    if (SYSTEM_TYPES.includes(f.type)) {
      if (seen.has(f.type)) continue;
      seen.add(f.type);
    }
    out.push(f);
  }
  for (const st of SYSTEM_TYPES) {
    if (!seen.has(st)) {
      const d = defaultFields().find((x) => x.type === st);
      if (d) out.push({ ...d, order: out.length });
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

function getFieldsForRender(configDoc) {
  return sortByOrder(ensureUniqueCustomFieldIds(normalizeStoredFields(configDoc || {})));
}

module.exports = {
  defaultFields,
  SYSTEM_TYPES,
  CUSTOM_TYPES,
  ALL_TYPES,
  sortByOrder,
  normalizeStoredFields,
  sanitizeFieldsFromBuilder,
  getCustomFieldDefs,
  getFieldsForRender,
  isCustomFieldType,
};
