const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Export a function that registers all API routes on an existing Express app
function registerApiRoutes(app) {
    // Rate limiting
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100,
        message: 'Too many requests from this IP, please try again later.'
    });

    app.use(limiter);

// ============================================================================
// COMMON CONSTANTS & HELPERS
// ============================================================================

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function createAxiosInstance() {
    return axios.create({
        timeout: 30000,
        headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }
    });
}

// ============================================================================
// GAMES SERVICE (Steam Underground scraper)
// ============================================================================

// Helper function to get download links from a game page
async function getGameDownloadLinks(url) {
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://steamunderground.net/'
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const downloadLinks = [];

        $('.download-mirrors-container .DownloadButtonContainer a').each((index, element) => {
            const $link = $(element);
            const linkUrl = $link.attr('href');
            const linkName = $link.text().trim();
            
            if (linkUrl && linkName) {
                downloadLinks.push({
                    name: linkName,
                    url: linkUrl
                });
            }
        });

        return downloadLinks;
    } catch (error) {
        console.error(`Error getting download links for ${url}:`, error.message);
        return [];
    }
}

// Games search endpoint
app.get('/api/games/search/:query', async (req, res) => {
    const query = req.params.query || '';
    
    if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
    }

    try {
        const searchUrl = `https://steamunderground.net/?s=${encodeURIComponent(query)}`;
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://steamunderground.net/'
            },
            timeout: 15000,
            validateStatus: function (status) {
                return status >= 200 && status < 500;
            }
        });

        if (response.status === 403) {
            return res.status(403).json({ 
                error: 'Access blocked by website', 
                message: 'The website is blocking automated requests.'
            });
        }

        const $ = cheerio.load(response.data);
        const games = [];

        // Parse search results (limit to 20)
        const gamePromises = [];
        
        $('li.row-type.content_out').each((index, element) => {
            // Limit to 20 results
            if (index >= 20) return false;
            
            const $item = $(element);
            
            const $titleLink = $item.find('h4.title a');
            const title = $titleLink.text().trim();
            const link = $titleLink.attr('href');
            const image = $item.find('.thumb img').attr('src');
            const excerpt = $item.find('.excerpt').text().trim();
            const date = $item.find('.post-date').text().trim();
            
            const versionMatch = title.match(/\(([^)]+)\)$/);
            const version = versionMatch ? versionMatch[1] : 'Latest';
            
            if (title && link) {
                // Create a promise to get download links for each game
                const gamePromise = getGameDownloadLinks(link.trim()).then(downloadLinks => ({
                    title,
                    link: link.trim(),
                    image: image || null,
                    version: version,
                    excerpt: excerpt.substring(0, 150) || null,
                    date: date || null,
                    downloadLinks: downloadLinks
                }));
                
                gamePromises.push(gamePromise);
            }
        });

        // Wait for all download links to be fetched
        const gamesWithDownloads = await Promise.all(gamePromises);

        res.json({ 
            query: query,
            count: gamesWithDownloads.length,
            games: gamesWithDownloads 
        });

    } catch (error) {
        console.error('Error scraping games:', error.message);
        res.status(500).json({ 
            error: 'Failed to scrape data', 
            message: error.message 
        });
    }
});

// ============================================================================
// ANIME SERVICE (from anime.js - Nyaa.si scraper)
// ============================================================================

async function anime_scrapePage(query, page = 1) {
    try {
        const url = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query)}&s=seeders&o=desc${page > 1 ? `&p=${page}` : ''}`;
        console.log(`Fetching: ${url}`);
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUserAgent()
            }
        });
        
        const $ = cheerio.load(response.data);
        const results = [];
        
        $('tbody tr').each((index, element) => {
            const $row = $(element);
            const titleElement = $row.find('td:nth-child(2) a[href^="/view/"]').last();
            const title = titleElement.attr('title') || titleElement.text().trim();
            const magnetLink = $row.find('a[href^="magnet:"]').attr('href');
            const size = $row.find('td:nth-child(4)').text().trim();
            const seeders = $row.find('td:nth-child(6)').text().trim();
            
            if (title && magnetLink && size) {
                results.push({
                    title,
                    magnetLink,
                    size,
                    seeders: parseInt(seeders) || 0
                });
            }
        });
        
        return results;
    } catch (error) {
        console.error(`Error scraping page ${page}:`, error.message);
        return [];
    }
}

app.get('/anime/api/:query', async (req, res) => {
    try {
        const query = req.params.query;
        console.log(`[ANIME] Searching for: ${query}`);
        
        const [page1Results, page2Results] = await Promise.all([
            anime_scrapePage(query, 1),
            anime_scrapePage(query, 2)
        ]);
        
        const allResults = [...page1Results, ...page2Results];
        
        res.json({
            query,
            totalResults: allResults.length,
            results: allResults
        });
        
    } catch (error) {
        console.error('[ANIME] Error:', error.message);
        res.status(500).json({
            error: 'Failed to fetch data',
            message: error.message
        });
    }
});

app.get('/anime/', (req, res) => {
    res.json({
        message: 'Anime Scraper API',
        usage: 'GET /anime/api/{searchQuery}',
        example: 'http://localhost:3000/anime/api/one%20punch%20man'
    });
});

app.get('/anime/health', (req, res) => {
    res.status(200).send('OK');
});

// ============================================================================
// TORRENTIO SERVICE (from torrentio.js)
// ============================================================================

const torrentio_trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.bittor.pw:1337/announce',
    'udp://public.popcorn-tracker.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://exodus.desync.com:6969',
    'udp://open.demonii.com:1337/announce'
].map(tracker => `&tr=${encodeURIComponent(tracker)}`).join('');

function torrentio_parseStreamInfo(title) {
    const seederMatch = title.match(/👤\s*(\d+)/);
    const sizeMatch = title.match(/💾\s*([\d.]+\s*[A-Z]+)/);
    
    return {
        seeders: seederMatch ? parseInt(seederMatch[1]) : 0,
        size: sizeMatch ? sizeMatch[1] : 'Unknown'
    };
}

function torrentio_constructMagnetLink(infoHash, filename) {
    const encodedName = encodeURIComponent(filename);
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${torrentio_trackers}`;
}

