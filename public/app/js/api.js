/**
 * DEADLETTERS CLIENT API SERVICE
 * Connects client interface with Deadletters v1 REST API and WP-JSON
 */

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

  async uploadFile(file, endpoint = '/api/v1/media/upload', fieldName = 'file') {
    const formData = new FormData();
    formData.append(fieldName, file);
    return this.post(endpoint, formData);
  }
};
