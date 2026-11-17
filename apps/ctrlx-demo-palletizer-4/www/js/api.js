// Backend (ctrlX snap) API. All paths are relative to the app's base URL (…/palletizer/).
const TOKEN_KEY = 'palletizer.token';

export const api = {
  online: false,
  info: null,
  token: null,

  init() {
    const u = new URL(location.href);
    const t = u.searchParams.get('bearertoken') || u.searchParams.get('token');
    if (t) {
      sessionStorage.setItem(TOKEN_KEY, t);
      u.searchParams.delete('bearertoken'); u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
    this.token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  },

  headers(extra = {}) {
    const h = { ...extra };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  },

  async req(method, path, body, type) {
    const r = await fetch('api/v1/' + path, { method, headers: this.headers(type ? { 'Content-Type': type } : {}), body, cache: 'no-store' });
    if (r.status === 401 || r.status === 403) { const e = new Error('Not authorised – please log in'); e.auth = true; throw e; }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text().catch(() => '')}`);
    return r;
  },

  async status() {
    try {
      const r = await fetch('api/v1/status', { headers: this.headers(), cache: 'no-store' });
      if (r.status === 401) { this.online = true; this.info = { needsLogin: true }; return this.info; }
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('json')) throw new Error('no backend');
      this.info = await r.json(); this.online = true;
    } catch { this.online = false; this.info = null; }
    return this.info;
  },

  async list() { return (await this.req('GET', 'files')).json(); },
  async read(name) { return (await this.req('GET', 'files/' + encodeURIComponent(name))).text(); },
  async write(name, text, type = 'text/plain') { return (await this.req('PUT', 'files/' + encodeURIComponent(name), text, type)).json(); },
  async remove(name) { return (await this.req('DELETE', 'files/' + encodeURIComponent(name))).json(); },

  async login(user, password) {
    // ctrlX identity manager lives at the device root
    const r = await fetch('/identity-manager/api/v2/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: user, password }),
    });
    if (!r.ok) throw new Error('Login failed (' + r.status + ')');
    const j = await r.json();
    this.token = j.access_token;
    sessionStorage.setItem(TOKEN_KEY, this.token);
    return true;
  },
  logout() { this.token = null; sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); },
};
