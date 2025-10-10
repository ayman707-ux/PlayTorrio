const axios = require('axios');
const cheerio = require('cheerio');

const BASES = ['https://uindex.org', 'http://uindex.org'];

/**
 * Fetch and parse search results
 * @param {string} query
 * @param {{page?: number}} options
 * @returns {Promise<{query: string, page: number, items: Array, pagination: { hasNext: boolean, nextPage?: number, raw?: any}}>} 
 */
async function searchUIndex(query, { page = 1, category = 0 } = {}) {
  const base = BASES[0];
  const url = new URL(base + '/search.php');
  url.searchParams.set('search', query);
  url.searchParams.set('c', String(category ?? 0));
  if (page && page > 1) url.searchParams.set('page', String(page));

  const html = await fetchWithRetries(url.toString());
  const $ = cheerio.load(html);

  // UIndex rows: table.maintable > tbody > tr
  const items = [];
  $('table.maintable > tbody > tr').each((_, el) => {
    const row = $(el);
    const tds = row.find('td');
    if (tds.length < 5) return; // header or malformed

    const category = (tds.eq(0).find('a').first().text() || '').trim();

    // Second column has magnet first, then title link and a div.sub with age
    const magnet = tds.eq(1).find('a[href^="magnet:"]').first().attr('href') || '';
    const titleEl = tds.eq(1).find("a[href^='/details.php']").first();
    const title = titleEl.text().trim();
    const relPageHref = titleEl.attr('href') || '';
    const pageUrl = relPageHref ? new URL(relPageHref, base).toString() : '';
    const age = (tds.eq(1).find('div.sub').first().text() || '').trim();

    const size = (tds.eq(2).text() || '').trim();
    const seeds = parseInt((tds.eq(3).text() || '0').replace(/[^\d]/g, ''), 10) || 0;
    const leechers = parseInt((tds.eq(4).text() || '0').replace(/[^\d]/g, ''), 10) || 0;

    if (title && magnet) {
      items.push({ title, magnet, pageUrl, category, size, seeds, leechers, age });
    }
  });

  // Pagination (if present) – default to unknown
  let hasNext = false;
  let nextPage = undefined;
  // Try a generic detection for links with page=page+1
  $('a[href*="page="]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    if (href.includes(`page=${page + 1}`)) {
      hasNext = true;
      nextPage = page + 1;
    }
  });

  return { query, page, items, pagination: { hasNext, nextPage } };
}

/**
 * Fetch and parse search results from knaben.org
 * Example URL: https://knaben.org/search/spiderman/0/1/seeders
 * @param {string} query
 * @param {{page?: number}} options
 * @returns {Promise<{query: string, page: number, items: Array, pagination: { hasNext: boolean, nextPage?: number}}>} 
 */
async function searchKnaben(query, { page = 1 } = {}) {
  const base = 'https://knaben.org';
  const path = `/search/${encodeURIComponent(query)}/0/${page}/seeders`;
  const url = base + path;

  const html = await fetchWithRetries(url);
  const $ = cheerio.load(html);

  const items = [];
  $('tbody > tr').each((_, el) => {
    const row = $(el);
    const tds = row.find('td');
    if (tds.length < 6) return;

    const category = (tds.eq(0).find('a').first().text() || '').trim();

    // Title and magnet live in the big second column
    const titleAnchor = tds.eq(1).find('a[title]').first();
    const magnetAnchor = tds.eq(1).find('a[href^="magnet:"]').first();
    const title = (titleAnchor.attr('title') || titleAnchor.text() || magnetAnchor.text() || '').trim();
    const magnet = magnetAnchor.attr('href') || '';

    const size = (tds.eq(2).text() || '').trim();
    const dateText = (tds.eq(3).text() || '').trim();
    const seeds = parseInt((tds.eq(4).text() || '0').replace(/[^\d]/g, ''), 10) || 0;
    const leechers = parseInt((tds.eq(5).text() || '0').replace(/[^\d]/g, ''), 10) || 0;

    // Source page URL (last column often contains origin site link); fall back to the knaben search URL
    let pageUrl = '';
    const httpLink = row.find('a[href^="http"]').last().attr('href') || '';
    pageUrl = httpLink || url;

    if (title && magnet) {
      items.push({ title, magnet, pageUrl, category, size, seeds, leechers, age: dateText });
    }
  });

  // Pagination: look for links pointing to next page index
  let hasNext = false;
  let nextPage = undefined;
  const nextNeedle = `/${page + 1}/seeders`;
  $('a[href*="/search/"]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    if (href.includes(nextNeedle)) {
      hasNext = true;
      nextPage = page + 1;
    }
  });

  return { query, page, items, pagination: { hasNext, nextPage } };
}

module.exports = { searchUIndex, searchKnaben };

// Internal: fetch URL with browser-like headers and minimal retry/alternate base strategy
async function fetchWithRetries(urlStr) {
  const attempts = [];

  // Primary attempt: HTTPS with full headers
  attempts.push(buildRequest(urlStr, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  }));

  // If blocked, try again tweaking headers (changing UA slightly)
  attempts.push(buildRequest(urlStr, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0',
  }));

  // Final attempt: swap protocol to http if https was blocked (some hosts behave differently)
  const u = new URL(urlStr);
  u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
  attempts.push(buildRequest(u.toString(), {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  }));

  let lastErr;
  for (const req of attempts) {
    try {
      const { data } = await req;
      if (typeof data === 'string' && data.includes('<html')) {
        return data;
      }
      lastErr = new Error('Unexpected response payload');
    } catch (e) {
      lastErr = e;
      // continue to next attempt
    }
  }
  throw lastErr || new Error('Failed to fetch page');
}

function buildRequest(urlStr, { userAgent }) {
  let origin = undefined;
  try {
    const u = new URL(urlStr);
    origin = u.origin;
  } catch (_) {
    origin = undefined;
  }
  return axios.get(urlStr, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      ...(origin ? { 'Referer': origin + '/', 'Origin': origin } : {}),
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1'
    },
    decompress: true,
    validateStatus: (s) => s >= 200 && s < 400,
  });
}

// Helper: extract infohash from magnet (uppercase)
function extractInfoHash(magnet) {
  try {
    const m = /btih:([A-Za-z0-9]{32,40})/i.exec(magnet);
    return m ? m[1].toUpperCase() : '';
  } catch (_) {
    return '';
  }
}

module.exports.extractInfoHash = extractInfoHash;
