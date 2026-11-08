const fs = require('fs');
const path = require('path');
const { getDb, getOption } = require('./db');
const hooks = require('./hooks');

const SHELL_PATH = path.join(__dirname, '..', '..', 'public', 'app', 'index.html');
const METADATA_PATTERN = /<!-- DL_METADATA_START -->[\s\S]*?<!-- DL_METADATA_END -->/;
const ROUTE_PLACEHOLDER = '<!-- DL_INITIAL_ROUTE -->';
let cachedShell = null;

function cleanText(value, maximumLength = 500) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maximumLength);
}

function escapeHtml(value) {
  return cleanText(value, Number.MAX_SAFE_INTEGER).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

// JSON inside a script element must not be able to close that element. Escaping
// these characters as unicode also keeps JSON.parse and JSON-LD semantics intact.
function serializeJson(value) {
  return JSON.stringify(value)
    .replace(/[<>&\u2028\u2029]/g, character => ({
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029'
    })[character]);
}

function initialRouteFromPathname(pathname) {
  if (/^\/?$/.test(pathname || '')) {
    return { type: 'home', hash: '#/', publicPath: '/' };
  }

  const contentMatch = /^\/(letter|page)\/([^/]+)\/?$/.exec(pathname || '');
  if (contentMatch) {
    try {
      const type = contentMatch[1];
      const slug = decodeURIComponent(contentMatch[2]);
      if (!slug || /[\/\\\0]/.test(slug)) return null;
      const encodedSlug = encodeURIComponent(slug);
      return {
        type,
        slug,
        hash: `#/${type}/${encodedSlug}`,
        publicPath: `/${type}/${encodedSlug}`
      };
    } catch {
      return null;
    }
  }

  const staticMatch = /^\/(reshares|remote|admin|installer)\/?$/.exec(pathname || '');
  if (!staticMatch) return null;
  const type = staticMatch[1];
  return { type, hash: `#/${type}`, publicPath: `/${type}` };
}

function normalizeBaseUrl(...candidates) {
  for (const candidate of candidates) {
    try {
      const parsed = new URL(cleanText(candidate, 2048));
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      parsed.hash = '';
      parsed.search = '';
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      return parsed.href.replace(/\/$/, '');
    } catch {}
  }
  return 'http://localhost:3000';
}

function safeMetadataUrl(value, baseUrl, fallback = '') {
  const candidate = cleanText(value, 2048);
  if (!candidate || candidate.startsWith('//')) return fallback;
  if (!/^\/(?!\/)/.test(candidate) && !/^https?:\/\//i.test(candidate)) return fallback;

  try {
    const parsed = new URL(candidate, `${baseUrl}/`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return fallback;
    return parsed.href;
  } catch {
    return fallback;
  }
}

function isoDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function metadataExcerpt(post) {
  const source = cleanText(post.post_excerpt, 10000) || cleanText(post.post_content, 10000);
  const excerpt = source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return cleanText(excerpt || post.post_title, 300);
}

function findPublicPost(route) {
  if (!route || !['letter', 'page'].includes(route.type)) return null;
  const db = getDb();
  const types = route.type === 'page' ? ['page'] : ['post', 'reshare'];
  const placeholders = types.map(() => '?').join(', ');
  return db.prepare(`
    SELECT p.*, u.display_name AS author_name
    FROM dl_posts p
    JOIN dl_users u ON p.post_author = u.ID
    WHERE p.post_name = ?
      AND p.post_status = 'publish'
      AND p.post_type IN (${placeholders})
  `).get(route.slug, ...types) || null;
}

function sanitizeJsonValue(value, depth = 0) {
  if (depth > 12) return null;
  if (typeof value === 'string') return cleanText(value, 10000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;

  const sanitized = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !/^[@a-zA-Z0-9:_.-]{1,100}$/.test(key)) continue;
    const cleanValue = sanitizeJsonValue(item, depth + 1);
    if (cleanValue !== undefined) sanitized[key] = cleanValue;
  }
  return sanitized;
}

function renderMetadata({ post, route, site, requestOrigin, hookEngine = hooks }) {
  const siteTitle = cleanText(site.title, 200) || 'Deadletters';
  const siteTagline = cleanText(site.tagline, 300) || 'the plug is dead. stay wired.';
  const baseUrl = normalizeBaseUrl(site.url, requestOrigin);
  const isPublicContent = Boolean(post && route && ['letter', 'page'].includes(route.type));
  const canonicalPath = isPublicContent || ['home', 'reshares', 'remote'].includes(route?.type) ? route.publicPath : null;
  const canonical = canonicalPath ? safeMetadataUrl(canonicalPath, baseUrl) : '';
  const defaultImage = safeMetadataUrl('/uploads/deadplug_editorial_cover.jpg', baseUrl);
  const image = isPublicContent ? safeMetadataUrl(post.featured_image, baseUrl, defaultImage) : defaultImage;
  const postTitle = isPublicContent ? cleanText(post.post_title, 500) || 'Untitled Letter' : '';
  const title = isPublicContent ? `${postTitle} | ${siteTitle}` : siteTitle;
  const description = isPublicContent ? metadataExcerpt(post) : siteTagline;
  const schemaType = !isPublicContent ? 'WebSite' : (post.post_type === 'page' ? 'WebPage' : 'BlogPosting');

  const coreSchema = {
    '@context': 'https://schema.org',
    '@type': schemaType,
    name: postTitle || siteTitle,
    description,
    ...(canonical ? {
      url: canonical,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical }
    } : {}),
    image: [image],
    ...(isPublicContent ? {
      headline: postTitle,
      datePublished: isoDate(post.post_date),
      dateModified: isoDate(post.post_modified),
      author: {
        '@type': 'Person',
        name: cleanText(post.author_name, 300) || 'Deadplug Operator'
      }
    } : {}),
    publisher: {
      '@type': 'Organization',
      name: siteTitle,
      url: baseUrl
    }
  };

  const coreTags = [
    { tag: 'title', content: title },
    { rel: 'canonical', href: canonical },
    { name: 'description', content: description },
    ...(isPublicContent ? [{ name: 'author', content: post.author_name }] : []),
    ...(!isPublicContent && ['letter', 'page', 'admin', 'installer'].includes(route?.type)
      ? [{ name: 'robots', content: 'noindex,nofollow' }]
      : []),
    { property: 'og:site_name', content: siteTitle },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:type', content: isPublicContent ? 'article' : 'website' },
    { property: 'og:url', content: canonical },
    { property: 'og:image', content: image },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: image },
    { type: 'application/ld+json', content: JSON.stringify(coreSchema) }
  ];

  // The bundled SEO Guardian addon consumes this array shape. Its additions are
  // treated as untrusted input and normalized below before entering the shell.
  const filtered = hookEngine.applyFilters('render_meta_tags', coreTags, isPublicContent ? post : null, {
    title: siteTitle,
    tagline: siteTagline,
    url: baseUrl
  });
  const tags = Array.isArray(filtered) ? filtered.slice(0, 200) : coreTags;

  let finalTitle = title;
  let finalCanonical = canonical;
  let finalSchema = coreSchema;
  const metaTags = new Map();
  const requiredMeta = new Map();

  for (const tag of coreTags) {
    if (!tag.name && !tag.property) continue;
    const kind = tag.name ? 'name' : 'property';
    const key = `${kind}:${tag.name || tag.property}`;
    requiredMeta.set(key, tag.content);
    metaTags.set(key, { kind, name: tag.name || tag.property, content: tag.content });
  }

  for (const tag of tags) {
    if (!tag || typeof tag !== 'object') continue;
    if (tag.tag === 'title') {
      finalTitle = cleanText(tag.content, 500) || title;
      continue;
    }
    if (tag.rel === 'canonical') {
      finalCanonical = safeMetadataUrl(tag.href || tag.content, baseUrl, canonical);
      continue;
    }
    if (tag.type === 'application/ld+json') {
      try {
        const parsed = typeof tag.content === 'string' ? JSON.parse(tag.content) : tag.content;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          finalSchema = { ...finalSchema, ...parsed };
        }
      } catch {}
      continue;
    }

    const kind = tag.name ? 'name' : (tag.property ? 'property' : null);
    const name = cleanText(tag.name || tag.property, 100);
    if (!kind || !/^[a-zA-Z0-9:_.-]+$/.test(name)) continue;
    metaTags.set(`${kind}:${name}`, { kind, name, content: tag.content });
  }

  // Required public metadata remains present even if an addon emits an empty or
  // malformed override. URL-bearing fields receive protocol validation as well.
  for (const [key, fallback] of requiredMeta) {
    const current = metaTags.get(key);
    if (!current || !cleanText(current.content, 2048)) {
      metaTags.set(key, { ...current, content: fallback });
    }
  }

  finalSchema = sanitizeJsonValue(finalSchema) || coreSchema;
  finalSchema['@context'] = 'https://schema.org';
  finalSchema['@type'] = schemaType;
  finalSchema.name = cleanText(finalSchema.name, 500) || postTitle || siteTitle;
  finalSchema.description = cleanText(finalSchema.description, 300) || description;
  if (isPublicContent) finalSchema.headline = cleanText(finalSchema.headline, 500) || postTitle;
  if (canonical) {
    finalSchema.url = canonical;
    finalSchema.mainEntityOfPage = { '@type': 'WebPage', '@id': canonical };
  } else {
    delete finalSchema.url;
    delete finalSchema.mainEntityOfPage;
  }
  const schemaImages = Array.isArray(finalSchema.image) ? finalSchema.image : [finalSchema.image];
  finalSchema.image = [safeMetadataUrl(schemaImages.find(Boolean), baseUrl, image)];

  const lines = [
    `<title>${escapeHtml(finalTitle)}</title>`
  ];
  if (finalCanonical) lines.push(`<link rel="canonical" href="${escapeHtml(finalCanonical)}">`);

  for (const tag of metaTags.values()) {
    let content = cleanText(tag.content, 2048);
    if (['og:url', 'og:image', 'twitter:image'].includes(tag.name)) {
      content = safeMetadataUrl(content, baseUrl, tag.name === 'og:url' ? finalCanonical : image);
    } else {
      content = cleanText(content, tag.name.toLowerCase().includes('description') ? 300 : 500);
    }
    if (!content) continue;
    lines.push(`<meta ${tag.kind}="${escapeHtml(tag.name)}" content="${escapeHtml(content)}">`);
  }

  lines.push(`<script type="application/ld+json">${serializeJson(finalSchema)}</script>`);
  return lines.join('\n  ');
}