app.get('/torrentio/api/:imdbid', async (req, res) => {
    try {
        const { imdbid } = req.params;
        
        if (!imdbid.match(/^tt\d+$/)) {
            return res.status(400).json({ error: 'Invalid IMDb ID format. Must be in format: tt1234567' });
        }

        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex/stream/movie/${imdbid}.json`;
        
        const response = await axios.get(torrentioUrl);
        
        if (!response.data || !response.data.streams || response.data.streams.length === 0) {
            return res.status(404).json({ error: 'No streams found for this movie' });
        }

        const allStreams = response.data.streams.map(stream => {
            const info = torrentio_parseStreamInfo(stream.title);
            const filename = stream.behaviorHints?.filename || 'movie.mkv';
            const magnetLink = torrentio_constructMagnetLink(stream.infoHash, filename);

            return {
                name: stream.name,
                title: stream.title,
                magnetLink,
                infoHash: stream.infoHash,
                seeders: info.seeders,
                size: info.size,
                filename,
                fileIdx: stream.fileIdx
            };
        });

        res.json({
            imdbid,
            type: 'movie',
            totalStreams: allStreams.length,
            streams: allStreams
        });

    } catch (error) {
        console.error('[TORRENTIO] Error fetching movie:', error.message);
        if (error.response) {
            res.status(error.response.status).json({ error: `Torrentio API error: ${error.response.statusText}` });
        } else {
            res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    }
});

app.get('/torrentio/api/:imdbid/:season/:episode', async (req, res) => {
    try {
        const { imdbid, season, episode } = req.params;
        
        if (!imdbid.match(/^tt\d+$/)) {
            return res.status(400).json({ error: 'Invalid IMDb ID format. Must be in format: tt1234567' });
        }

        if (isNaN(season) || isNaN(episode)) {
            return res.status(400).json({ error: 'Season and episode must be numbers' });
        }

        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex/stream/series/${imdbid}:${season}:${episode}.json`;
        
        const response = await axios.get(torrentioUrl);
        
        if (!response.data || !response.data.streams || response.data.streams.length === 0) {
            return res.status(404).json({ error: 'No streams found for this episode' });
        }

        const allStreams = response.data.streams.map(stream => {
            const info = torrentio_parseStreamInfo(stream.title);
            const filename = stream.behaviorHints?.filename || `episode_S${season}E${episode}.mkv`;
            const magnetLink = torrentio_constructMagnetLink(stream.infoHash, filename);

            return {
                name: stream.name,
                title: stream.title,
                magnetLink,
                infoHash: stream.infoHash,
                seeders: info.seeders,
                size: info.size,
                filename,
                fileIdx: stream.fileIdx
            };
        });

        res.json({
            imdbid,
            type: 'tvshow',
            season: parseInt(season),
            episode: parseInt(episode),
            totalStreams: allStreams.length,
            streams: allStreams
        });

    } catch (error) {
        console.error('[TORRENTIO] Error fetching TV show:', error.message);
        if (error.response) {
            res.status(error.response.status).json({ error: `Torrentio API error: ${error.response.statusText}` });
        } else {
            res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    }
});

app.get('/torrentio/', (req, res) => {
    res.json({
        status: 'running',
        endpoints: {
            movies: '/torrentio/api/:imdbid',
            tvshows: '/torrentio/api/:imdbid/:season/:episode'
        },
        examples: {
            movie: '/torrentio/api/tt5950044',
            tvshow: '/torrentio/api/tt13159924/2/1'
        }
    });
});

// ============================================================================
// TORRENTLESS SERVICE (from torrentless.js - UIndex & Knaben)
// ============================================================================

const TORRENTLESS_BASES = ['https://uindex.org', 'http://uindex.org'];
const TORRENTLESS_ALLOWED_HOSTS = new Set(['uindex.org', 'www.uindex.org', 'knaben.org', 'www.knaben.org']);

async function torrentless_searchUIndex(query, { page = 1, category = 0 } = {}) {
    const base = TORRENTLESS_BASES[0];
    const url = new URL(base + '/search.php');
    url.searchParams.set('search', query);
    url.searchParams.set('c', String(category ?? 0));
    if (page && page > 1) url.searchParams.set('page', String(page));

    const html = await torrentless_fetchWithRetries(url.toString());
    const $ = cheerio.load(html);

    const items = [];
    $('table.maintable > tbody > tr').each((_, el) => {
        const row = $(el);
        const tds = row.find('td');
        if (tds.length < 5) return;

        const category = (tds.eq(0).find('a').first().text() || '').trim();
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

    let hasNext = false;
    let nextPage = undefined;
    $('a[href*="page="]').each((_, a) => {
        const href = String($(a).attr('href') || '');
        if (href.includes(`page=${page + 1}`)) {
            hasNext = true;
            nextPage = page + 1;
        }
    });

    return { query, page, items, pagination: { hasNext, nextPage } };
}

async function torrentless_searchKnaben(query, { page = 1 } = {}) {
    const base = 'https://knaben.org';
    const path = `/search/${encodeURIComponent(query)}/0/${page}/seeders`;
    const url = base + path;

    const html = await torrentless_fetchWithRetries(url);
    const $ = cheerio.load(html);

    const items = [];
    $('tbody > tr').each((_, el) => {
        const row = $(el);
        const tds = row.find('td');
        if (tds.length < 6) return;

        const category = (tds.eq(0).find('a').first().text() || '').trim();
        const titleAnchor = tds.eq(1).find('a[title]').first();
        const magnetAnchor = tds.eq(1).find('a[href^="magnet:"]').first();
        const title = (titleAnchor.attr('title') || titleAnchor.text() || magnetAnchor.text() || '').trim();
        const magnet = magnetAnchor.attr('href') || '';
        const size = (tds.eq(2).text() || '').trim();
        const dateText = (tds.eq(3).text() || '').trim();
        const seeds = parseInt((tds.eq(4).text() || '0').replace(/[^\d]/g, ''), 10) || 0;
        const leechers = parseInt((tds.eq(5).text() || '0').replace(/[^\d]/g, ''), 10) || 0;
        const httpLink = row.find('a[href^="http"]').last().attr('href') || '';
        const pageUrl = httpLink || url;

        if (title && magnet) {
            items.push({ title, magnet, pageUrl, category, size, seeds, leechers, age: dateText });
        }
    });

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

async function torrentless_fetchWithRetries(urlStr) {
    const attempts = [];

    attempts.push(torrentless_buildRequest(urlStr, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    }));

    attempts.push(torrentless_buildRequest(urlStr, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0',
    }));

    const u = new URL(urlStr);
    u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
    attempts.push(torrentless_buildRequest(u.toString(), {
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
        }
    }
    throw lastErr || new Error('Failed to fetch page');
}

function torrentless_buildRequest(urlStr, { userAgent }) {
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

function torrentless_extractInfoHash(magnet) {
    try {
        const m = /btih:([A-Za-z0-9]{32,40})/i.exec(magnet);
        return m ? m[1].toUpperCase() : '';
    } catch (_) {
        return '';
    }
}

const TORRENTLESS_SEARCH_RATE_WINDOW_MS = 10000;
const torrentless_lastApiByIp = new Map();

function torrentless_apiRateLimiter(req, res, next) {
    try {
        const now = Date.now();
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const last = torrentless_lastApiByIp.get(ip) || 0;
        const diff = now - last;
        if (diff < TORRENTLESS_SEARCH_RATE_WINDOW_MS) {
            const waitMs = TORRENTLESS_SEARCH_RATE_WINDOW_MS - diff;
            const waitSec = Math.ceil(waitMs / 1000);
            res.set('Retry-After', String(waitSec));
            return res.status(429).json({ error: `Too many requests. Try again in ${waitSec}s.` });
        }
        torrentless_lastApiByIp.set(ip, now);
        if (torrentless_lastApiByIp.size > 1000 && Math.random() < 0.01) {
            const cutoff = now - TORRENTLESS_SEARCH_RATE_WINDOW_MS * 2;
            for (const [k, v] of torrentless_lastApiByIp) {
                if (v < cutoff) torrentless_lastApiByIp.delete(k);
            }
        }
        next();
    } catch (e) {
        next();
    }
}

app.get('/torrentless/api/health', (_req, res) => {
    res.json({ ok: true, service: 'torrentless', time: new Date().toISOString() });
});

app.get('/torrentless/api/search', torrentless_apiRateLimiter, async (req, res) => {
    try {
        const q = (req.query.q || '').toString().trim().slice(0, 100);
        if (/^[\p{Cc}\p{Cs}]+$/u.test(q)) {
            return res.status(400).json({ error: 'Invalid query' });
        }
        if (!q) {
            return res.status(400).json({ error: 'Missing query ?q=' });
        }
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);

        const [r1, r2] = await Promise.allSettled([
            torrentless_searchUIndex(q, { page, category: 0 }),
            torrentless_searchKnaben(q, { page }),
        ]);

        const items1 = r1.status === 'fulfilled' ? (r1.value.items || []) : [];
        const items2 = r2.status === 'fulfilled' ? (r2.value.items || []) : [];

        const seen = new Set();
        const merged = [];
        function pushUnique(arr) {
            for (const it of arr) {
                const ih = torrentless_extractInfoHash(it.magnet) || it.title.toLowerCase();
                if (seen.has(ih)) continue;
                seen.add(ih);
                merged.push(it);
            }
        }
        pushUnique(items1);
        pushUnique(items2);

        merged.sort((a, b) => (b.seeds || 0) - (a.seeds || 0) || (b.leechers || 0) - (a.leechers || 0));

        const hasNext = (r1.status === 'fulfilled' && r1.value.pagination?.hasNext) ||
                        (r2.status === 'fulfilled' && r2.value.pagination?.hasNext) || false;
        const out = { query: q, page, items: merged, pagination: { hasNext, nextPage: hasNext ? page + 1 : undefined } };
        res.json(out);
    } catch (err) {
        console.error('[TORRENTLESS] Search error:', err?.message || err);
        const msg = /403/.test(String(err))
            ? 'Blocked by remote site (403). Try again later.'
            : 'Failed to fetch results. Please try again later.';
        res.status(502).json({ error: msg });
    }
});

app.get('/torrentless/api/proxy', torrentless_apiRateLimiter, async (req, res) => {
    try {
        let url = req.query.url ? req.query.url.toString() : '';
        if (!url) {
            const which = (req.query.site || 'uindex').toString();
            if (which === 'knaben') {
                const base = 'https://knaben.org';
                const p = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
                url = `${base}/search/${encodeURIComponent(req.query.q || '')}/0/${p}/seeders`;
            } else {
                const u = new URL('https://uindex.org/search.php');
                u.searchParams.set('search', req.query.q || '');
                u.searchParams.set('c', String(req.query.c ?? 0));
                if (req.query.page && Number(req.query.page) > 1) {
                    u.searchParams.set('page', String(req.query.page));
                }
                url = u.toString();
            }
        }

        const u = new URL(url);
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !TORRENTLESS_ALLOWED_HOSTS.has(u.hostname)) {
            return res.status(400).json({ error: 'URL not allowed' });
        }

        const { data, status, headers } = await axios.get(url, {
            timeout: 20000,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': 'https://uindex.org/',
                'Origin': 'https://uindex.org',
            },
        });

        const ctype = headers['content-type'] || 'text/plain; charset=utf-8';
        res.setHeader('Content-Type', ctype);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'x-proxied-url');
        res.setHeader('x-proxied-url', url);
        res.status(status).send(Buffer.from(data));
    } catch (err) {
        console.error('[TORRENTLESS] Proxy error:', err?.message || err);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(502).json({ error: 'Proxy fetch failed' });
    }
});

