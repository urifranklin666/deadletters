/**
 * DEADLETTERS CLIENT API SERVICE
 * Connects client interface with Deadletters v1 REST API and WP-JSON
 */

// Shared by every classic script in the no-build frontend. Always escape values
// interpolated into HTML, including quoted attribute values.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

// Return only same-origin absolute paths or explicit HTTP(S) URLs. The caller
// must still use escapeHtml when placing the returned value in an HTML attribute.
function safeUrl(value, fallback = '') {
  const candidate = String(value ?? '').trim();
  if (/^\/(?![\\/])/.test(candidate)) return candidate;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return candidate;
    }
  } catch {}

  return fallback;
}

const API = {
  token: localStorage.getItem('deadletters_token') || null,

  setToken(t) {
    this.token = t;
    if (t) {
      localStorage.setItem('deadletters_token', t);
    } else {
      localStorage.removeItem('deadletters_token');
    }
  },

  async request(endpoint, options = {}) {
    const headers = options.headers || {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const res = await fetch(endpoint, {
        ...options,
        headers
      });

      if (res.status === 401) {
        // Token expired or invalid
        if (!endpoint.includes('/api/v1/auth/login')) {
          this.setToken(null);
        }
      }

      const contentType = res.headers.get('content-type') || '';
      let data = null;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }

      if (!res.ok) {
        throw new Error(data && data.error ? data.error : `HTTP Error ${res.status}`);
      }

      return data;
    } catch (err) {
      throw err;
    }
  },

  get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  },

  post(endpoint, body) {
    return this.request(endpoint, {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body)
    });
  },

  put(endpoint, body) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  },

  del(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  },

  // Download a protected resource with the bearer token in the Authorization
  // header. Protected files must never be fetched by navigating the browser to
  // a URL containing a token, so the response is turned into a temporary Blob
  // URL and clicked through an anchor that is revoked immediately afterwards.
  async download(endpoint, fallbackFilename = 'download') {
    let target;
    try {
      target = new URL(endpoint, window.location.origin);
    } catch {
      throw new Error('Invalid download URL.');
    }

    if (target.origin !== window.location.origin) {
      throw new Error('Refusing to download from a different origin.');
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('Invalid download protocol.');
    }

    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(target.href, {
      method: 'GET',
      headers,
      credentials: 'same-origin'
    });

    if (res.status === 401 && !target.pathname.includes('/api/v1/auth/login')) {
      this.setToken(null);
    }

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      let rawBody = '';
      try {
        rawBody = await res.text();
      } catch {}

      let message = '';
      const trimmedBody = rawBody.trim();
      if (trimmedBody) {
        if (contentType.includes('application/json') || trimmedBody.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmedBody);
            message = parsed && typeof parsed === 'object' && parsed.error
              ? String(parsed.error)
              : trimmedBody;
          } catch {
            message = trimmedBody;
          }
        } else {
          message = trimmedBody;
        }
      }
      throw new Error(message || `HTTP Error ${res.status}`);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plainName = disposition.match(/filename="?([^";]+)"?/i);
    let filename = fallbackFilename || 'download';

    if (utf8Name) {
      try {
        filename = decodeURIComponent(utf8Name[1]);
      } catch {
        filename = utf8Name[1];
      }
    } else if (plainName) {
      filename = plainName[1];
    }

    filename = String(filename).replace(/[\\/]+/g, '_').trim() || 'download';

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

    return { filename, sizeBytes: blob.size };
  },

  async uploadFile(file, endpoint = '/api/v1/media/upload', fieldName = 'file') {
    const formData = new FormData();
    formData.append(fieldName, file);
    return this.post(endpoint, formData);
  }
};