function injectAppShell(shell, route, metadataHtml) {
  if (!METADATA_PATTERN.test(shell) || !shell.includes(ROUTE_PLACEHOLDER)) {
    throw new Error('Public app shell is missing server injection markers.');
  }

  const routeScript = `<script id="dl-initial-route" type="application/json">${serializeJson({ hash: route.hash })}</script>`;
  return shell
    .replace(METADATA_PATTERN, () => `<!-- DL_METADATA_START -->\n  ${metadataHtml}\n  <!-- DL_METADATA_END -->`)
    .replace(ROUTE_PLACEHOLDER, () => routeScript);
}

function getAppShell() {
  if (cachedShell === null) cachedShell = fs.readFileSync(SHELL_PATH, 'utf8');
  return cachedShell;
}

function renderAppShell(req) {
  const route = initialRouteFromPathname(req.path);
  if (!route) return null;

  const post = findPublicPost(route);
  const requestOrigin = normalizeBaseUrl(`${req.protocol}://${req.get('host')}`);
  const metadataHtml = renderMetadata({
    post,
    route,
    requestOrigin,
    site: {
      title: getOption('site_title', 'Deadletters // Deadplug Atelier'),
      tagline: getOption('site_tagline', 'the plug is dead. stay wired.'),
      url: getOption('site_url', requestOrigin)
    }
  });
  return injectAppShell(getAppShell(), route, metadataHtml);
}

module.exports = {
  cleanText,
  escapeHtml,
  serializeJson,
  initialRouteFromPathname,
  safeMetadataUrl,
  renderMetadata,
  injectAppShell,
  renderAppShell
};
