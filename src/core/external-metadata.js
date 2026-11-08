const dns = require('node:dns');
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// HTML named entities have no built-in decoder in Node. Cover the entities most
// often found in metadata, plus all numeric entities; unknown names are kept.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', deg: '°', plusmn: '±', times: '×', divide: '÷',
  cent: '¢', pound: '£', yen: '¥', euro: '€', sect: '§', para: '¶',
  middot: '·', bull: '•', dagger: '†', Dagger: '‡', permil: '‰',
  prime: '′', Prime: '″', frasl: '⁄', minus: '−'
};

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],        // "This host on this network" and unspecified.
  ['10.0.0.0', 8],       // RFC 1918.
  ['100.64.0.0', 10],    // Carrier-grade NAT / shared address space.
  ['127.0.0.0', 8],      // Loopback.
  ['169.254.0.0', 16],   // Link-local.
  ['172.16.0.0', 12],    // RFC 1918.
  ['192.0.0.0', 24],     // IETF protocol assignments.
  ['192.0.2.0', 24],     // Documentation.
  ['192.88.99.0', 24],   // Deprecated 6to4 relay anycast.
  ['192.168.0.0', 16],   // RFC 1918.
  ['198.18.0.0', 15],    // Benchmarking.
  ['198.51.100.0', 24],  // Documentation.
  ['203.0.113.0', 24],   // Documentation.
  ['224.0.0.0', 4],      // Multicast.
  ['240.0.0.0', 4]       // Reserved, including the limited broadcast address.
].map(([address, prefix]) => [ipv4Number(address), prefix]);

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((address & mask) >>> 0) === ((network & mask) >>> 0);
}

function parseIpv6(address) {
  if (net.isIP(address) !== 6) return null;

  const halves = address.split('::');
  if (halves.length > 2) return null;

  function parseGroups(part) {
    if (!part) return [];
    const tokens = part.split(':');
    const groups = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.includes('.')) {
        if (index !== tokens.length - 1) return null;
        const ipv4 = ipv4Number(token);
        if (ipv4 === null) return null;
        groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      } else {
        if (!/^[\da-f]{1,4}$/i.test(token)) return null;
        groups.push(parseInt(token, 16));
      }
    }
    return groups;
  }

  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;

  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = head.concat(Array(missing).fill(0), tail);
  } else {
    groups = head;
    if (groups.length !== 8) return null;
  }

  const bytes = [];
  for (const group of groups) bytes.push(group >>> 8, group & 0xff);
  return bytes;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const ipv4 = ipv4Number(address);
    return ipv4 !== null && !BLOCKED_IPV4_RANGES.some(([network, prefix]) => (
      inIpv4Range(ipv4, network, prefix)
    ));
  }

  if (family !== 6) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  const firstTenZero = bytes.slice(0, 10).every(byte => byte === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    // Do not let IPv4-mapped IPv6 notation bypass the IPv4 denylist.
    const embedded = bytes.slice(12).join('.');
    return isPublicAddress(embedded);
  }

  // Unspecified, loopback, and deprecated IPv4-compatible addresses.
  if (firstTenZero && bytes[10] === 0 && bytes[11] === 0) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique local.
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10.
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return false; // fec0::/10.
  if (bytes[0] === 0xff) return false; // ff00::/8 multicast.

  // Be conservative: only global unicast space is eligible. This rejects
  // unspecified/reserved ranges rather than trying to maintain an allowlist of
  // individual public networks.
  if ((bytes[0] & 0xe0) !== 0x20) return false; // Not 2000::/3.

  // Reject IETF special-use/transition space, documentation, and benchmarking.
  // This deliberately includes a few globally reachable exceptions in
  // 2001::/23; refusing those is safer for an SSRF boundary.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] & 0xfe) === 0) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 2002::/16 6to4.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return false; // 3fff::/20.

  return true;
}

function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error('Invalid external URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('External URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('External URL must not contain credentials.');
  }
  if (!parsed.hostname) throw new Error('External URL must contain a hostname.');

  // Only default web ports are exposed. Besides reducing SSRF surface, this
  // avoids using the metadata importer as a client for arbitrary TCP services.
  const port = parsed.port;
  if (port && !((parsed.protocol === 'http:' && port === '80') ||
                (parsed.protocol === 'https:' && port === '443'))) {
    throw new Error('External URL uses a nonstandard port.');
  }
  return parsed;
}

function hostnameForLookup(parsed) {
  // WHATWG URL retains brackets around an IPv6 hostname; dns.lookup does not.
  return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
}

