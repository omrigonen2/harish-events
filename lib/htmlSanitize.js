const sanitizeHtml = require('sanitize-html');

const options = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'h1',
    'h2',
    'h3',
    'h4',
    'img',
    'span',
    'hr',
    'figure',
    'figcaption',
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    '*': ['class', 'style'],
    table: ['class'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb/, /^rgba/],
      'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
      'font-size': [/^\d+(?:px|em|rem|%)$/],
      'margin-left': [/^\d+(?:px|em|rem|%)$/],
      'margin-right': [/^\d+(?:px|em|rem|%)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https'],
  },
};

/**
 * Sanitize rich HTML for public display (event descriptions, etc.)
 */
function sanitizeDescription(html) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeHtml(html, options);
}

/**
 * Escape so raw HTML can be placed inside <textarea> (TinyMCE initial value)
 */
function escapeForTextarea(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<\/textarea/gi, '<\\/textarea');
}

module.exports = { sanitizeDescription, escapeForTextarea };
