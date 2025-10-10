const express = require('express');
const axios = require('axios');

// Allowlist of hosts we permit proxying to
const ALLOWED_HOSTS = new Set([
  'uindex.org',
  'www.uindex.org',
  'knaben.org',
  'www.knaben.org',
]);

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ALLOWED_HOSTS.has(u.hostname);
  } catch (_) {
    return false;
  }
}

function buildUIndexUrl({ q, page, c = 0 }) {
  const u = new URL('https://uindex.org/search.php');
  u.searchParams.set('search', q || '');
  u.searchParams.set('c', String(c ?? 0));
  if (page && Number(page) > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

function buildKnabenUrl({ q, page }) {
  const p = Number(page) > 0 ? Number(page) : 1;
  return `https://knaben.org/search/${encodeURIComponent(q || '')}/0/${p}/seeders`;
}

// Creates an Express router exposing GET /api/proxy
function createProxyRouter() {
  const router = express.Router();

  router.get('/proxy', async (req, res) => {
    try {
      // Either accept a full URL, or construct ET URL from q+page
      let url = req.query.url ? req.query.url.toString() : '';
      if (!url) {
        const which = (req.query.site || 'uindex').toString();
        if (which === 'knaben') {
          url = buildKnabenUrl({ q: (req.query.q || '').toString(), page: req.query.page });
        } else {
          url = buildUIndexUrl({ q: (req.query.q || '').toString(), page: req.query.page, c: req.query.c });
        }
      }

      if (!isAllowed(url)) {
        return res.status(400).json({ error: 'URL not allowed' });
      }

      const { data, status, headers } = await axios.get(url, {
        timeout: 20000,
        responseType: 'arraybuffer',
        validateStatus: () => true, // forward status/body
        headers: {
          // Keep headers minimal; target may block anyway but we shouldn’t spoof aggressively
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Referer': 'https://uindex.org/',
          'Origin': 'https://uindex.org',
        },
      });

      // Pass through content type when present
      const ctype = headers['content-type'] || 'text/plain; charset=utf-8';
      res.setHeader('Content-Type', ctype);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'x-proxied-url');
      res.setHeader('x-proxied-url', url);
      res.status(status).send(Buffer.from(data));
    } catch (err) {
      console.error('Proxy error:', err?.message || err);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(502).json({ error: 'Proxy fetch failed' });
    }
  });

  return router;
}

module.exports = { createProxyRouter };