// ============================================================================
// Z-LIBRARY SERVICE (from z-lib.js)
// ============================================================================

const ZLIB_DOMAINS = [
    'z-lib.gd',
    'z-library.sk',
    'z-lib.fm',
    'z-lib.io',
    'z-lib.se',
    'zlibrary.to',
    'singlelogin.re',
    'z-library.se'
];

function zlib_createAxiosInstance() {
    return axios.create({
        timeout: 30000,
        headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }
    });
}

async function zlib_getReadLink(bookUrl, workingDomain) {
    try {
        const axiosInstance = zlib_createAxiosInstance();
        const response = await axiosInstance.get(bookUrl);
        
        if (response.status !== 200) {
            return null;
        }

        const $ = cheerio.load(response.data);
        let readerUrl = null;
        
        const readSelectors = [
            '.reader-link',
            '.read-online .reader-link',
            '.book-details-button .reader-link',
            'a[href*="reader.z-lib"]',
            'a[href*="/read/"]',
            '.read-online a[href*="reader"]',
            '.dlButton.reader-link',
            'a.btn[href*="reader"]',
            '.btn-primary[href*="reader"]',
            'a[data-book_id][href*="reader"]'
        ];
        
        for (const selector of readSelectors) {
            const elements = $(selector);
            
            elements.each((i, el) => {
                const $el = $(el);
                const href = $el.attr('href');
                
                if (href && href.includes('reader.z-lib')) {
                    readerUrl = href;
                    return false;
                }
                
                if (href && href.includes('/read/') && !href.includes('litera-reader')) {
                    readerUrl = href;
                    return false;
                }
            });
            
            if (readerUrl) break;
        }
        
        if (readerUrl && readerUrl.startsWith('/')) {
            readerUrl = `https://${workingDomain}${readerUrl}`;
        }
        
        return readerUrl;
    } catch (error) {
        console.error('[ZLIB] Error getting read link:', error.message);
        return null;
    }
}

app.get('/zlib/test', (req, res) => {
    res.json({ message: 'Z-Library Book Search API is running!', timestamp: new Date().toISOString() });
});

app.get('/zlib/search/:query', async (req, res) => {
    const query = req.params.query;
    
    if (!query || query.trim().length === 0) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    console.log(`[ZLIB] Searching for: ${query}`);

    try {
        let searchResults = null;
        let workingDomain = null;

        for (const domain of ZLIB_DOMAINS) {
            try {
                console.log(`[ZLIB] Trying domain: ${domain}`);
                
                const axiosInstance = zlib_createAxiosInstance();
                const searchUrl = `https://${domain}/s/${encodeURIComponent(query)}`;
                
                const response = await axiosInstance.get(searchUrl);
                
                if (response.status === 200 && response.data) {
                    searchResults = response.data;
                    workingDomain = domain;
                    console.log(`[ZLIB] Successfully connected to: ${domain}`);
                    break;
                }
            } catch (error) {
                console.log(`[ZLIB] Failed to connect to ${domain}: ${error.message}`);
                continue;
            }
        }

        if (!searchResults) {
            return res.status(503).json({ 
                error: 'Unable to connect to any Z-Library servers. They might be temporarily down or blocked.',
                domains_tried: ZLIB_DOMAINS
            });
        }

        const $ = cheerio.load(searchResults);
        
        let bookElements = [];
        const selectors = [
            '.book-item',
            '.resItemBox',
            '.bookRow',
            '.result-item',
            '[itemtype*="Book"]',
            'table tr',
            '.bookBox',
            'div[id*="book"]',
            '.booklist .book',
            '.search-item',
            'a[href*="/book/"]'
        ];
        
        for (const selector of selectors) {
            bookElements = $(selector);
            
            if (bookElements.length > 0) {
                if (selector === 'a[href*="/book/"]' && bookElements.length > 0) {
                    bookElements = bookElements.map((i, el) => {
                        const $el = $(el);
                        let parent = $el.closest('tr, div, li, article').first();
                        return parent.length ? parent[0] : el;
                    });
                }
                break;
            }
        }

        if (bookElements.length === 0) {
            return res.status(404).json({ 
                error: 'No books found for your search',
                query: query,
                domain_used: workingDomain
            });
        }

        const books = [];
        
        bookElements.each((index, element) => {
            if (index >= 10) return false;
            
            const $book = $(element);
            let title = '';
            let bookUrl = '';
            let author = 'Unknown';
            let year = 'Unknown';
            let language = 'Unknown';
            let pages = 'Unknown';
            let format = 'Unknown';
            let coverUrl = null;
            
            const zbookcard = $book.find('z-bookcard').first();
            if (zbookcard.length) {
                bookUrl = zbookcard.attr('href') || '';
                year = zbookcard.attr('year') || 'Unknown';
                language = zbookcard.attr('language') || 'Unknown';
                format = zbookcard.attr('extension') || 'Unknown';
                title = zbookcard.find('[slot="title"]').text().trim() || zbookcard.find('div[slot="title"]').text().trim();
                author = zbookcard.find('[slot="author"]').text().trim() || zbookcard.find('div[slot="author"]').text().trim();
                
                const imgElement = zbookcard.find('img').first();
                if (imgElement.length) {
                    coverUrl = imgElement.attr('data-src') || imgElement.attr('src');
                }
            }
            
            if (!title || !bookUrl) {
                const titleSelectors = ['h3 a', '.book-title a', '.title a', 'a[href*="/book/"]'];
                for (const selector of titleSelectors) {
                    const titleElement = $book.find(selector).first();
                    if (titleElement.length) {
                        title = titleElement.text().trim();
                        bookUrl = titleElement.attr('href') || '';
                        if (title && bookUrl) break;
                    }
                }
            }
            
            if (!title || !bookUrl || title.length < 2) {
                return;
            }
            
            if (bookUrl && bookUrl.startsWith('/')) {
                bookUrl = `https://${workingDomain}${bookUrl}`;
            }
            
            if (author === 'Unknown' && !zbookcard.length) {
                const authorSelectors = ['.authors a', '.author a', '[class*="author"]', 'a[href*="/author/"]'];
                for (const selector of authorSelectors) {
                    const authorElement = $book.find(selector).first();
                    if (authorElement.length && authorElement.text().trim()) {
                        const authorText = authorElement.text().trim();
                        if (authorText.length < 100) {
                            author = authorText;
                            break;
                        }
                    }
                }
            }
            
            if (!coverUrl) {
                const coverSelectors = ['img[data-src]', 'img[src*="cover"]', '.itemCover img', 'img'];
                for (const selector of coverSelectors) {
                    const coverElement = $book.find(selector).first();
                    if (coverElement.length) {
                        const src = coverElement.attr('data-src') || coverElement.attr('src');
                        if (src && !src.includes('placeholder') && !src.includes('icon')) {
                            coverUrl = src;
                            break;
                        }
                    }
                }
            }
            
            if (coverUrl && coverUrl.startsWith('/')) {
                coverUrl = `https://${workingDomain}${coverUrl}`;
            }
            
            books.push({
                title: title.replace(/\s+/g, ' ').trim(),
                author: author.replace(/\s+/g, ' ').trim(),
                year,
                language,
                pages,
                format: format.toUpperCase(),
                bookUrl,
                coverUrl,
                domain: workingDomain
            });
        });

        if (books.length === 0) {
            return res.status(404).json({ 
                error: 'Could not parse book information from search results',
                query: query,
                domain_used: workingDomain
            });
        }

        console.log(`[ZLIB] Successfully parsed ${books.length} books, fetching read links...`);
        
        const booksWithReadLinks = [];
        for (let i = 0; i < Math.min(books.length, 5); i++) {
            const book = books[i];
            const readLink = await zlib_getReadLink(book.bookUrl, workingDomain);
            
            booksWithReadLinks.push({
                title: book.title,
                author: book.author,
                photo: book.coverUrl || 'No image available',
                readLink: readLink || 'Read link not available',
                bookUrl: book.bookUrl,
                format: book.format,
                year: book.year
            });
        }

        res.json({
            query: query,
            domainUsed: workingDomain,
            results: booksWithReadLinks
        });

    } catch (error) {
        console.error('[ZLIB] Search error:', error);
        res.status(500).json({ 
            error: 'Internal server error during search',
            details: error.message 
        });
    }
});

