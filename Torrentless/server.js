const express = require('express');
const cors = require('cors');
const path = require('path');
const { searchUIndex, searchKnaben, extractInfoHash } = require('./src/scraper');
const { createProxyRouter } = require('./src/proxy');

const app = express();
const PORT = process.env.PORT || 3002;

// Simple per-IP rate limiter for API endpoints (default 10 seconds)
const SEARCH_RATE_WINDOW_MS = parseInt(process.env.SEARCH_RATE_WINDOW_MS || '10000', 10);
const lastApiByIp = new Map();

function apiRateLimiter(req, res, next) {
  try {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const last = lastApiByIp.get(ip) || 0;
    const diff = now - last;
    if (diff < SEARCH_RATE_WINDOW_MS) {
      const waitMs = SEARCH_RATE_WINDOW_MS - diff;
      const waitSec = Math.ceil(waitMs / 1000);
      res.set('Retry-After', String(waitSec));
      return res.status(429).json({ error: `Too many requests. Try again in ${waitSec}s.` });
    }
    lastApiByIp.set(ip, now);
    // Light pruning to avoid unbounded memory usage
    if (lastApiByIp.size > 1000 && Math.random() < 0.01) {
      const cutoff = now - SEARCH_RATE_WINDOW_MS * 2;
      for (const [k, v] of lastApiByIp) {
        if (v < cutoff) lastApiByIp.delete(k);
      }
    }
    next();
  } catch (e) {
    // If anything goes wrong in limiter, don't block the request
    next();
  }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
// Rate-limit proxy too (fallback should not bypass search limits)
app.use('/api/proxy', apiRateLimiter);
// CORS-friendly proxy (allowlisted) under /api
app.use('/api', createProxyRouter());

// Simple health route
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'torrentless', time: new Date().toISOString() });
});

// Search route (rate limited per IP)
app.get('/api/search', apiRateLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim().slice(0, 100);
    if (/^[\p{Cc}\p{Cs}]+$/u.test(q)) {
      return res.status(400).json({ error: 'Invalid query' });
    }
    if (!q) {
      return res.status(400).json({ error: 'Missing query ?q=' });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    // Fetch both sources in parallel and merge
    const [r1, r2] = await Promise.allSettled([
      searchUIndex(q, { page, category: 0 }),
      searchKnaben(q, { page }),
    ]);

    const items1 = r1.status === 'fulfilled' ? (r1.value.items || []) : [];
    const items2 = r2.status === 'fulfilled' ? (r2.value.items || []) : [];

    // Deduplicate by infohash (from magnet) and then by title as fallback
    const seen = new Set();
    const merged = [];
    function pushUnique(arr) {
      for (const it of arr) {
        const ih = extractInfoHash(it.magnet) || it.title.toLowerCase();
        if (seen.has(ih)) continue;
        seen.add(ih);
        merged.push(it);
      }
    }
    pushUnique(items1);
    pushUnique(items2);

    // Sort by seeds desc, then leechers desc, then size (rough heuristic)
    merged.sort((a, b) => (b.seeds || 0) - (a.seeds || 0) || (b.leechers || 0) - (a.leechers || 0));

    // Pagination only if both agree there's a next page; otherwise be conservative
    const hasNext = (r1.status === 'fulfilled' && r1.value.pagination?.hasNext) ||
                    (r2.status === 'fulfilled' && r2.value.pagination?.hasNext) || false;
    const out = { query: q, page, items: merged, pagination: { hasNext, nextPage: hasNext ? page + 1 : undefined } };
    res.json(out);
  } catch (err) {
    console.error('Search error:', err?.message || err);
    const msg = /403/.test(String(err))
      ? 'Blocked by remote site (403). Try again later.'
      : 'Failed to fetch results. Please try again later.';
    res.status(502).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Torrentless running on http://localhost:${PORT}`);
});

// Global safety nets: log and exit so supervisor restarts the server
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    console.error('Unhandled Rejection:', msg);
  } finally {
    // Exit to allow start.js to restart immediately
    process.exit(1);
  }
});

process.on('uncaughtException', (err) => {
  try {
    console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  } finally {
    process.exit(1);
  }
});