async function validateDestination(parsed, lookup) {
  const hostname = hostnameForLookup(parsed);

  // IP literals need no DNS lookup and must be checked directly.
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new Error('External URL resolves to a private, reserved, or otherwise unsafe address.');
    }
    return;
  }

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Could not resolve external URL hostname: ${error.message}`);
  }

  if (!Array.isArray(records)) records = [records];
  const addresses = records.map(record => (
    typeof record === 'string' ? record : record && record.address
  )).filter(Boolean);

  if (addresses.length === 0 || addresses.length !== records.length) {
    throw new Error('DNS lookup returned no usable addresses for the external URL.');
  }

  // Every answer must be public. Otherwise an HTTP client could select the one
  // unsafe answer even when the hostname also has a legitimate public address.
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new Error('External URL resolves to a private, reserved, or otherwise unsafe address.');
    }
  }
}

function decodeEntities(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);?/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1].toLowerCase() === 'x';
      const digits = entity.slice(hexadecimal ? 2 : 1);
      const codePoint = parseInt(digits, hexadecimal ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return '\ufffd';
      }
      return String.fromCodePoint(codePoint);
    }

    const named = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity)
      ? NAMED_ENTITIES[entity]
      : NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function cleanText(value) {
  return decodeEntities(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function isWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\n' ||
    character === '\r' || character === '\f';
}

// Tokenize only enough HTML to read tags and their attributes. In particular,
// attribute order and quoting style do not matter, and quoted ">" characters
// do not terminate a tag. This is deliberately tolerant, not a complete DOM.
function readTag(html, start) {
  if (html[start] !== '<') return null;
  let index = start + 1;
  let closing = false;
  if (html[index] === '/') {
    closing = true;
    index += 1;
  }

  const nameStart = index;
  while (index < html.length && !isWhitespace(html[index]) &&
         html[index] !== '/' && html[index] !== '>') {
    index += 1;
  }
  const name = html.slice(nameStart, index).toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/i.test(name)) return null;

  const attributes = Object.create(null);
  while (index < html.length) {
    while (index < html.length && isWhitespace(html[index])) index += 1;
    if (html[index] === '>') {
      return { name, attributes, closing, start, end: index + 1 };
    }
    if (html[index] === '/') {
      index += 1;
      continue;
    }
    if (index >= html.length) break;

    const attributeStart = index;
    while (index < html.length && !isWhitespace(html[index]) &&
           html[index] !== '=' && html[index] !== '/' && html[index] !== '>') {
      index += 1;
    }
    if (index === attributeStart) {
      index += 1;
      continue;
    }

    const attributeName = html.slice(attributeStart, index).toLowerCase();
    while (index < html.length && isWhitespace(html[index])) index += 1;
    let attributeValue = '';

    if (html[index] === '=') {
      index += 1;
      while (index < html.length && isWhitespace(html[index])) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < html.length && html[index] !== quote) index += 1;
        attributeValue = html.slice(valueStart, index);
        if (html[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < html.length && !isWhitespace(html[index]) && html[index] !== '>') {
          index += 1;
        }
        attributeValue = html.slice(valueStart, index);
      }
    }

    // HTML specifies that the first duplicate attribute wins.
    if (!Object.prototype.hasOwnProperty.call(attributes, attributeName)) {
      attributes[attributeName] = decodeEntities(attributeValue);
    }
  }

  // Preserve an unterminated final tag as a best effort for malformed HTML.
  return { name, attributes, closing, start, end: html.length };
}

function findClosingTag(html, lowerHtml, from, name) {
  let index = lowerHtml.indexOf(`</${name}`, from);
  while (index !== -1) {
    const tag = readTag(html, index);
    if (tag && tag.closing && tag.name === name) return tag;
    index = lowerHtml.indexOf(`</${name}`, index + 2);
  }
  return null;
}

function parseMetadata(html, finalUrl) {
  const metas = new Map();
  const canonicalLinks = [];
  let documentTitle = '';
  let position = 0;
  const lowerHtml = html.toLowerCase();

  function addMeta(key, value) {
    if (!key || !value) return;
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) return;
    if (!metas.has(normalizedKey)) metas.set(normalizedKey, []);
    metas.get(normalizedKey).push(normalizedValue);
  }

  while (position < html.length) {
    const start = html.indexOf('<', position);
    if (start === -1) break;

    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      position = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html.startsWith('<!', start) || html.startsWith('<?', start)) {
      const declarationEnd = html.indexOf('>', start + 2);
      position = declarationEnd === -1 ? html.length : declarationEnd + 1;
      continue;
    }

    const tag = readTag(html, start);
    if (!tag) {
      position = start + 1;
      continue;
    }
    position = tag.end;
    if (tag.closing) continue;

    if (tag.name === 'title') {
      const closing = findClosingTag(html, lowerHtml, tag.end, 'title');
      const textEnd = closing ? closing.start : html.length;
      if (!documentTitle) documentTitle = cleanText(html.slice(tag.end, textEnd));
      position = closing ? closing.end : html.length;
      continue;
    }

    // Metadata-like text inside raw-text elements is not document metadata.
    if (['script', 'style', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes'].includes(tag.name)) {
      const closing = findClosingTag(html, lowerHtml, tag.end, tag.name);
      position = closing ? closing.end : html.length;
      continue;
    }

    if (tag.name === 'meta') {
      const key = tag.attributes.property || tag.attributes.name || tag.attributes['http-equiv'];
      addMeta(key, tag.attributes.content);
    } else if (tag.name === 'link' && tag.attributes.href) {
      const rel = (tag.attributes.rel || '').toLowerCase().split(/\s+/);
      if (rel.includes('canonical')) canonicalLinks.push(tag.attributes.href.trim());
    }
  }

  function firstMeta(...names) {
    for (const name of names) {
      const values = metas.get(name);
      if (values && values.length) return values[0];
    }
    return '';
  }

  function safeResolvedUrl(rawValue) {
    if (!rawValue) return null;
    try {
      return parseHttpUrl(new URL(rawValue.trim(), finalUrl)).href;
    } catch {
      return null;
    }
  }

  const sourceUrl = safeResolvedUrl(canonicalLinks[0] || firstMeta('og:url')) || finalUrl.href;
  const featuredImage = safeResolvedUrl(firstMeta('og:image', 'og:image:secure_url', 'twitter:image'));

  return {
    sourceUrl,
    sourceNode: new URL(sourceUrl).hostname,
    originalTitle: firstMeta('og:title', 'twitter:title') || documentTitle || sourceUrl,
    originalExcerpt: firstMeta('og:description', 'description', 'twitter:description'),
    originalAuthor: firstMeta('author', 'article:author') || new URL(sourceUrl).hostname,
    featuredImage
  };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return null;
}

async function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    // The original validation error is more useful than a body-cleanup error.
  }
}

async function readLimitedBody(response, signal) {
  const declaredLength = Number(getHeader(response.headers, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    await discardBody(response);
    throw new Error('External HTML response exceeds the 1 MiB body limit.');
  }

  const body = response.body;
  const chunks = [];
  let total = 0;

  function append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('External HTML response exceeds the 1 MiB body limit.');
    }
    chunks.push(buffer);
  }

  if (!body) {
    if (typeof response.arrayBuffer === 'function') {
      append(Buffer.from(await response.arrayBuffer()));
    } else if (typeof response.text === 'function') {
      append(Buffer.from(await response.text(), 'utf8'));
    }
  } else if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        if (signal.aborted) throw signal.reason || new Error('External metadata request aborted.');
        const { done, value } = await reader.read();
        if (done) break;
        if (value) append(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* Preserve the read error. */ }
      throw error;
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) append(chunk);
  } else if (typeof response.arrayBuffer === 'function') {
    // Built-in Response objects take the streaming branch above. This fallback
    // is for simple injected test/custom responses and checks the size after.
    append(Buffer.from(await response.arrayBuffer()));
  } else if (typeof response.text === 'function') {
    append(Buffer.from(await response.text(), 'utf8'));
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Fetch public web metadata without following redirects automatically.
 *
 * Injectable options:
 *   - fetch/fetchImpl: async fetch-compatible function (useful for a pinned
 *     dispatcher in production, and for deterministic tests).
 *   - lookup/dnsLookup: async dns.promises.lookup-compatible function.
 *   - timeoutMs: total operation timeout (defaults to 5000).
 *
 * Node's built-in fetch does not expose a DNS lookup hook. We validate every
 * answer before every hop, but cannot pin that answer to the subsequent socket;
 * a small DNS time-of-check/time-of-use (rebinding) window therefore remains.
 * Strict deployments should inject a fetch implementation that performs
 * equivalent validation and pins its connector. No response IP is available
 * for a post-check with built-in fetch.
 */
async function importExternalMetadata(url, options = {}) {
  let currentUrl = parseHttpUrl(url);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('External metadata timeout must be a positive number.');
  }

  const fetchImpl = options.fetch || options.fetchImpl || globalThis.fetch;
  const lookup = options.lookup || options.dnsLookup || dns.promises.lookup;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (typeof lookup !== 'function') throw new Error('A DNS lookup implementation is required.');

  const controller = new AbortController();
  let timer;

  async function run() {
    for (let redirectCount = 0; ; redirectCount += 1) {
      await validateDestination(currentUrl, lookup);

      const response = await fetchImpl(currentUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html, application/xhtml+xml;q=0.9',
          'User-Agent': 'Deadletters-Metadata/1.0'
        }
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await discardBody(response);
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error('External URL exceeded the maximum of 3 redirects.');
        }
        const location = getHeader(response.headers, 'location');
        if (!location) throw new Error('External URL redirect did not include a Location header.');
        currentUrl = parseHttpUrl(new URL(location, currentUrl));
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        throw new Error(`External URL returned HTTP ${response.status || 'an error status'}.`);
      }

      const contentType = (getHeader(response.headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
        await discardBody(response);
        throw new Error('External URL did not return an HTML response.');
      }

      const html = await readLimitedBody(response, controller.signal);
      return parseMetadata(html, currentUrl);
    }
  }

  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('External metadata request timed out.');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { importExternalMetadata };