app.get('/zlib/api/book/details', async (req, res) => {
    const bookUrl = req.query.url;
    
    if (!bookUrl) {
        return res.status(400).json({ error: 'Book URL is required' });
    }

    try {
        const axiosInstance = zlib_createAxiosInstance();
        const response = await axiosInstance.get(bookUrl);
        
        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.data);
        let readerUrl = null;
        
        const readSelectors = ['.reader-link', 'a[href*="reader.z-lib"]', 'a[href*="/read/"]'];
        
        for (const selector of readSelectors) {
            const elements = $(selector);
            elements.each((i, el) => {
                const href = $(el).attr('href');
                if (href && (href.includes('reader.z-lib') || href.includes('/read/'))) {
                    readerUrl = href;
                    return false;
                }
            });
            if (readerUrl) break;
        }
        
        if (readerUrl && readerUrl.startsWith('/')) {
            const urlObj = new URL(bookUrl);
            readerUrl = `${urlObj.protocol}//${urlObj.host}${readerUrl}`;
        }
        
        const bookTitle = $('h1').first().text().trim() || $('.book-title, .title').first().text().trim();
        const bookAuthor = $('.author a, .authors a, [itemprop="author"]').first().text().trim();
        const description = $('.book-description, .description, #bookDescriptionBox').first().text().trim();
        
        res.json({
            success: true,
            bookUrl: bookUrl,
            readerUrl: readerUrl,
            title: bookTitle,
            author: bookAuthor,
            description: description || null,
            hasReadOption: !!readerUrl
        });

    } catch (error) {
        console.error('[ZLIB] Book details error:', error);
        res.status(500).json({ 
            error: 'Failed to get book details',
            details: error.message 
        });
    }
});

app.get('/zlib/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
        const axiosInstance = zlib_createAxiosInstance();
        const response = await axiosInstance.get(targetUrl);
        
        res.set({
            'Content-Type': response.headers['content-type'] || 'text/html',
            'Access-Control-Allow-Origin': '*'
        });
        
        res.send(response.data);
        
    } catch (error) {
        console.error('[ZLIB] Proxy error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch URL',
            details: error.message 
        });
    }
});

app.get('/zlib/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================================================
// OTHERBOOK SERVICE (from otherbook.js - RandomBook/LibGen)
// ============================================================================

async function otherbook_getCoverByAuthor(authorName, bookTitle = '') {
    try {
        let searchAuthor = authorName;
        if (Array.isArray(authorName)) {
            searchAuthor = authorName[0] || '';
        }
        
        if (!searchAuthor || searchAuthor.trim() === '' || !bookTitle || bookTitle.trim() === '') {
            return null;
        }
        
        console.log(`[OTHERBOOK] Searching Z-Library for cover: "${bookTitle}" by "${searchAuthor}"`);
        
        let searchResults = null;
        let workingDomain = null;

        for (const domain of ZLIB_DOMAINS) {
            try {
                const axiosInstance = zlib_createAxiosInstance();
                const searchUrl = `https://${domain}/s/${encodeURIComponent(bookTitle)}`;
                
                const response = await axiosInstance.get(searchUrl);
                
                if (response.status === 200 && response.data) {
                    searchResults = response.data;
                    workingDomain = domain;
                    break;
                }
            } catch (error) {
                continue;
            }
        }

        if (!searchResults) {
            return null;
        }

        const $ = cheerio.load(searchResults);
        
        let bookElements = [];
        const selectors = ['.book-item', '.resItemBox', '[itemtype*="Book"]', 'a[href*="/book/"]'];
        
        for (const selector of selectors) {
            bookElements = $(selector);
            if (bookElements.length > 0) break;
        }

        if (bookElements.length === 0) {
            return null;
        }

        const covers = [];
        bookElements.each((index, element) => {
            if (index >= 10) return false;
            
            const $book = $(element);
            let coverUrl = null;
            let author = 'Unknown';
            let title = 'Unknown';
            
            const zbookcard = $book.find('z-bookcard').first();
            if (zbookcard.length) {
                const imgElement = zbookcard.find('img').first();
                if (imgElement.length) {
                    coverUrl = imgElement.attr('data-src') || imgElement.attr('src');
                }
                author = zbookcard.find('[slot="author"]').text().trim() || 'Unknown';
                title = zbookcard.find('[slot="title"]').text().trim() || 'Unknown';
            }
            
            if (!coverUrl) {
                const coverElement = $book.find('img[data-src], img[src*="cover"]').first();
                if (coverElement.length) {
                    coverUrl = coverElement.attr('data-src') || coverElement.attr('src');
                }
            }
            
            if (title === 'Unknown') {
                const titleElement = $book.find('h3 a, .book-title a').first();
                if (titleElement.length) {
                    title = titleElement.text().trim();
                }
            }
            
            if (author === 'Unknown') {
                const authorElement = $book.find('.authors a, .author a').first();
                if (authorElement.length) {
                    author = authorElement.text().trim();
                }
            }
            
            if (coverUrl && coverUrl.startsWith('/')) {
                coverUrl = `https://${workingDomain}${coverUrl}`;
            }
            
            if (coverUrl) {
                covers.push({
                    coverUrl: coverUrl,
                    author: author.replace(/\s+/g, ' ').trim(),
                    title: title.replace(/\s+/g, ' ').trim()
                });
            }
        });

        if (covers.length === 0) {
            return null;
        }

        const normalize = (text) => text.toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');

        const exactMatch = covers.find(book => {
            const titleMatch = book.title && bookTitle && normalize(book.title) === normalize(bookTitle);
            const authorMatch = book.author && searchAuthor && normalize(book.author) === normalize(searchAuthor);
            return titleMatch && authorMatch;
        });
        
        if (exactMatch) {
            return exactMatch.coverUrl;
        }
        
        const partialMatch = covers.find(book => {
            if (!book.title || !book.author || !bookTitle || !searchAuthor) return false;
            const zlibTitle = normalize(book.title);
            const zlibAuthor = normalize(book.author);
            const libgenTitle = normalize(bookTitle);
            const libgenAuthor = normalize(searchAuthor);
            const titleMatch = zlibTitle.includes(libgenTitle) || libgenTitle.includes(zlibTitle);
            const authorMatch = zlibAuthor.includes(libgenAuthor) || libgenAuthor.includes(zlibAuthor);
            return titleMatch && authorMatch;
        });
        
        if (partialMatch) {
            return partialMatch.coverUrl;
        }
        
        return null;
        
    } catch (error) {
        console.error(`[OTHERBOOK] Error searching Z-Library:`, error.message);
        return null;
    }
}

async function otherbook_getActualDownloadLink(bookId) {
    const downloadPageUrl = `https://libgen.download/api/download?id=${bookId}`;
    return downloadPageUrl;
}

async function otherbook_getDownloadLinksInParallel(books, concurrency = 3) {
    const results = [];
    
    for (let i = 0; i < books.length; i += concurrency) {
        const chunk = books.slice(i, i + concurrency);
        
        const chunkPromises = chunk.map(async (book) => {
            const authorForDisplay = Array.isArray(book.author) ? book.author[0] || 'Unknown' : book.author || 'Unknown';
            const actualDownloadLink = await otherbook_getActualDownloadLink(book.id);
            const coverUrl = await otherbook_getCoverByAuthor(book.author, book.title);
            
            const result = {
                id: book.id,
                title: book.title,
                author: book.author,
                description: book.description,
                year: book.year,
                language: book.language,
                fileExtension: book.fileExtension,
                fileSize: book.fileSize,
                downloadlink: actualDownloadLink || `https://libgen.download/api/download?id=${book.id}`
            };
            
            if (coverUrl) {
                result.coverUrl = coverUrl;
            }
            
            return result;
        });
        
        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
    }
    
    return results;
}

app.get('/otherbook/api/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const encodedQuery = encodeURIComponent(query);
        const apiUrl = `https://randombook.org/api/search/by-params?query=${encodedQuery}&collection=libgen&from=0`;
        
        console.log(`[OTHERBOOK] Fetching data from: ${apiUrl}`);
        
        const response = await axios.get(apiUrl);
        
        if (!response.data || !response.data.result || !response.data.result.books) {
            return res.status(404).json({
                success: false,
                message: 'No books found for the given query'
            });
        }
        
        const books = response.data.result.books;
        const limitedBooks = books.slice(0, 15);
        const transformedBooks = await otherbook_getDownloadLinksInParallel(limitedBooks, 3);
        
        const sortedBooks = transformedBooks.sort((a, b) => {
            const aHasCover = a.coverUrl ? 1 : 0;
            const bHasCover = b.coverUrl ? 1 : 0;
            return bHasCover - aHasCover;
        });
        
        res.json({
            success: true,
            query: query,
            totalBooks: sortedBooks.length,
            books: sortedBooks
        });
        
    } catch (error) {
        console.error('[OTHERBOOK] Error fetching data:', error.message);
        
        if (error.response) {
            return res.status(error.response.status).json({
                success: false,
                message: 'External API error',
                error: error.response.data || error.message
            });
        } else if (error.request) {
            return res.status(500).json({
                success: false,
                message: 'No response from external API',
                error: error.message
            });
        } else {
            return res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    }
});

