'use strict';

const { Marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const DEFAULT_EXCERPT_LENGTH = 160;
const CALLOUT_TYPES = new Set([
  'alert',
  'notice',
  'info',
  'success',
  'warning',
  'error'
]);

const ALLOWED_TAGS = [
  ...new Set([...sanitizeHtml.defaults.allowedTags, 'del', 'img'])
];

const CALLOUT_CLASSES = [...CALLOUT_TYPES].map((type) => `dl-callout-${type}`);

const SANITIZE_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    figure: ['class'],
    blockquote: ['class'],
    figcaption: ['class'],
    div: ['class'],
    span: ['class', 'data-text']
  },
  allowedClasses: {
    figure: ['dl-editorial-pullquote'],
    blockquote: ['dl-quote-body'],
    figcaption: ['dl-quote-author'],
    div: [
      'dl-callout',
      ...CALLOUT_CLASSES,
      'dl-callout-header',
      'dl-callout-body'
    ],
    span: ['dl-glitch-text', 'dl-dropcap']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https']
  },
  allowProtocolRelative: false
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read an opening shortcode without treating brackets inside quoted values as
 * the end of the tag. Newlines are not valid inside an opening tag.
 */
function readOpeningTag(source, name, block) {
  const indent = block ? ' {0,3}' : '';
  const prefix = new RegExp(`^${indent}\\[${name}`, 'i').exec(source);

  if (!prefix) return null;

  let quote = null;
  for (let index = prefix[0].length; index < source.length; index += 1) {
    const character = source[index];

    if (character === '\n' || character === '\r') return null;

    if (quote) {
      if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ']') {
      return {
        raw: source.slice(0, index + 1),
        attributes: source.slice(prefix[0].length, index)
      };
    }
  }

  return null;
}

/**
 * Parse only explicitly supported name="value" (or single-quoted)
 * attributes. Unknown, duplicate, or malformed attributes make the complete
 * shortcode plain Markdown text rather than partially trusted markup.
 */
function parseAttributes(source, allowedNames) {
  const attributes = Object.create(null);
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /[\t ]/.test(source[index])) index += 1;
    if (index === source.length) return attributes;

    const nameMatch = /^[a-z][a-z0-9_-]*/i.exec(source.slice(index));
    if (!nameMatch) return null;

    const name = nameMatch[0].toLowerCase();
    if (!allowedNames.includes(name) || Object.hasOwn(attributes, name)) {
      return null;
    }
    index += nameMatch[0].length;

    while (index < source.length && /[\t ]/.test(source[index])) index += 1;
    if (source[index] !== '=') return null;
    index += 1;
    while (index < source.length && /[\t ]/.test(source[index])) index += 1;

    const quote = source[index];
    if (quote !== '"' && quote !== "'") return null;
    index += 1;

    const valueStart = index;
    while (index < source.length && source[index] !== quote) index += 1;
    if (index === source.length) return null;

    attributes[name] = source.slice(valueStart, index);
    index += 1;
  }

  return attributes;
}

function createShortcodeExtension(name, level, allowedAttributes, renderer) {
  const block = level === 'block';
  const openingNeedle = `[${name}`;
  const closingNeedle = `[/${name}]`;

  return {
    name,
    level,
    start(source) {
      const index = source.toLowerCase().indexOf(openingNeedle);
      return index === -1 ? undefined : index;
    },
    tokenizer(source) {
      const opening = readOpeningTag(source, name, block);
      if (!opening) return undefined;

      const attributes = parseAttributes(opening.attributes, allowedAttributes);
      if (!attributes) return undefined;

      const lowerSource = source.toLowerCase();
      const closingIndex = lowerSource.indexOf(closingNeedle, opening.raw.length);
      if (closingIndex === -1) return undefined;

      const rawEnd = closingIndex + closingNeedle.length;
      const text = source.slice(opening.raw.length, closingIndex);
      const token = {
        type: name,
        raw: source.slice(0, rawEnd),
        text,
        attributes
      };

      token.tokens = block
        ? this.lexer.blockTokens(text)
        : this.lexer.inlineTokens(text);

      return token;
    },
    renderer
  };
}