app.get('/otherbook/api/download/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const downloadLink = await otherbook_getActualDownloadLink(id);
        
        if (downloadLink) {
            res.json({
                success: true,
                bookId: id,
                downloadlink: downloadLink
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Could not extract download link',
                bookId: id
            });
        }
        
    } catch (error) {
        console.error('[OTHERBOOK] Error getting download link:', error.message);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

app.get('/otherbook/health', (req, res) => {
    res.json({
        success: true,
        message: 'RandomBook Scraper API is running',
        timestamp: new Date().toISOString()
    });
});

app.get('/otherbook/', (req, res) => {
    res.json({
        success: true,
        message: 'Welcome to RandomBook Scraper API',
        endpoints: {
            search: '/otherbook/api/search/{query}',
            download: '/otherbook/api/download/{bookId}',
            health: '/otherbook/health'
        },
        examples: {
            search: '/otherbook/api/search/The midnight library',
            download: '/otherbook/api/download/98593300'
        }
    });
});

// ============================================================================
// ROOT ENDPOINT - API INFO
// ============================================================================

app.get('/', (req, res) => {
    res.json({
        message: 'Combined API Server - All Services Available',
        port: PORT,
        services: {
            anime: {
                description: 'Anime torrents from Nyaa.si',
                endpoints: {
                    search: '/anime/api/{query}',
                    info: '/anime/',
                    health: '/anime/health'
                },
                example: 'http://localhost:3000/anime/api/one%20punch%20man'
            },
            torrentio: {
                description: 'Movie & TV show torrents via Torrentio',
                endpoints: {
                    movies: '/torrentio/api/{imdbid}',
                    tvshows: '/torrentio/api/{imdbid}/{season}/{episode}',
                    info: '/torrentio/'
                },
                examples: {
                    movie: 'http://localhost:3000/torrentio/api/tt5950044',
                    tvshow: 'http://localhost:3000/torrentio/api/tt13159924/2/1'
                }
            },
            torrentless: {
                description: 'Torrent search via UIndex & Knaben',
                endpoints: {
                    search: '/torrentless/api/search?q={query}&page={page}',
                    proxy: '/torrentless/api/proxy?url={url}',
                    health: '/torrentless/api/health'
                },
                example: 'http://localhost:3000/torrentless/api/search?q=ubuntu'
            },
            zlib: {
                description: 'Z-Library book search & read links',
                endpoints: {
                    search: '/zlib/search/{query}',
                    details: '/zlib/api/book/details?url={bookUrl}',
                    proxy: '/zlib/api/proxy?url={url}',
                    test: '/zlib/test',
                    health: '/zlib/health'
                },
                example: 'http://localhost:3000/zlib/search/python%20programming'
            },
            otherbook: {
                description: 'Book search via RandomBook/LibGen with covers',
                endpoints: {
                    search: '/otherbook/api/search/{query}',
                    download: '/otherbook/api/download/{bookId}',
                    info: '/otherbook/',
                    health: '/otherbook/health'
                },
                example: 'http://localhost:3000/otherbook/api/search/The%20midnight%20library'
            },
            lib111477: {
                description: 'Movie/TV show directory parser with TMDB integration',
                endpoints: {
                    moviesByName: '/111477/api/movies/{movieName}',
                    movieByTmdbId: '/111477/api/tmdb/movie/{tmdbId}',
                    tvShowInfo: '/111477/api/tmdb/tv/{tmdbId}',
                    tvShowSeason: '/111477/api/tmdb/tv/{tmdbId}/season/{season}',
                    tvShowEpisode: '/111477/api/tmdb/tv/{tmdbId}/season/{season}/episode/{episode}',
                    searchTmdb: '/111477/api/tmdb/search/{query}',
                    searchAndFetch: '/111477/api/tmdb/search/{query}/fetch',
                    parseUrl: 'POST /111477/api/parse',
                    parseBatch: 'POST /111477/api/parse-batch',
                    health: '/111477/health'
                },
                example: 'http://localhost:3000/111477/api/tmdb/movie/550'
            }
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================================================
// 111477 SERVICE - Movie/TV Directory Parser
// ============================================================================

// 111477 Constants
const lib111477_TMDB_API_KEY = 'b3556f3b206e16f82df4d1f6fd4545e6';
const lib111477_TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// 111477 Helper Functions
async function lib111477_fetchHtml(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 30000,
            maxRedirects: 5
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from server');
        } else {
            throw new Error(`Request error: ${error.message}`);
        }
    }
}

function lib111477_buildMovieUrl(movieName) {
    const baseUrl = 'https://a.111477.xyz/movies/';
    const encodedMovieName = encodeURIComponent(movieName);
    return `${baseUrl}${encodedMovieName}/`;
}

function lib111477_normalizeUrl(url) {
    if (!url) {
        throw new Error('URL is required');
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    if (!url.endsWith('/')) {
        url += '/';
    }
    return url;
}

function lib111477_formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function lib111477_extractEpisodeInfo(fileName) {
    const patterns = [
        /S(\d{1,2})E(\d{1,2})/i, /S(\d{1,2})\.E(\d{1,2})/i, /S(\d{1,2})\s*E(\d{1,2})/i,
        /Season\s*(\d+)\s*Episode\s*(\d+)/i, /(\d{1,2})x(\d{1,2})/, /(\d{1,2})\.(\d{1,2})/,
        /Ep(\d+).*S(\d+)/i, /Episode\s*(\d+).*Season\s*(\d+)/i, /S(\d{1,2})-E(\d{1,2})/i,
        /S(\d{1,2})_E(\d{1,2})/i, /(\d{1,2})-(\d{1,2})/, /(\d{1,2})_(\d{1,2})/,
        /(\d{1,2})\s*[xX]\s*(\d{1,2})/, /S(\d{1,2})[^\dE]*(\d{1,2})/i
    ];
    for (const pattern of patterns) {
        const match = fileName.match(pattern);
        if (match) {
            let season, episode;
            if (pattern.source.includes('Ep.*S') || pattern.source.includes('Episode.*Season')) {
                episode = parseInt(match[1]);
                season = parseInt(match[2]);
            } else {
                season = parseInt(match[1]);
                episode = parseInt(match[2]);
            }
            if (season >= 1 && season <= 50 && episode >= 1 && episode <= 500) {
                return {
                    season: season,
                    episode: episode,
                    seasonStr: season.toString().padStart(2, '0'),
                    episodeStr: episode.toString().padStart(2, '0')
                };
            }
        }
    }
    return null;
}

function lib111477_extractMovieName(url, $) {
    const title = $('title').text();
    if (title && title.includes('Index of')) {
        const match = title.match(/Index of \/movies\/(.+)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }
    const urlParts = url.split('/');
    const moviePart = urlParts.find(part => part && part !== 'movies');
    if (moviePart) {
        return decodeURIComponent(moviePart);
    }
    return 'Unknown Movie';
}

function lib111477_extractTvName(url, $) {
    const title = $('title').text();
    if (title && title.includes('Index of')) {
        const match = title.match(/Index of \/tvs\/(.+?)(?:\/Season|$)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }
    const urlParts = url.split('/');
    const tvIndex = urlParts.findIndex(part => part === 'tvs');
    if (tvIndex !== -1 && urlParts[tvIndex + 1]) {
        return decodeURIComponent(urlParts[tvIndex + 1]);
    }
    return 'Unknown TV Show';
}

function lib111477_parseMovieDirectory(html, baseUrl) {
    const $ = cheerio.load(html);
    const files = [];
    const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    
    $('tr').each((index, element) => {
        const link = $(element).find('a').first();
        const href = link.attr('href');
        const fileName = link.text().trim();
        
        if (!href || fileName.includes('Parent Directory') || href === '../') {
            return;
        }
        
        const hasVideoExtension = videoExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
        
        if (hasVideoExtension) {
            const sizeCell = $(element).find('td[data-sort]');
            const fileSize = sizeCell.attr('data-sort') || '0';
            let fileUrl = href;
            if (!href.startsWith('http')) {
                fileUrl = baseUrl.endsWith('/') ? baseUrl + href : baseUrl + '/' + href;
            }
            files.push({
                name: fileName,
                url: fileUrl,
                size: fileSize,
                sizeFormatted: lib111477_formatFileSize(parseInt(fileSize))
            });
        }
    });
    
    const movieName = lib111477_extractMovieName(baseUrl, $);
    
    return {
        success: true,
        movieName,
        baseUrl,
        fileCount: files.length,
        files: files.sort((a, b) => {
            const sizeA = parseInt(a.size);
            const sizeB = parseInt(b.size);
            if (sizeA !== sizeB) {
                return sizeB - sizeA;
            }
            return a.name.localeCompare(b.name);
        })
    };
}

function lib111477_parseTvDirectory(html, baseUrl, filterSeason = null, filterEpisode = null) {
    const $ = cheerio.load(html);
    const files = [];
    const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    
    $('tr').each((index, element) => {
        const link = $(element).find('a').first();
        const href = link.attr('href');
        const fileName = link.text().trim();
        
        if (!href || fileName.includes('Parent Directory') || href === '../') {
            return;
        }
        
        const hasVideoExtension = videoExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
        
        if (hasVideoExtension) {
            if (filterSeason !== null && filterEpisode !== null) {
                const episodeInfo = lib111477_extractEpisodeInfo(fileName);
                if (!episodeInfo || episodeInfo.season !== filterSeason || episodeInfo.episode !== filterEpisode) {
                    return;
                }
            }
            
            const sizeCell = $(element).find('td[data-sort]');
            const fileSize = sizeCell.attr('data-sort') || '0';
            let fileUrl = href;
            if (!href.startsWith('http')) {
                fileUrl = baseUrl.endsWith('/') ? baseUrl + href : baseUrl + '/' + href;
            }
            const episodeInfo = lib111477_extractEpisodeInfo(fileName);
            files.push({
                name: fileName,
                url: fileUrl,
                size: fileSize,
                sizeFormatted: lib111477_formatFileSize(parseInt(fileSize)),
                episode: episodeInfo
            });
        }
    });
    
    const tvName = lib111477_extractTvName(baseUrl, $);
    
    return {
        success: true,
        tvName,
        baseUrl,
        fileCount: files.length,
        filterSeason,
        filterEpisode,
        files: files.sort((a, b) => {
            if (a.episode && b.episode) {
                if (a.episode.season !== b.episode.season) {
                    return a.episode.season - b.episode.season;
                }
                if (a.episode.episode !== b.episode.episode) {
                    return a.episode.episode - b.episode.episode;
                }
            }
            const sizeA = parseInt(a.size);
            const sizeB = parseInt(b.size);
            if (sizeA !== sizeB) {
                return sizeB - sizeA;
            }
            return a.name.localeCompare(b.name);
        })
    };
}

async function lib111477_getMovieDetails(tmdbId) {
    try {
        const response = await axios.get(`${lib111477_TMDB_BASE_URL}/movie/${tmdbId}`, {
            params: { api_key: lib111477_TMDB_API_KEY }
        });
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch movie details: ${error.message}`);
    }
}

async function lib111477_getTvDetails(tmdbId) {
    try {
        const response = await axios.get(`${lib111477_TMDB_BASE_URL}/tv/${tmdbId}`, {
            params: { api_key: lib111477_TMDB_API_KEY }
        });
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch TV show details: ${error.message}`);
    }
}

async function lib111477_searchMovies(query, page = 1) {
    try {
        const response = await axios.get(`${lib111477_TMDB_BASE_URL}/search/movie`, {
            params: { api_key: lib111477_TMDB_API_KEY, query: query, page: page }
        });
        return response.data;
    } catch (error) {
        throw new Error(`Failed to search movies: ${error.message}`);
    }
}

function lib111477_constructMovieName(movie) {
    const title = movie.title || movie.name;
    const year = movie.release_date ? new Date(movie.release_date).getFullYear() : '';
    const cleanTitle = title.replace(/:/g, '');
    return year ? `${cleanTitle} (${year})` : cleanTitle;
}

function lib111477_constructMovieNameWithHyphens(movie) {
    const title = movie.title || movie.name;
    const year = movie.release_date ? new Date(movie.release_date).getFullYear() : '';
    const cleanTitle = title.replace(/:/g, ' -');
    return year ? `${cleanTitle} (${year})` : cleanTitle;
}

function lib111477_getMovieNameVariants(movie) {
    const title = movie.title || movie.name;
    if (title.includes(':')) {
        return [lib111477_constructMovieName(movie), lib111477_constructMovieNameWithHyphens(movie)];
    }
    return [lib111477_constructMovieName(movie)];
}

function lib111477_constructTvName(tv) {
    const title = tv.name || tv.title;
    const cleanTitle = title.replace(/:/g, '');
    return cleanTitle;  // Don't include year for TV shows
}

function lib111477_constructTvNameWithHyphens(tv) {
    const title = tv.name || tv.title;
    const cleanTitle = title.replace(/:/g, ' -');
    return cleanTitle;  // Don't include year for TV shows
}

function lib111477_getTvNameVariants(tv) {
    const title = tv.name || tv.title;
    if (title.includes(':')) {
        return [lib111477_constructTvName(tv), lib111477_constructTvNameWithHyphens(tv)];
    }
    return [lib111477_constructTvName(tv)];
}

function lib111477_constructMovieUrl(movieName) {
    const baseUrl = 'https://a.111477.xyz/movies/';
    const encodedName = encodeURIComponent(movieName);
    return `${baseUrl}${encodedName}/`;
}

function lib111477_constructTvUrl(tvName, season = null) {
    const baseUrl = 'https://a.111477.xyz/tvs/';
    const encodedName = encodeURIComponent(tvName);
    if (season !== null) {
        // Use single digit for seasons 1-9, no padding
        return `${baseUrl}${encodedName}/Season ${season}/`;
    }
    return `${baseUrl}${encodedName}/`;
}

// 111477 API Routes
app.get('/111477/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        tmdbApiKey: lib111477_TMDB_API_KEY ? 'configured' : 'missing'
    });
});

app.get('/111477/api/movies/:movieName', async (req, res) => {
    try {
        const { movieName } = req.params;
        if (!movieName) {
            return res.status(400).json({ success: false, error: 'Movie name is required' });
        }
        const html = await lib111477_fetchHtml(lib111477_buildMovieUrl(movieName));
        const url = lib111477_buildMovieUrl(movieName);
        const result = lib111477_parseMovieDirectory(html, url);
        res.json(result);
    } catch (error) {
        console.error('Error fetching movie:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/111477/api/tmdb/movie/:tmdbId', async (req, res) => {
    try {
        const { tmdbId } = req.params;
        if (!tmdbId || isNaN(tmdbId)) {
            return res.status(400).json({ success: false, error: 'Valid TMDB ID is required' });
        }
        const movie = await lib111477_getMovieDetails(parseInt(tmdbId));
        const nameVariants = lib111477_getMovieNameVariants(movie);
        const results = [];
        let variantsWithContent = 0;
        
        for (let i = 0; i < nameVariants.length; i++) {
            const movieName = nameVariants[i];
            const url = lib111477_constructMovieUrl(movieName);
            const variantLabel = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
            
            try {
                const html = await lib111477_fetchHtml(url);
                const content = lib111477_parseMovieDirectory(html, url);
                
                if (content.fileCount > 0) {
                    variantsWithContent++;
                }
                
                // Build enriched TMDB data
                const enrichedTmdb = {
                    id: movie.id,
                    title: movie.title,
                    originalTitle: movie.original_title,
                    releaseDate: movie.release_date,
                    year: movie.release_date ? new Date(movie.release_date).getFullYear().toString() : '',
                    overview: movie.overview,
                    posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                    backdropPath: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                    genres: movie.genres || [],
                    runtime: movie.runtime,
                    imdbId: movie.imdb_id
                };
                
                results.push({
                    success: true,
                    movieName: content.movieName,
                    baseUrl: content.baseUrl,
                    fileCount: content.fileCount,
                    files: content.files,
                    searchVariant: variantLabel,
                    contentFound: content.fileCount > 0,
                    tmdb: enrichedTmdb
                });
            } catch (error) {
                const enrichedTmdb = {
                    id: movie.id,
                    title: movie.title,
                    originalTitle: movie.original_title,
                    releaseDate: movie.release_date,
                    year: movie.release_date ? new Date(movie.release_date).getFullYear().toString() : '',
                    overview: movie.overview,
                    posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                    backdropPath: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                    genres: movie.genres || [],
                    runtime: movie.runtime,
                    imdbId: movie.imdb_id
                };
                
                results.push({
                    success: false,
                    movieName: movieName,
                    baseUrl: url,
                    fileCount: 0,
                    files: [],
                    searchVariant: variantLabel,
                    contentFound: false,
                    error: error.message,
                    tmdb: enrichedTmdb
                });
            }
        }
        
        res.json({
            success: true,
            tmdbId: movie.id,
            dualSearchPerformed: nameVariants.length > 1,
            variantsChecked: nameVariants.length,
            variantsWithContent: variantsWithContent,
            results: results
        });
    } catch (error) {
        console.error('Error fetching movie by TMDB ID:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/111477/api/tmdb/tv/:tmdbId', async (req, res) => {
    try {
        const { tmdbId } = req.params;
        if (!tmdbId || isNaN(tmdbId)) {
            return res.status(400).json({ success: false, error: 'Valid TMDB ID is required' });
        }
        const tv = await lib111477_getTvDetails(parseInt(tmdbId));
        const nameVariants = lib111477_getTvNameVariants(tv);
        res.json({
            success: true, tmdb: tv, name: nameVariants[0], variants: nameVariants,
            seasons: tv.number_of_seasons, episodes: tv.number_of_episodes,
            note: 'Use /111477/api/tmdb/tv/:tmdbId/season/:season to get episodes for a specific season'
        });
    } catch (error) {
        console.error('Error fetching TV show by TMDB ID:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/111477/api/tmdb/tv/:tmdbId/season/:season', async (req, res) => {
    try {
        const { tmdbId, season } = req.params;
        if (!tmdbId || isNaN(tmdbId)) {
            return res.status(400).json({ success: false, error: 'Valid TMDB ID is required' });
        }
        if (!season || isNaN(season)) {
            return res.status(400).json({ success: false, error: 'Valid season number is required' });
        }
        const seasonNum = parseInt(season);
        const tv = await lib111477_getTvDetails(parseInt(tmdbId));
        const nameVariants = lib111477_getTvNameVariants(tv);
        const results = [];
        let variantsWithContent = 0;
        
        for (let i = 0; i < nameVariants.length; i++) {
            const tvName = nameVariants[i];
            const url = lib111477_constructTvUrl(tvName, seasonNum);
            const variantLabel = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
            
            try {
                const html = await lib111477_fetchHtml(url);
                const content = lib111477_parseTvDirectory(html, url);
                
                if (content.fileCount > 0) {
                    variantsWithContent++;
                }
                
                const enrichedTmdb = {
                    id: tv.id,
                    name: tv.name,
                    originalName: tv.original_name,
                    firstAirDate: tv.first_air_date,
                    year: tv.first_air_date ? new Date(tv.first_air_date).getFullYear().toString() : '',
                    overview: tv.overview,
                    posterPath: tv.poster_path ? `https://image.tmdb.org/t/p/w500${tv.poster_path}` : null,
                    backdropPath: tv.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tv.backdrop_path}` : null,
                    genres: tv.genres || [],
                    numberOfSeasons: tv.number_of_seasons,
                    numberOfEpisodes: tv.number_of_episodes
                };
                
                results.push({
                    success: true,
                    tvName: content.tvName,
                    baseUrl: content.baseUrl,
                    fileCount: content.fileCount,
                    files: content.files,
                    searchVariant: variantLabel,
                    contentFound: content.fileCount > 0,
                    tmdb: enrichedTmdb
                });
            } catch (error) {
                const enrichedTmdb = {
                    id: tv.id,
                    name: tv.name,
                    originalName: tv.original_name,
                    firstAirDate: tv.first_air_date,
                    year: tv.first_air_date ? new Date(tv.first_air_date).getFullYear().toString() : '',
                    overview: tv.overview,
                    posterPath: tv.poster_path ? `https://image.tmdb.org/t/p/w500${tv.poster_path}` : null,
                    backdropPath: tv.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tv.backdrop_path}` : null,
                    genres: tv.genres || [],
                    numberOfSeasons: tv.number_of_seasons,
                    numberOfEpisodes: tv.number_of_episodes
                };
                
                results.push({
                    success: false,
                    tvName: tvName,
                    baseUrl: url,
                    fileCount: 0,
                    files: [],
                    searchVariant: variantLabel,
                    contentFound: false,
                    error: error.message,
                    tmdb: enrichedTmdb
                });
            }
        }
        
        res.json({
            success: true,
            tmdbId: tv.id,
            season: seasonNum,
            dualSearchPerformed: nameVariants.length > 1,
            variantsChecked: nameVariants.length,
            variantsWithContent: variantsWithContent,
            results: results
        });
    } catch (error) {
        console.error('Error fetching TV show season:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/111477/api/tmdb/tv/:tmdbId/season/:season/episode/:episode', async (req, res) => {
    try {
        const { tmdbId, season, episode } = req.params;
        if (!tmdbId || isNaN(tmdbId)) {
            return res.status(400).json({ success: false, error: 'Valid TMDB ID is required' });
        }
        if (!season || isNaN(season)) {
            return res.status(400).json({ success: false, error: 'Valid season number is required' });
        }
        if (!episode || isNaN(episode)) {
            return res.status(400).json({ success: false, error: 'Valid episode number is required' });
        }
        const seasonNum = parseInt(season);
        const episodeNum = parseInt(episode);
        const tv = await lib111477_getTvDetails(parseInt(tmdbId));
        const nameVariants = lib111477_getTvNameVariants(tv);
        const results = [];
        let variantsWithContent = 0;
        
        for (let i = 0; i < nameVariants.length; i++) {
            const tvName = nameVariants[i];
            const url = lib111477_constructTvUrl(tvName, seasonNum);
            const variantLabel = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
            
            try {
                const html = await lib111477_fetchHtml(url);
                const content = lib111477_parseTvDirectory(html, url, seasonNum, episodeNum);
                
                if (content.fileCount > 0) {
                    variantsWithContent++;
                }
                
                const enrichedTmdb = {
                    id: tv.id,
                    name: tv.name,
                    originalName: tv.original_name,
                    firstAirDate: tv.first_air_date,
                    year: tv.first_air_date ? new Date(tv.first_air_date).getFullYear().toString() : '',
                    overview: tv.overview,
                    posterPath: tv.poster_path ? `https://image.tmdb.org/t/p/w500${tv.poster_path}` : null,
                    backdropPath: tv.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tv.backdrop_path}` : null,
                    genres: tv.genres || [],
                    numberOfSeasons: tv.number_of_seasons,
                    numberOfEpisodes: tv.number_of_episodes
                };
                
                results.push({
                    success: true,
                    tvName: content.tvName,
                    baseUrl: content.baseUrl,
                    season: seasonNum,
                    episode: episodeNum,
                    fileCount: content.fileCount,
                    files: content.files,
                    searchVariant: variantLabel,
                    contentFound: content.fileCount > 0,
                    tmdb: enrichedTmdb
                });
            } catch (error) {
                const enrichedTmdb = {
                    id: tv.id,
                    name: tv.name,
                    originalName: tv.original_name,
                    firstAirDate: tv.first_air_date,
                    year: tv.first_air_date ? new Date(tv.first_air_date).getFullYear().toString() : '',
                    overview: tv.overview,
                    posterPath: tv.poster_path ? `https://image.tmdb.org/t/p/w500${tv.poster_path}` : null,
                    backdropPath: tv.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tv.backdrop_path}` : null,
                    genres: tv.genres || [],
                    numberOfSeasons: tv.number_of_seasons,
                    numberOfEpisodes: tv.number_of_episodes
                };
                
                results.push({
                    success: false,
                    tvName: tvName,
                    baseUrl: url,
                    season: seasonNum,
                    episode: episodeNum,
                    fileCount: 0,
                    files: [],
                    searchVariant: variantLabel,
                    contentFound: false,
                    error: error.message,
                    tmdb: enrichedTmdb
                });
            }
        }
        
        res.json({
            success: true,
            tmdbId: tv.id,
            season: seasonNum,
            episode: episodeNum,
            dualSearchPerformed: nameVariants.length > 1,
            variantsChecked: nameVariants.length,
            variantsWithContent: variantsWithContent,
            results: results
        });
    } catch (error) {
        console.error('Error fetching TV show episode:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/111477/api/tmdb/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const { page = 1 } = req.query;
        if (!query) {
            return res.status(400).json({ success: false, error: 'Search query is required' });
        }
        const searches = [];
        const queries = [query];
        if (query.includes(':')) {
            const hyphenQuery = query.replace(/:/g, ' -');
            queries.push(hyphenQuery);
        }
        for (const searchQuery of queries) {
            try {
                const results = await lib111477_searchMovies(searchQuery, parseInt(page));
                searches.push({ query: searchQuery, results: results });
            } catch (error) {
                searches.push({ query: searchQuery, error: error.message });
            }
        }
        res.json({ success: true, originalQuery: query, searches: searches });
    } catch (error) {
        console.error('Error searching TMDB:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/111477/api/tmdb/search/:query/fetch', async (req, res) => {
    try {
        const { query } = req.params;
        const { page = 1 } = req.query;
        if (!query) {
            return res.status(400).json({ success: false, error: 'Search query is required' });
        }
        const searches = [];
        const queries = [query];
        if (query.includes(':')) {
            const hyphenQuery = query.replace(/:/g, ' -');
            queries.push(hyphenQuery);
        }
        for (const searchQuery of queries) {
            try {
                const searchResults = await lib111477_searchMovies(searchQuery, parseInt(page));
                const resultsWithContent = await Promise.all(
                    searchResults.results.map(async (movie) => {
                        const nameVariants = lib111477_getMovieNameVariants(movie);
                        const contentResults = [];
                        for (const movieName of nameVariants) {
                            const url = lib111477_constructMovieUrl(movieName);
                            try {
                                const html = await lib111477_fetchHtml(url);
                                const content = lib111477_parseMovieDirectory(html, url);
                                contentResults.push({ variant: movieName, url: url, content: content });
                            } catch (error) {
                                contentResults.push({ variant: movieName, url: url, error: error.message });
                            }
                        }
                        return { ...movie, variants: nameVariants, contentResults: contentResults };
                    })
                );
                searches.push({ query: searchQuery, results: { ...searchResults, results: resultsWithContent } });
            } catch (error) {
                searches.push({ query: searchQuery, error: error.message });
            }
        }
        res.json({ success: true, originalQuery: query, searches: searches });
    } catch (error) {
        console.error('Error searching and fetching from TMDB:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/111477/api/parse', async (req, res) => {
    try {
        const { url, type = 'movie' } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL is required' });
        }
        const normalizedUrl = lib111477_normalizeUrl(url);
        const html = await lib111477_fetchHtml(normalizedUrl);
        let result;
        if (type === 'tv') {
            result = lib111477_parseTvDirectory(html, normalizedUrl);
        } else {
            result = lib111477_parseMovieDirectory(html, normalizedUrl);
        }
        res.json(result);
    } catch (error) {
        console.error('Error parsing URL:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/111477/api/parse-batch', async (req, res) => {
    try {
        const { urls } = req.body;
        if (!urls || !Array.isArray(urls)) {
            return res.status(400).json({ success: false, error: 'URLs array is required' });
        }
        const results = await Promise.all(
            urls.map(async (item) => {
                try {
                    const { url, type = 'movie' } = item;
                    const normalizedUrl = lib111477_normalizeUrl(url);
                    const html = await lib111477_fetchHtml(normalizedUrl);
                    let result;
                    if (type === 'tv') {
                        result = lib111477_parseTvDirectory(html, normalizedUrl);
                    } else {
                        result = lib111477_parseMovieDirectory(html, normalizedUrl);
                    }
                    return { url: normalizedUrl, type, ...result };
                } catch (error) {
                    return { url: item.url, type: item.type || 'movie', success: false, error: error.message };
                }
            })
        );
        res.json({ success: true, count: results.length, results });
    } catch (error) {
        console.error('Error batch parsing URLs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check for the entire server
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: ['anime', 'torrentio', 'torrentless', 'zlib', 'otherbook', '111477']
    });
});

// ============================================================================
// ERROR HANDLERS & SERVER STARTUP
// ============================================================================

app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

} // End of registerApiRoutes function

process.on('unhandledRejection', (reason) => {
    try {
        const msg = reason && reason.stack ? reason.stack : String(reason);
        console.error('Unhandled Rejection:', msg);
    } finally {
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

// Export the function to register routes instead of starting a server
module.exports = { registerApiRoutes };