const extensions = [
  createShortcodeExtension('pullquote', 'block', ['author'], function (token) {
    const body = this.parser.parse(token.tokens);
    const author = token.attributes.author;
    const caption = author
      ? `<figcaption class="dl-quote-author">// ${escapeHtml(author)}</figcaption>`
      : '';

    return `<figure class="dl-editorial-pullquote"><blockquote class="dl-quote-body">${body}</blockquote>${caption}</figure>\n`;
  }),
  createShortcodeExtension('callout', 'block', ['type'], function (token) {
    const requestedType = (token.attributes.type || 'notice').toLowerCase();
    const type = CALLOUT_TYPES.has(requestedType) ? requestedType : 'notice';
    const body = this.parser.parse(token.tokens);

    return `<div class="dl-callout dl-callout-${type}"><div class="dl-callout-header">// SYSTEM NOTICE // ${type.toUpperCase()}</div><div class="dl-callout-body">${body}</div></div>\n`;
  }),
  createShortcodeExtension('glitch', 'inline', [], function (token) {
    const body = this.parser.parseInline(token.tokens);
    return `<span class="dl-glitch-text" data-text="${escapeHtml(token.text)}">${body}</span>`;
  }),
  createShortcodeExtension('dropcap', 'inline', [], function (token) {
    return `<span class="dl-dropcap">${this.parser.parseInline(token.tokens)}</span>`;
  })
];

// A private instance avoids changing Marked's global configuration or being
// affected by extensions registered elsewhere in the application.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  extensions
});

/**
 * Render Markdown and Deadletters shortcodes to deterministic, sanitized HTML.
 */
function renderContent(source) {
  if (source == null || source === '') return '';
  const rendered = markdown.parse(String(source), { async: false });
  return sanitizeHtml(rendered, SANITIZE_OPTIONS);
}

// Addon filters may return HTML rather than Markdown. Sanitize their output
// again before it reaches any browser or feed consumer.
function sanitizeRenderedContent(source) {
  if (source == null || source === '') return '';
  return sanitizeHtml(String(source), SANITIZE_OPTIONS);
}

const HTML_ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
};

function decodeRemainingEntities(text) {
  return text.replace(/&([a-z]+);/gi, (entity, name) => {
    return Object.hasOwn(HTML_ENTITY_MAP, name.toLowerCase())
      ? HTML_ENTITY_MAP[name.toLowerCase()]
      : entity;
  });
}

/**
 * Convert the already-sanitized rendering to text. Structural closing tags
 * become spaces before tags are removed so adjacent blocks do not run together.
 */
function htmlToText(html) {
  const withBreaks = html
    .replace(/<div class="dl-callout-header">[\s\S]*?<\/div>/gi, ' ')
    .replace(/<img\b([^>]*)\/?>/gi, (image, attributes) => {
      const alt = /\balt="([^"]*)"/i.exec(attributes);
      return alt ? ` ${alt[1]} ` : ' ';
    })
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<hr\s*\/?>/gi, ' ')
    .replace(/<\/(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)>/gi, ' ');

  const text = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {}
  });

  return decodeRemainingEntities(text).replace(/\s+/g, ' ').trim();
}

/**
 * Return a plain-text excerpt no longer than maxLength Unicode code points.
 */
function renderExcerpt(source, maxLength = DEFAULT_EXCERPT_LENGTH) {
  const text = htmlToText(renderContent(source));
  const numericLimit = Number(maxLength);
  const limit = Number.isFinite(numericLimit)
    ? Math.max(0, Math.floor(numericLimit))
    : DEFAULT_EXCERPT_LENGTH;

  if (limit === 0) return '';

  const characters = Array.from(text);
  if (characters.length <= limit) return text;

  return characters.slice(0, limit).join('').trimEnd();
}

module.exports = {
  renderContent,
  renderExcerpt,
  sanitizeRenderedContent
};
