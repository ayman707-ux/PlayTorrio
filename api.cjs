const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');
const rateLimit = require('express-rate-limit');
const fs = require('fs').promises;
const NodeCache = require('node-cache');

// Initialize cache with 1 hour TTL
const gamesCache = new NodeCache({ stdTTL: 3600 });

// Optional MovieBox fetcher module (from bundled MovieBox API)
let movieboxFetcher = null;
try {
    movieboxFetcher = require('./MovieBox API/fetcher.js');
} catch (_) {
    movieboxFetcher = null;
}

// Export a function that registers all API routes on an existing Express app
function registerApiRoutes(app) {
    // Rate limiting - DISABLED for local use (was: 100 requests per 15 minutes)
    // const limiter = rateLimit({
    //     windowMs: 15 * 60 * 1000, // 15 minutes
    //     max: 100,
    //     message: 'Too many requests from this IP, please try again later.'
    // });
    // app.use(limiter);

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
// ============================================================================
// GAMES SERVICE (SteamRip API)
// ============================================================================

// Constants
const GAMES_API_URL = "https://api.ascendara.app";
const GAMES_BACKUP_CDN = "https://cdn.ascendara.app/files/data.json";

// Helper function to sanitize text
function sanitizeGameText(text) {
    if (!text) return text;
    return text
        .replace(/â€™/g, "'")
        .replace(/â€"/g, "—")
        .replace(/â€œ/g, '"')
        .replace(/â€/g, '"')
        .replace(/Â®/g, '®')
        .replace(/â„¢/g, '™')
        .replace(/Ã©/g, 'é')
        .replace(/Ã¨/g, 'è')
        .replace(/Ã /g, 'à')
        .replace(/Ã´/g, 'ô');
}

// Fetch games from API with caching
async function fetchGamesData(source = 'steamrip') {
    const cacheKey = `games_${source}`;
    const cachedData = gamesCache.get(cacheKey);
    
    if (cachedData) {
        return cachedData;
    }

    let endpoint = `${GAMES_API_URL}/json/games`;
    if (source === 'fitgirl') {
        endpoint = `${GAMES_API_URL}/json/sources/fitgirl/games`;
    }

    try {
        const response = await axios.get(endpoint);
        const data = response.data;

        // Sanitize game titles
        if (data.games) {
            data.games = data.games.map(game => ({
                ...game,
                name: sanitizeGameText(game.name),
                game: sanitizeGameText(game.game),
            }));
        }

        const result = {
            games: data.games || [],
            metadata: {
                apiversion: data.metadata?.apiversion,
                games: data.games?.length || 0,
                getDate: data.metadata?.getDate,
                source: data.metadata?.source || source,
                imagesAvailable: true,
            },
        };

        gamesCache.set(cacheKey, result);
        return result;
    } catch (error) {
        console.warn('Primary Games API failed, trying backup CDN:', error.message);
        
        try {
            const response = await axios.get(GAMES_BACKUP_CDN);
            const data = response.data;

            if (data.games) {
                data.games = data.games.map(game => ({
                    ...game,
                    name: sanitizeGameText(game.name),
                    game: sanitizeGameText(game.game),
                }));
            }

            const result = {
                games: data.games || [],
                metadata: {
                    apiversion: data.metadata?.apiversion,
                    games: data.games?.length || 0,
                    getDate: data.metadata?.getDate,
                    source: data.metadata?.source || source,
                    imagesAvailable: false,
                },
            };

            gamesCache.set(cacheKey, result);
            return result;
        } catch (cdnError) {
            throw new Error('Failed to fetch game data from both primary and backup sources');
        }
    }
}

// Get all games
app.get('/api/games/all', async (req, res) => {
    try {
        const source = req.query.source || 'steamrip';
        const data = await fetchGamesData(source);
        res.json(data);
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to fetch games', 
            message: error.message 
        });
    }
});

// Get random top games (for carousel/home screen)
app.get('/api/games/random', async (req, res) => {
    try {
        const count = parseInt(req.query.count) || 8;
        const minWeight = parseInt(req.query.minWeight) || 7;
        const source = req.query.source || 'steamrip';
        
        const { games } = await fetchGamesData(source);
        
        // Filter games with high weights and images
        const validGames = games.filter(game => 
            game.weight >= minWeight && game.imgID
        );

        // Shuffle and return requested number of games
        const shuffled = validGames.sort(() => 0.5 - Math.random());
        const result = shuffled.slice(0, count);
        
        res.json({ 
            games: result,
            count: result.length 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to fetch random games', 
            message: error.message 
        });
    }
});

// Search games
app.get('/api/games/search/:query', async (req, res) => {
    try {
        const query = req.params.query || '';
        const source = req.query.source || 'steamrip';
        
        if (!query.trim()) {
            return res.json({ games: [], count: 0 });
        }

        const { games } = await fetchGamesData(source);
        const searchTerm = query.toLowerCase();
        
        const results = games.filter(game =>
            game.title?.toLowerCase().includes(searchTerm) ||
            game.game?.toLowerCase().includes(searchTerm) ||
            game.description?.toLowerCase().includes(searchTerm)
        );
        
        res.json({ 
            games: results, 
            count: results.length,
            query: query 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to search games', 
            message: error.message 
        });
    }
});

// Get games by category
app.get('/api/games/category/:category', async (req, res) => {
    try {
        const { category } = req.params;
        const source = req.query.source || 'steamrip';
        
        const { games } = await fetchGamesData(source);
        
        const results = games.filter(game =>
            game.category && 
            Array.isArray(game.category) && 
            game.category.includes(category)
        );
        
        res.json({ 
            games: results, 
            count: results.length,
            category: category 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to fetch games by category', 
            message: error.message 
        });
    }
});

// Get specific game by image ID
app.get('/api/games/:imgID', async (req, res) => {
    try {
        const { imgID } = req.params;
        const source = req.query.source || 'steamrip';
        
        const { games } = await fetchGamesData(source);
        
        const game = games.find(g => g.imgID === imgID);
        
        if (!game) {
            return res.status(404).json({ 
                error: 'Game not found',
                imgID: imgID 
            });
        }
        
        res.json({ game });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to fetch game', 
            message: error.message 
        });
    }
});

// Proxy for game images
app.get('/api/games/image/:imgID', async (req, res) => {
    try {
        const { imgID } = req.params;
        const source = req.query.source || 'steamrip';
        
        let imageUrl;
        if (source === 'fitgirl') {
            imageUrl = `${GAMES_API_URL}/v2/fitgirl/image/${imgID}`;
        } else {
            imageUrl = `${GAMES_API_URL}/v2/image/${imgID}`;
        }
        
        console.log(`[GAMES] Fetching image from: ${imageUrl}`);
        
        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: 10000
        });
        
        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
        res.send(response.data);
    } catch (error) {
        console.error(`[GAMES] Image fetch error for ${req.params.imgID}:`, error.message);
        // Return a 404 instead of JSON error so image onerror handles it
        res.status(404).send('Image not found');
    }
});

// Get all categories
app.get('/api/games/categories', async (req, res) => {
    try {
        const source = req.query.source || 'steamrip';
        const { games } = await fetchGamesData(source);
        
        const categoriesSet = new Set();
        games.forEach(game => {
            if (game.category && Array.isArray(game.category)) {
                game.category.forEach(cat => categoriesSet.add(cat));
            }
        });
        
        const categories = Array.from(categoriesSet).sort();
        
        res.json({ 
            categories,
            count: categories.length 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to fetch categories', 
            message: error.message 
        });
    }
});

// Get game covers for search (limited results)
app.get('/api/games/covers', async (req, res) => {
    try {
        const query = req.query.q || '';
        const limit = parseInt(req.query.limit) || 20;
        const source = req.query.source || 'steamrip';
        
        if (!query.trim()) {
            return res.json({ covers: [], count: 0 });
        }

        const { games } = await fetchGamesData(source);
        const searchTerm = query.toLowerCase();
        
        const results = games
            .filter(game => game.game?.toLowerCase().includes(searchTerm))
            .slice(0, limit)
            .map(game => ({
                id: game.game,
                title: game.game,
                imgID: game.imgID,
            }));
        
        res.json({ 
            covers: results, 
            count: results.length,
            query: query 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to search covers', 
            message: error.message 
        });
    }
});

// Clear games cache endpoint
app.post('/api/games/cache/clear', (req, res) => {
    gamesCache.flushAll();
    res.json({ 
        message: 'Games cache cleared successfully',
        timestamp: new Date().toISOString()
    });
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
        example: 'http://localhost:6987/anime/api/one%20punch%20man'
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
        
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get(torrentioUrl);
        
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
        
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get(torrentioUrl);
        
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
const TORRENTLESS_ALLOWED_HOSTS = new Set(['uindex.org', 'www.uindex.org', 'knaben.org', 'www.knaben.org', 'torrentdownload.info', 'www.torrentdownload.info']);

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

// TorrentDownload.info scraper functions
async function torrentless_searchTorrentDownload(query) {
    try {
        const searchUrl = `https://www.torrentdownload.info/search?q=${encodeURIComponent(query)}`;
        
        const response = await axios.get(searchUrl, {
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        const $ = cheerio.load(response.data);
        const searchResults = [];
        
        // Find all torrent rows
        $('tr').each((_, element) => {
            const $row = $(element);
            const $nameCell = $row.find('td.tdleft');
            
            if ($nameCell.length > 0) {
                const $link = $nameCell.find('.tt-name a');
                const href = $link.attr('href');
                const title = $link.text().trim();
                
                // Get all td.tdnormal cells
                const tdNormal = $row.find('td.tdnormal');
                // Size is typically the second td.tdnormal (index 1)
                const sizeText = tdNormal.eq(1).text().trim();
                
                const seedsText = $row.find('td.tdseed').text().trim();
                const leechText = $row.find('td.tdleech').text().trim();
                
                if (href && title) {
                    searchResults.push({
                        title,
                        href,
                        sizeText,
                        seedsText,
                        leechText
                    });
                }
            }
        });
        
        console.log(`[TORRENTLESS] TorrentDownload found ${searchResults.length} search results`);
        
        // Fetch magnet links in parallel
        const items = [];
        const resultsWithMagnets = await Promise.all(
            searchResults.map(async (result) => {
                try {
                    const detailUrl = `https://www.torrentdownload.info${result.href}`;
                    const detailResponse = await axios.get(detailUrl, {
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    });
                    
                    const $detail = cheerio.load(detailResponse.data);
                    const magnet = $detail('a.tosa[href^="magnet:"]').attr('href');
                    
                    if (magnet) {
                        return {
                            title: result.title,
                            magnet: magnet,
                            size: result.sizeText,
                            seeds: parseInt(result.seedsText.replace(/,/g, ''), 10) || 0,
                            leechers: parseInt(result.leechText.replace(/,/g, ''), 10) || 0
                        };
                    }
                    return null;
                } catch (err) {
                    return null;
                }
            })
        );
        
        const validResults = resultsWithMagnets.filter(item => item !== null);
        console.log(`[TORRENTLESS] TorrentDownload returning ${validResults.length} items with magnets`);
        
        return { query, page: 1, items: validResults, pagination: { hasNext: false, nextPage: undefined } };
    } catch (error) {
        console.error('[TORRENTLESS] TorrentDownload error:', error?.message || error);
        return { query, page: 1, items: [], pagination: { hasNext: false, nextPage: undefined } };
    }
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
        validateStatus: () => true, // Accept all status codes to prevent unhandled rejections
    }).then(response => {
        // Check status after receiving response
        if (response.status >= 200 && response.status < 400) {
            return response;
        }
        // For rate limits or other errors, throw with proper message
        if (response.status === 429) {
            const retryAfter = response.headers['retry-after'] || '10';
            throw new Error(`Rate limited (429). Retry after ${retryAfter}s`);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText || 'Request failed'}`);
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
    // DISABLED - No rate limiting for local use
    next();
    return;
    
    // Original rate limiter code (disabled)
    /*
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
    */
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

        const [r1, r2, r3] = await Promise.allSettled([
            torrentless_searchUIndex(q, { page, category: 0 }),
            torrentless_searchKnaben(q, { page }),
            torrentless_searchTorrentDownload(q)
        ]);

        const items1 = r1.status === 'fulfilled' ? (r1.value.items || []) : [];
        const items2 = r2.status === 'fulfilled' ? (r2.value.items || []) : [];
        const items3 = r3.status === 'fulfilled' ? (r3.value.items || []) : [];
        
        console.log(`[TORRENTLESS] Sources: UIndex=${items1.length}, Knaben=${items2.length}, TorrentDownload=${items3.length}`);

        const seen = new Map(); // Changed to Map to track by hash+seeds
        const merged = [];
        function pushUnique(arr) {
            for (const it of arr) {
                const ih = torrentless_extractInfoHash(it.magnet) || it.title.toLowerCase();
                const seedCount = it.seeds || 0;
                // Create unique key combining hash and seed count
                const uniqueKey = `${ih}_${seedCount}`;
                
                if (seen.has(uniqueKey)) continue;
                seen.set(uniqueKey, true);
                
                // Transform to exact format: {name, magnet, size, seeds, leech}
                merged.push({
                    name: it.title,
                    magnet: it.magnet,
                    size: it.size || '',
                    seeds: (it.seeds || 0).toLocaleString('en-US'),
                    leech: (it.leechers || 0).toLocaleString('en-US')
                });
            }
        }
        pushUnique(items1);
        pushUnique(items2);
        pushUnique(items3);

        merged.sort((a, b) => {
            const seedsA = parseInt(a.seeds.replace(/,/g, ''), 10) || 0;
            const seedsB = parseInt(b.seeds.replace(/,/g, ''), 10) || 0;
            const leechA = parseInt(a.leech.replace(/,/g, ''), 10) || 0;
            const leechB = parseInt(b.leech.replace(/,/g, ''), 10) || 0;
            return seedsB - seedsA || leechB - leechA;
        });

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

// TorrentDownload scraper endpoint
app.get('/torrentdownload/api/search', torrentless_apiRateLimiter, async (req, res) => {
    try {
        const q = (req.query.q || '').toString().trim().slice(0, 100);
        if (!q) {
            return res.status(400).json({ error: 'Missing query ?q=' });
        }

        console.log(`[TORRENTDOWNLOAD] Proxying request to torrentscrapernew server for "${q}"`);
        
        // Call the working server at port 3001
        const response = await axios.get(`http://localhost:3001/api/torrent/search/${encodeURIComponent(q)}`, {
            timeout: 60000
        });
        
        const items = response.data || [];
        console.log(`[TORRENTDOWNLOAD] Received ${items.length} results from torrentscrapernew`);
        
        res.json({ query: q, items });
    } catch (err) {
        console.error('[TORRENTDOWNLOAD] Proxy error:', err?.message || err);
        res.status(502).json({ error: 'Failed to fetch results from TorrentDownload scraper.' });
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
// MOVIEBOX SERVICE (bundled from MovieBox API)
// ============================================================================

// Proxy base (Cloudflare Worker); keep requests limited to moviebox/fmovies
const MOVIEBOX_PROXY_BASE = process.env.MOVIEBOX_PROXY_URL || 'https://movieboxproxy.aymanisthedude1.workers.dev';
function moviebox_withProxy(url) {
    try {
        if (!/^https?:\/\/(moviebox|fmovies)/i.test(url)) return url;
        return `${MOVIEBOX_PROXY_BASE}?url=${encodeURIComponent(url)}`;
    } catch {
        return url;
    }
}

// Search helpers
const MOVIEBOX_SEARCH_BASES = ['https://moviebox.id', 'https://moviebox.ph'];
async function moviebox_fetchSearchHtml(query) {
    let lastErr = null;
    for (const base of MOVIEBOX_SEARCH_BASES) {
        const url = `${base}/web/searchResult?keyword=${encodeURIComponent(query)}`;
        try {
            const resp = await axios.get(moviebox_withProxy(url), {
                timeout: 20000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Referer': base + '/',
                },
                validateStatus: (s) => s >= 200 && s < 500,
            });
            if (resp.status >= 400) {
                lastErr = new Error(`MovieBox search failed with status ${resp.status} @ ${base}`);
                continue;
            }
            return { html: String(resp.data || ''), base };
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('MovieBox search failed on all bases');
}

function moviebox_slugifyBase(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
}

async function moviebox_getIdentifiersListFromQuery(query, opts = {}) {
    const offline = !!opts.offline;
    const preferredType = opts.preferredType; // 'movie' | 'tv' | undefined
    const debug = { mode: offline ? 'offline' : 'online' };

    let html = '';
    let queryUsed = query;
    const cleaned = movieboxFetcher && movieboxFetcher.sanitizeQueryName ? movieboxFetcher.sanitizeQueryName(query) : query;

    if (offline) {
        const file = opts.offlineFile || 'moviebox crack.txt';
        html = await fs.readFile(file, 'utf8');
        debug.file = file;
    } else if (movieboxFetcher && movieboxFetcher.fetchMovieboxSearchHtml) {
        html = await movieboxFetcher.fetchMovieboxSearchHtml(cleaned);
        queryUsed = cleaned;
    } else {
        const r = await moviebox_fetchSearchHtml(cleaned);
        html = r.html;
        queryUsed = cleaned;
    }

    const pairs = movieboxFetcher && movieboxFetcher.extractSlugIdPairs ? (movieboxFetcher.extractSlugIdPairs(html, queryUsed) || []) : [];
    const pool = pairs.slice();
    let items = pool.map(p => ({ detailPath: p.slug, subjectId: String(p.id), distance: 0, _type: p.type }));

    const base = moviebox_slugifyBase(queryUsed);
    const baseTokens = base.split('-').filter(Boolean);

    const STOPWORDS = new Set(['arabic','hindi','trailer','cam','ts','tc','screener','korean','turkish','thai','spanish','french','russian','subbed','dubbed','latino','portuguese','vietnamese','indonesian','malay','filipino']);

    function baseNameFromSlug(slug) {
        const m = String(slug).match(/^(.*?)-(?:[A-Za-z0-9]{6,})$/);
        return (m ? m[1] : String(slug)).toLowerCase();
    }

    function scoreSlug(slug) {
        const name = baseNameFromSlug(slug);
        const nameTokens = name.split('-').filter(Boolean);
        const nameJoined = nameTokens.join('-');
        const baseJoined = baseTokens.join('-');
        let s = 0;
        if (nameJoined === baseJoined) s += 200;
        if (nameJoined.startsWith(baseJoined + '-')) s += 300;
        const contiguousIdx = (() => {
            for (let i = 0; i <= nameTokens.length - baseTokens.length; i++) {
                let ok = true;
                for (let j = 0; j < baseTokens.length; j++) {
                    if (nameTokens[i + j] !== baseTokens[j]) { ok = false; break; }
                }
                if (ok) return i;
            }
            return -1;
        })();
        if (contiguousIdx === 0) s += 120; else if (contiguousIdx > 0) s += Math.max(0, 80 - contiguousIdx * 20);
        const setA = new Set(baseTokens);
        const setB = new Set(nameTokens);
        let inter = 0; setA.forEach(t => { if (setB.has(t)) inter++; });
        const jaccard = inter / (new Set([...setA, ...setB]).size || 1);
        s += Math.round(jaccard * 100);
        for (const t of nameTokens) { if (STOPWORDS.has(t)) s -= 200; }
        for (const t of nameTokens) { if (/^20\d{2}$/.test(t)) s += 40; }
        for (const t of nameTokens) { if (t === 'legacy' || t === 'final' || t === 'remastered' || t === 'extended') s += 60; }
        s -= Math.max(0, nameTokens.length - baseTokens.length) * 5;
        return s;
    }

    function contiguousStart(nameTokens, baseTokens) {
        for (let i = 0; i <= nameTokens.length - baseTokens.length; i++) {
            let ok = true;
            for (let j = 0; j < baseTokens.length; j++) {
                if (nameTokens[i + j] !== baseTokens[j]) { ok = false; break; }
            }
            if (ok) return i;
        }
        return -1;
    }

    const strict = items.filter(it => {
        const name = baseNameFromSlug(it.detailPath);
        const nameTokens = name.split('-').filter(Boolean);
        if (baseTokens.length >= 2) {
            return contiguousStart(nameTokens, baseTokens) !== -1;
        }
        return nameTokens.includes(baseTokens[0] || '');
    });
    if (strict.length) items = strict;

    items = items
        .map(it => {
            const baseScore = scoreSlug(it.detailPath);
            const typeBonus = preferredType ? (it._type === preferredType ? 150 : (it._type ? 0 : 60)) : 0;
            return { ...it, _score: baseScore + typeBonus };
        })
        .sort((a, b) => (b._score - a._score) || (a.detailPath.length - b.detailPath.length));

    const slugs = pool.map(p => p.slug);
    const ids = pool.map(p => String(p.id));
    return { items, debug: { ...debug, base, baseTokens, slugsFound: slugs, idsFound: ids, count: items.length } };
}

// FMovies/MovieBox play endpoints
const MOVIEBOX_FALLBACK_HOSTS = [
    'https://fmoviesunblocked.net',
    'https://moviebox.id',
    'https://moviebox.ph',
];

function moviebox_PLAY_URL(base, { subjectId, se = '0', ep = '0', detailPath }) {
    return `${base}/wefeed-h5-bff/web/subject/play?subjectId=${encodeURIComponent(subjectId)}&se=${encodeURIComponent(se)}&ep=${encodeURIComponent(ep)}&detail_path=${encodeURIComponent(detailPath)}`;
}
function moviebox_SPA_URLS(base, { detailPath, subjectId, isTv }) {
    const slug = encodeURIComponent(detailPath);
    const idq = `id=${encodeURIComponent(subjectId)}`;
    const urls = new Set();
    urls.add(`${base}/spa/videoPlayPage/${isTv ? 'tv' : 'movies'}/${slug}?${idq}`);
    urls.add(`${base}/spa/videoPlayPage/${slug}?${idq}`);
    urls.add(`${base}/spa/videoPlayPage/${isTv ? 'tv' : 'movies'}/${slug}?${idq}&lang=en`);
    urls.add(`${base}/spa/videoPlayPage/${slug}?${idq}&type=${isTv ? 'tv' : 'movie'}&lang=en`);
    if (isTv) {
        urls.add(`${base}/spa/videoPlayPage/movies/${slug}?${idq}&type=/tv/detail&lang=en`);
        urls.add(`${base}/spa/videoPlayPage/movies/${slug}?${idq}&type=/tv/detail`);
        urls.add(`${base}/spa/videoPlayPage/${slug}?${idq}&type=/tv/detail&lang=en`);
    } else {
        urls.add(`${base}/spa/videoPlayPage/movies/${slug}?${idq}&type=/movie/detail&lang=en`);
        urls.add(`${base}/spa/videoPlayPage/${slug}?${idq}&type=/movie/detail&lang=en`);
    }
    return Array.from(urls);
}

function moviebox_baseHeaders(forwardHeaders = {}) {
    const ua = forwardHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const h = {
        'User-Agent': ua,
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="141", "Google Chrome";v="141", ";Not A Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
    };
    return h;
}

function moviebox_mergeCookies(list) {
    const jar = new Map();
    for (const raw of list) {
        if (!raw) continue;
        const parts = raw.split(/;\s*/);
        for (const p of parts) {
            if (!p) continue;
            const [k, ...rest] = p.split('=');
            if (!k || !rest.length) continue;
            const key = k.trim();
            const val = rest.join('=').trim();
            if (!key || !val) continue;
            if (/^(Path|Domain|Expires|Max-Age|Secure|HttpOnly|SameSite)$/i.test(key)) continue;
            jar.set(key, val);
        }
    }
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function moviebox_safeJson(t) { try { return JSON.parse(t); } catch (_) { return null; } }

async function moviebox_fetchStreamsFromFMovies({ subjectId, detailPath, se = '0', ep = '0', forwardCookie = '', forwardHeaders = {} }) {
    const isTv = String(se) !== '0' || String(ep) !== '0';
    const baseHeadersTemplate = moviebox_baseHeaders(forwardHeaders);
    const tried = [];
    let lastError = null;
    for (const host of MOVIEBOX_FALLBACK_HOSTS) {
        try {
            const playUrl = moviebox_PLAY_URL(host, { subjectId, se, ep, detailPath });
            const directHeaders = { ...baseHeadersTemplate };
            directHeaders['Accept'] = 'application/json, text/plain, */*';
            directHeaders['Origin'] = host;
            const refererUrl = isTv
                ? `${host}/spa/videoPlayPage/movies/${encodeURIComponent(detailPath)}?id=${encodeURIComponent(subjectId)}&type=/tv/detail&lang=en`
                : `${host}/spa/videoPlayPage/movies/${encodeURIComponent(detailPath)}?id=${encodeURIComponent(subjectId)}&lang=en`;
            directHeaders['Referer'] = refererUrl;
            directHeaders['Sec-Fetch-Site'] = 'same-origin';
            directHeaders['Sec-Fetch-Mode'] = 'cors';
            directHeaders['Sec-Fetch-Dest'] = 'empty';
            if (forwardCookie) directHeaders['Cookie'] = forwardCookie;

            let resp = await axios.get(playUrl, { timeout: 20000, headers: directHeaders, validateStatus: s => s >= 200 && s < 500 });
            if (resp.status === 200) {
                const data = typeof resp.data === 'string' ? moviebox_safeJson(resp.data) : resp.data;
                if (data && data.code === 0 && data.data) {
                    const refererHeader = directHeaders['Referer'];
                    const cookieHeader = directHeaders['Cookie'] || '';
                    const uaHeader = directHeaders['User-Agent'];
                    const streams = Array.isArray(data.data.streams) ? data.data.streams.map(s => ({
                        format: s.format,
                        id: String(s.id),
                        url: s.url,
                        resolutions: String(s.resolutions),
                        size: s.size,
                        duration: s.duration,
                        codecName: s.codecName,
                        headers: { referer: refererHeader, cookie: cookieHeader, userAgent: uaHeader }
                    })) : [];
                    return { streams, raw: data, debug: { hostUsed: host, spaUsed: null, tried } };
                }
            }

            let warmCookies = '';
            let usedSpa = '';
            const spaUrls = moviebox_SPA_URLS(host, { detailPath, subjectId, isTv });
            for (const spaUrl of spaUrls) {
                try {
                    const warmHeaders = { ...baseHeadersTemplate };
                    warmHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
                    warmHeaders['Referer'] = host + '/';
                    const warm = await axios.get(moviebox_withProxy(spaUrl), { timeout: 20000, headers: warmHeaders, validateStatus: s => s >= 200 && s < 500 });
                    const setCookie = warm.headers['set-cookie'];
                    if (Array.isArray(setCookie)) warmCookies = setCookie.map(c => c.split(';')[0]).join('; ');
                    usedSpa = spaUrl;
                    break;
                } catch (e) {
                    tried.push({ host, spa: true, url: spaUrl, err: e?.message || String(e) });
                }
            }

            const headers = { ...baseHeadersTemplate };
            headers['Accept'] = 'application/json, text/plain, */*';
            headers['Origin'] = host;
            headers['Referer'] = usedSpa || (host + '/');
            headers['Sec-Fetch-Site'] = 'same-origin';
            headers['Sec-Fetch-Mode'] = 'cors';
            headers['Sec-Fetch-Dest'] = 'empty';
            const mergedCookie = moviebox_mergeCookies([forwardCookie, warmCookies]);
            if (mergedCookie) headers['Cookie'] = mergedCookie;

            resp = await axios.get(playUrl, { timeout: 20000, headers, validateStatus: s => s >= 200 && s < 500 });
            if (resp.status >= 400) {
                tried.push({ host, spa: false, url: playUrl, status: resp.status });
                lastError = new Error(`fmovies play failed with status ${resp.status} @ ${host}`);
                continue;
            }
            const data = typeof resp.data === 'string' ? moviebox_safeJson(resp.data) : resp.data;
            if (!data || data.code !== 0 || !data.data) {
                tried.push({ host, spa: false, url: playUrl, code: data?.code, note: 'invalid data' });
                lastError = new Error(`fmovies response invalid (code=${data?.code ?? 'n/a'}) @ ${host}`);
                continue;
            }

            const refererHeader = headers['Referer'];
            const cookieHeader = headers['Cookie'] || '';
            const uaHeader = headers['User-Agent'];
            const streams = Array.isArray(data.data.streams) ? data.data.streams.map(s => ({
                format: s.format,
                id: String(s.id),
                url: s.url,
                resolutions: String(s.resolutions),
                size: s.size,
                duration: s.duration,
                codecName: s.codecName,
                headers: {
                    referer: refererHeader,
                    cookie: cookieHeader,
                    userAgent: uaHeader
                }
            })) : [];
            return { streams, raw: data, debug: { hostUsed: host, spaUsed: usedSpa, tried } };
        } catch (e) {
            lastError = e;
        }
    }
    const e = lastError || new Error('All MovieBox/FMovies hosts failed');
    e.tried = tried;
    throw e;
}

// TMDB lookup
const MOVIEBOX_TMDB_API_KEY = 'b3556f3b206e16f82df4d1f6fd4545e6';
async function moviebox_getTitleForTmdbId(id, preferredType) {
    const order = preferredType === 'tv' ? ['tv', 'movie'] : preferredType === 'movie' ? ['movie', 'tv'] : ['movie', 'tv'];
    let lastError;
    for (const kind of order) {
        try {
            const url = `https://api.themoviedb.org/3/${kind}/${encodeURIComponent(id)}?api_key=${MOVIEBOX_TMDB_API_KEY}&language=en-US`;
            const resp = await axios.get(url, { timeout: 12000, validateStatus: s => s >= 200 && s < 500 });
            if (resp.status === 200 && resp.data) {
                const data = resp.data;
                const title = kind === 'movie' ? (data.title || data.original_title) : (data.name || data.original_name);
                const year = (kind === 'movie' ? data.release_date : data.first_air_date)?.slice(0, 4) || undefined;
                if (title) return { title, kind, year, tmdbId: String(id) };
            }
            lastError = new Error(`TMDB ${kind} lookup failed with status ${resp.status}`);
        } catch (e) { lastError = e; }
    }
    lastError = lastError || new Error('TMDB lookup failed');
    lastError.status = lastError.status || 502;
    throw lastError;
}

// MovieBox routes
async function moviebox_handleSearch(req, res) {
    let { query } = req.params;
    try {
        if (/^\d+$/.test(query)) {
            const preferredType = typeof req.query.type === 'string' ? req.query.type : undefined;
            const { title } = await moviebox_getTitleForTmdbId(query, preferredType);
            query = title;
        }

        const listRes = await moviebox_getIdentifiersListFromQuery(query, {
            offline: req.query.offline === 'true' || req.query.offline === '1',
            offlineFile: 'moviebox crack.txt',
            preferredType: typeof req.query.type === 'string' ? req.query.type : undefined,
        });
        let items = listRes.items || [];

        const mode = (req.query.mode || 'score').toString();
        const base = (listRes.debug && listRes.debug.base) ? String(listRes.debug.base) : moviebox_slugifyBase(query);
        if (mode === 'prefix' || mode === 'contains') {
            const pred = (slug) => {
                const s = String(slug).toLowerCase();
                if (mode === 'prefix') return s.startsWith(base + '-') || s === base;
                return s.includes(base);
            };
            const bySlug = new Map(items.map(it => [it.detailPath, it]));
            const union = new Map();
            for (const it of items) if (pred(it.detailPath)) union.set(it.detailPath, it);
            items = Array.from(union.values());
        }

        if (!items.length) {
            return res.status(404).json({ error: 'No matching items found' });
        }

        const cookie = req.headers['x-cookie'] || req.headers['cookie'] || '';
        const fwd = { 'user-agent': req.headers['user-agent'] };
        const se = req.query.se || '0';
        const ep = req.query.ep || '0';

        const variants = await Promise.all(items.map(async (it) => {
            try {
                const { streams } = await moviebox_fetchStreamsFromFMovies({
                    subjectId: it.subjectId,
                    detailPath: it.detailPath,
                    se, ep,
                    forwardCookie: cookie,
                    forwardHeaders: fwd,
                });
                return { ...it, streams };
            } catch (e) {
                return { ...it, error: e.message };
            }
        }));

        const results = [];
        for (const v of variants) {
            if (Array.isArray(v.streams)) {
                for (const s of v.streams) {
                    results.push({
                        source: v.detailPath,
                        resolutions: s.resolutions,
                        size: String(s.size ?? ''),
                        url: s.url
                    });
                }
            }
        }

        return res.json({ results });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ error: err.message || 'Unexpected error' });
    }
}

// Health & info routes and TMDB ID endpoints
app.get('/moviebox/health', (_req, res) => {
    res.json({ ok: true, service: 'moviebox', time: new Date().toISOString() });
});

app.get('/moviebox/', (_req, res) => {
    res.json({
        status: 'running',
        endpoints: {
            movie: '/moviebox/:tmdbId',
            tv: '/moviebox/tv/:tmdbId/:season/:episode',
            search: '/moviebox/api/:query (supports ?mode=prefix|contains|score&se=&ep=)',
            health: '/moviebox/health'
        }
    });
});

app.get('/moviebox/:tmdbId', async (req, res) => {
    const { tmdbId } = req.params;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ ok: false, error: 'Valid numeric TMDB ID is required' });
    }
    try {
        const { title } = await moviebox_getTitleForTmdbId(tmdbId, 'movie');
        const listRes = await moviebox_getIdentifiersListFromQuery(title, {
            offline: req.query.offline === 'true' || req.query.offline === '1',
            offlineFile: 'moviebox crack.txt',
            preferredType: 'movie',
        });
        const items = listRes.items || [];
        if (!items.length) {
            return res.status(404).json({ error: 'No matching items found for this movie' });
        }
        const cookie = req.headers['x-cookie'] || req.headers['cookie'] || '';
        const fwd = { 'user-agent': req.headers['user-agent'] };
        const topOnly = req.query.top === '1';
        const list = topOnly ? items.slice(0, 1) : items;
        const variants = await Promise.all(list.map(async (it) => {
            try {
                const { streams } = await moviebox_fetchStreamsFromFMovies({
                    subjectId: it.subjectId,
                    detailPath: it.detailPath,
                    se: '0', ep: '0',
                    forwardCookie: cookie,
                    forwardHeaders: fwd,
                });
                return { detailPath: it.detailPath, subjectId: it.subjectId, streams };
            } catch (e) {
                return { detailPath: it.detailPath, subjectId: it.subjectId, error: e.message, streams: [] };
            }
        }));
        const results = [];
        for (const v of variants) {
            if (Array.isArray(v.streams)) {
                for (const s of v.streams) {
                    results.push({ source: v.detailPath, resolutions: s.resolutions, size: String(s.size ?? ''), url: s.url });
                }
            }
        }
        return res.json({ results });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ error: err.message || 'Unexpected error' });
    }
});

app.get('/moviebox/tv/:tmdbId/:season/:episode', async (req, res) => {
    const { tmdbId, season, episode } = req.params;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) return res.status(400).json({ ok: false, error: 'Valid numeric TMDB ID is required' });
    if (!season || !/^\d+$/.test(season)) return res.status(400).json({ ok: false, error: 'Valid season number is required' });
    if (!episode || !/^\d+$/.test(episode)) return res.status(400).json({ ok: false, error: 'Valid episode number is required' });
    try {
        const { title } = await moviebox_getTitleForTmdbId(tmdbId, 'tv');
        const listRes = await moviebox_getIdentifiersListFromQuery(title, {
            offline: req.query.offline === 'true' || req.query.offline === '1',
            offlineFile: 'moviebox crack.txt',
            preferredType: 'tv',
        });
        const items = listRes.items || [];
        if (!items.length) return res.status(404).json({ error: 'No matching items found for this TV show' });
        const cookie = req.headers['x-cookie'] || req.headers['cookie'] || '';
        const fwd = { 'user-agent': req.headers['user-agent'] };
        const topOnly = req.query.top === '1';
        const list = topOnly ? items.slice(0, 1) : items;
        const variants = await Promise.all(list.map(async (it) => {
            try {
                const { streams } = await moviebox_fetchStreamsFromFMovies({
                    subjectId: it.subjectId,
                    detailPath: it.detailPath,
                    se: season, ep: episode,
                    forwardCookie: cookie,
                    forwardHeaders: fwd,
                });
                return { detailPath: it.detailPath, subjectId: it.subjectId, streams };
            } catch (e) {
                return { detailPath: it.detailPath, subjectId: it.subjectId, error: e.message, streams: [] };
            }
        }));
        const results = [];
        for (const v of variants) {
            if (Array.isArray(v.streams)) {
                for (const s of v.streams) {
                    results.push({ source: v.detailPath, resolutions: s.resolutions, size: String(s.size ?? ''), url: s.url });
                }
            }
        }
        return res.json({ results });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ error: err.message || 'Unexpected error' });
    }
});

// Legacy search endpoints
app.get('/moviebox/api/:query', moviebox_handleSearch);
app.get('/api/moviebox/:query', moviebox_handleSearch);

// ============================================================================
// Z-LIBRARY SERVICE (from z-lib.js)
// ============================================================================

const ZLIB_DOMAINS = [
    'z-lib.io',
    'zlibrary-global.se',
    'booksc.org',       
    '1lib.sk',      
    'z-lib.gd',
    'z-library.sk',
    'zlibrary.to',
    'z-lib.fm',
    'z-lib.se',
    'z-lib.is',
    'z-lib.org'
];

function zlib_createAxiosInstance() {
    return axios.create({
        timeout: 45000, // Increased from 30s to 45s for slower connections
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400, // Accept redirects
        headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none'
        }
    });
}

async function zlib_getReadLink(bookUrl, workingDomain) {
    try {
        const axiosInstance = zlib_createAxiosInstance();
        const response = await axiosInstance.get(bookUrl, {
            timeout: 20000 // Shorter timeout for individual book pages
        });
        
        if (response.status !== 200) {
            console.log(`[ZLIB] Non-200 status for book page: ${response.status}`);
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
            'a[data-book_id][href*="reader"]',
            'a[onclick*="reader"]'
        ];
        
        for (const selector of readSelectors) {
            const elements = $(selector);
            
            elements.each((i, el) => {
                const $el = $(el);
                const href = $el.attr('href');
                
                if (href && (href.includes('reader.z-lib') || href.includes('reader.singlelogin.site'))) {
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
                
                if (response.status === 200 && response.data && response.data.length > 100) {
                    searchResults = response.data;
                    workingDomain = domain;
                    console.log(`[ZLIB] ✅ Successfully connected to: ${domain}`);
                    break;
                }
            } catch (error) {
                console.log(`[ZLIB] ❌ Failed to connect to ${domain}: ${error.code || error.message}`);
                continue;
            }
        }

        if (!searchResults) {
            console.error('[ZLIB] All domains failed. Domains tried:', ZLIB_DOMAINS);
            return res.status(503).json({ 
                error: 'Unable to connect to any Z-Library servers. They might be temporarily down, blocked by your ISP, or require a VPN.',
                suggestion: 'Try using a VPN or check if Z-Library is accessible in your region.',
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
        
        // Fetch read links for all books (not just first 5) but with parallel processing
        const booksWithReadLinks = [];
        const readLinkPromises = books.map(async (book) => {
            try {
                const readLink = await zlib_getReadLink(book.bookUrl, workingDomain);
                return {
                    title: book.title,
                    author: book.author,
                    photo: book.coverUrl || 'No image available',
                    readLink: readLink || 'Read link not available',
                    bookUrl: book.bookUrl,
                    format: book.format,
                    year: book.year
                };
            } catch (error) {
                console.error(`[ZLIB] Error fetching read link for "${book.title}":`, error.message);
                // Return book without read link instead of failing
                return {
                    title: book.title,
                    author: book.author,
                    photo: book.coverUrl || 'No image available',
                    readLink: 'Read link not available',
                    bookUrl: book.bookUrl,
                    format: book.format,
                    year: book.year
                };
            }
        });
        
        // Process all books in parallel with timeout protection
        const results = await Promise.allSettled(readLinkPromises);
        results.forEach((result) => {
            if (result.status === 'fulfilled' && result.value) {
                booksWithReadLinks.push(result.value);
            }
        });

        console.log(`[ZLIB] Returning ${booksWithReadLinks.length} books with read links`);

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

// MOVIEBOX SERVICE removed from this file. The functionality now lives in moviebox.js.

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
                example: 'http://localhost:6987/anime/api/one%20punch%20man'
            },
            torrentio: {
                description: 'Movie & TV show torrents via Torrentio',
                endpoints: {
                    movies: '/torrentio/api/{imdbid}',
                    tvshows: '/torrentio/api/{imdbid}/{season}/{episode}',
                    info: '/torrentio/'
                },
                examples: {
                    movie: 'http://localhost:6987/torrentio/api/tt5950044',
                    tvshow: 'http://localhost:6987/torrentio/api/tt13159924/2/1'
                }
            },
            torrentless: {
                description: 'Torrent search via UIndex & Knaben',
                endpoints: {
                    search: '/torrentless/api/search?q={query}&page={page}',
                    proxy: '/torrentless/api/proxy?url={url}',
                    health: '/torrentless/api/health'
                },
                example: 'http://localhost:6987/torrentless/api/search?q=ubuntu'
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
                example: 'http://localhost:6987/zlib/search/python%20programming'
            },
            moviebox: {
                description: 'MovieBox/FMovies scraper with TMDB lookup',
                endpoints: {
                    health: '/moviebox/health',
                    info: '/moviebox/',
                    search: '/moviebox/api/{query}',
                    movieByTmdbId: '/moviebox/{tmdbId}',
                    tvByTmdbId: '/moviebox/tv/{tmdbId}/{season}/{episode}'
                },
                example: 'http://localhost:6987/moviebox/api/Greys%20anatomy?mode=prefix&se=22&ep=1'
            },
            otherbook: {
                description: 'Book search via RandomBook/LibGen with covers',
                endpoints: {
                    search: '/otherbook/api/search/{query}',
                    download: '/otherbook/api/download/{bookId}',
                    info: '/otherbook/',
                    health: '/otherbook/health'
                },
                example: 'http://localhost:6987/otherbook/api/search/The%20midnight%20library'
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
                example: 'http://localhost:6987/111477/api/tmdb/movie/550'
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
        services: ['anime', 'torrentio', 'torrentless', 'zlib', 'otherbook', '111477', 'realm']
    });
});

// ============================================================================
// REALM ANIME SOURCES
// ============================================================================

const https = require('https');
const zlib = require('zlib');

// Proxy endpoint to handle referer headers for realm streams
app.get('/api/realm/proxy', async (req, res) => {
    const { url, referer } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    try {
        const parsedUrl = new URL(url);
        
        // Determine if this is an HLS playlist or segment
        const isPlaylist = parsedUrl.pathname.includes('.m3u8');
        const isSegment = parsedUrl.pathname.includes('.ts') || parsedUrl.pathname.includes('.aac');
        
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': isPlaylist ? 'application/vnd.apple.mpegurl, */*' : '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'keep-alive',
            }
        };
        
        // Add referer headers if provided - use for all requests
        const effectiveReferer = referer || parsedUrl.origin;
        if (effectiveReferer) {
            options.headers['Referer'] = effectiveReferer;
            try {
                options.headers['Origin'] = new URL(effectiveReferer).origin;
            } catch (e) {
                options.headers['Origin'] = parsedUrl.origin;
            }
        }
        
        // Forward Range header from client for seeking
        if (req.headers.range) {
            options.headers['Range'] = req.headers.range;
        }
        
        const protocol = parsedUrl.protocol === 'https:' ? https : require('http');
        
        const proxyReq = protocol.request(options, (proxyRes) => {
            // Set status code
            res.status(proxyRes.statusCode);
            
            // For HLS playlists, we need to modify the content to proxy all URLs
            if (isPlaylist && proxyRes.headers['content-type']?.includes('mpegurl')) {
                let data = '';
                
                proxyRes.on('data', (chunk) => {
                    data += chunk.toString();
                });
                
                proxyRes.on('end', () => {
                    // Replace all URLs in the playlist with proxied versions
                    const lines = data.split('\n');
                    const modifiedLines = lines.map(line => {
                        line = line.trim();
                        
                        // Skip empty lines and comments (except URI lines)
                        if (!line || (line.startsWith('#') && !line.includes('URI='))) {
                            return line;
                        }
                        
                        // Handle #EXT-X-KEY lines with URI
                        if (line.startsWith('#EXT-X-KEY') && line.includes('URI=')) {
                            return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                                const absoluteUrl = uri.startsWith('http') ? uri : new URL(uri, url).href;
                                const proxiedUrl = `http://localhost:6987/api/realm/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(effectiveReferer)}`;
                                return `URI="${proxiedUrl}"`;
                            });
                        }
                        
                        // Handle segment URLs (non-comment lines)
                        if (!line.startsWith('#')) {
                            const absoluteUrl = line.startsWith('http') ? line : new URL(line, url).href;
                            return `http://localhost:6987/api/realm/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(effectiveReferer)}`;
                        }
                        
                        return line;
                    });
                    
                    const modifiedPlaylist = modifiedLines.join('\n');
                    
                    // Set headers
                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                    res.setHeader('Content-Length', Buffer.byteLength(modifiedPlaylist));
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    
                    res.send(modifiedPlaylist);
                });
                
                proxyRes.on('error', (err) => {
                    console.error('[Realm Proxy] Playlist error:', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Playlist processing error' });
                    }
                });
            } else {
                // For non-playlist content, stream directly
                // Forward important headers
                if (proxyRes.headers['content-type']) {
                    res.setHeader('Content-Type', proxyRes.headers['content-type']);
                }
                if (proxyRes.headers['content-length']) {
                    res.setHeader('Content-Length', proxyRes.headers['content-length']);
                }
                if (proxyRes.headers['accept-ranges']) {
                    res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
                }
                if (proxyRes.headers['content-range']) {
                    res.setHeader('Content-Range', proxyRes.headers['content-range']);
                }
                
                // CORS headers - critical for HLS playback
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
                res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
                
                // Cache control
                if (isSegment) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000');
                } else {
                    res.setHeader('Cache-Control', 'no-cache');
                }
                
                // Stream the response directly
                proxyRes.pipe(res);
            }
        });
        
        proxyReq.on('error', (error) => {
            console.error('[Realm Proxy] Request error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Proxy request failed', details: error.message });
            }
        });
        
        // Handle client disconnect
        req.on('close', () => {
            proxyReq.destroy();
        });
        
        req.on('error', () => {
            proxyReq.destroy();
        });
        
        proxyReq.end();
    } catch (error) {
        console.error('[Realm Proxy] Error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Realm anime sources endpoint
app.get('/api/realm/:anilistId/:episodeNumber', async (req, res) => {
    const { anilistId, episodeNumber } = req.params;
    
    if (!anilistId || !episodeNumber) {
        return res.status(400).json({ error: 'Missing anilistId or episodeNumber' });
    }
    
    try {
        const providers = [
            'allmanga',
            'animez',
            'animepahe',
            'zencloud',
            'animepahe-dub',
            'allmanga-dub',
            'hanime-tv'
        ];
        
        const results = {};
        
        const promises = providers.map(provider =>
            fetchFromRealmProvider(provider, parseInt(anilistId), parseInt(episodeNumber))
                .then(data => {
                    results[provider] = data;
                })
                .catch(error => {
                    results[provider] = { error: error.message };
                })
        );
        
        await Promise.all(promises);
        
        res.json(results);
    } catch (error) {
        console.error('[Realm] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

function fetchFromRealmProvider(provider, anilistId, episodeNumber) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            provider: provider,
            anilistId: anilistId,
            episodeNumber: episodeNumber
        });
        
        const options = {
            hostname: 'www.animerealms.org',
            path: '/api/watch',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Referer': 'https://www.animerealms.org/en/watch/' + anilistId + '/' + episodeNumber,
                'Origin': 'https://www.animerealms.org',
                'Cookie': '__Host-authjs.csrf-token=78f2694c0cc09f6ce564239018ccc01568c553645944459ef139123511eaa258%7Ce9c67743f1d1a54cf5d25c8a46f1069f92d7d9d1deabdde61e474ae7fde5fb6d; __Secure-authjs.callback-url=https%3A%2F%2Fbeta.animerealms.org',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'sec-ch-ua': '"Chromium";v="142", "Brave";v="142", "Not_A Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'sec-gpc': '1',
                'priority': 'u=1, i'
            }
        };
        
        const apiRequest = https.request(options, (apiResponse) => {
            let data = [];
            
            apiResponse.on('data', (chunk) => {
                data.push(chunk);
            });
            
            apiResponse.on('end', () => {
                try {
                    const buffer = Buffer.concat(data);
                    const encoding = apiResponse.headers['content-encoding'];
                    
                    let decompressed;
                    if (encoding === 'gzip') {
                        decompressed = zlib.gunzipSync(buffer);
                    } else if (encoding === 'deflate') {
                        decompressed = zlib.inflateSync(buffer);
                    } else if (encoding === 'br') {
                        decompressed = zlib.brotliDecompressSync(buffer);
                    } else {
                        decompressed = buffer;
                    }
                    
                    const result = JSON.parse(decompressed.toString());
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        apiRequest.on('error', (error) => {
            reject(error);
        });
        
        apiRequest.write(postData);
        apiRequest.end();
    });
}

// ============================================================================
// AUDIOBOOKS API (zaudiobooks.com scraper)
// ============================================================================

app.get('/api/audiobooks/all', async (req, res) => {
    try {
        const response = await axios.get('https://zaudiobooks.com/');
        const html = response.data;
        const $ = cheerio.load(html);
        
        const audiobooks = [];
        
        $('#more_content_books .post').each((index, element) => {
            const $element = $(element);
            const $summary = $element.find('.summary');
            
            const link = $summary.find('a').first().attr('href');
            const image = $summary.find('img').attr('src');
            const title = $summary.find('.news-title a').text().trim();
            
            if (title && link) {
                audiobooks.push({
                    title: title,
                    link: link,
                    image: image || '',
                    post_name: link.split('/').filter(Boolean).pop()
                });
            }
        });
        
        res.json({
            success: true,
            count: audiobooks.length,
            data: audiobooks
        });
    } catch (error) {
        console.error('[AUDIOBOOKS] Error fetching:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch audiobooks'
        });
    }
});

app.get('/api/audiobooks/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ success: false, error: 'Query parameter required' });
        }
        
        const searchUrl = `https://zaudiobooks.com/?s=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl);
        const html = response.data;
        const $ = cheerio.load(html);
        
        const audiobooks = [];
        
        // Parse search results from article.post elements
        const articles = $('article.post');
        
        // Fetch images for each book by visiting their individual pages
        const bookPromises = [];
        
        articles.each((index, element) => {
            const $article = $(element);
            const title = $article.find('.entry-title a').text().trim();
            const link = $article.find('.entry-title a').attr('href');
            
            if (title && link) {
                bookPromises.push(
                    axios.get(link)
                        .then(pageResponse => {
                            const page$ = cheerio.load(pageResponse.data);
                            const image = page$('meta[property="og:image:secure_url"]').attr('content') || '';
                            
                            return {
                                title: title,
                                link: link,
                                image: image,
                                post_name: link.split('/').filter(Boolean).pop()
                            };
                        })
                        .catch(error => {
                            console.error(`[AUDIOBOOKS] Error fetching image for ${link}:`, error.message);
                            return {
                                title: title,
                                link: link,
                                image: '',
                                post_name: link.split('/').filter(Boolean).pop()
                            };
                        })
                );
            }
        });
        
        const results = await Promise.all(bookPromises);
        
        res.json({
            success: true,
            query: query,
            count: results.length,
            data: results
        });
    } catch (error) {
        console.error('[AUDIOBOOKS] Search error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Search failed'
        });
    }
});

// AudioBooks load more endpoint
app.get('/api/audiobooks/more/:page', async (req, res) => {
    try {
        const page = parseInt(req.params.page) || 2;
        
        const response = await axios.post(
            'https://zaudiobooks.com/api/top_view_more_public.php',
            { page: page },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const books = response.data;
        
        // Transform the data to a consistent format
        const audiobooks = books.map(book => ({
            post_id: book.post_id,
            title: book.post_title,
            post_name: book.post_name,
            image: book.image ? `https://zaudiobooks.com/wp-content/uploads/post_images/${book.image}` : '',
            link: `https://zaudiobooks.com/${book.post_name}`,
            score: book.score
        }));
        
        res.json({
            success: true,
            page: page,
            count: audiobooks.length,
            data: audiobooks
        });
    } catch (error) {
        console.error('[AUDIOBOOKS] Load more error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to load more audiobooks'
        });
    }
});

app.get('/api/audiobooks/details/:post_name', async (req, res) => {
    try {
        const postName = req.params.post_name;
        const url = `https://zaudiobooks.com/${postName}/`;
        
        const response = await axios.get(url);
        const html = response.data;
        const $ = cheerio.load(html);
        
        const title = $('.entry-title').text().trim();
        const image = $('.entry-content img').first().attr('src');
        const description = $('.entry-content p').first().text().trim();
        
        const downloadLinks = [];
        $('.entry-content a').each((index, element) => {
            const $link = $(element);
            const href = $link.attr('href');
            const text = $link.text().trim();
            
            if (href && (href.includes('mega.nz') || href.includes('drive.google') || 
                         href.includes('mediafire') || href.includes('dropbox') ||
                         text.toLowerCase().includes('download'))) {
                downloadLinks.push({
                    text: text,
                    url: href
                });
            }
        });
        
        res.json({
            success: true,
            data: {
                title,
                image,
                description,
                downloadLinks
            }
        });
    } catch (error) {
        console.error('[AUDIOBOOKS] Details error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch details'
        });
    }
});

// AudioBooks chapters endpoint
app.get('/api/audiobooks/chapters/:post_name', async (req, res) => {
    try {
        const postName = req.params.post_name;
        const bookUrl = `https://zaudiobooks.com/${postName}/`;
        
        const response = await axios.get(bookUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://zaudiobooks.com/'
            }
        });
        const html = response.data;
        
        // Extract tracks array from the JavaScript code
        const startMatch = html.match(/tracks\s*=\s*\[/);
        
        if (startMatch) {
            const startIndex = startMatch.index + startMatch[0].length - 1;
            let bracketCount = 0;
            let endIndex = startIndex;
            
            // Find the matching closing bracket
            for (let i = startIndex; i < html.length; i++) {
                if (html[i] === '[' || html[i] === '{') bracketCount++;
                if (html[i] === ']' || html[i] === '}') bracketCount--;
                
                if (bracketCount === 0 && html[i] === ']') {
                    endIndex = i + 1;
                    break;
                }
            }
            
            const tracksStr = html.substring(startIndex, endIndex);
            
            try {
                // Clean up the JavaScript object to make it valid JSON
                let tracksJson = tracksStr
                    .replace(/,(\s*[}\]])/g, '$1')         // Remove trailing commas
                    .replace(/(\s)(\w+):/g, '$1"$2":')     // Add quotes to keys
                    .replace(/'/g, '"');                    // Replace single quotes
                
                const chapters = JSON.parse(tracksJson);
                
                res.json({
                    success: true,
                    postName: postName,
                    count: chapters.length,
                    data: chapters
                });
            } catch (parseError) {
                console.error('[AUDIOBOOKS] Parse error:', parseError.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to parse chapters data'
                });
            }
        } else {
            res.status(404).json({
                success: false,
                error: 'Chapters not found on page'
            });
        }
    } catch (error) {
        console.error('[AUDIOBOOKS] Chapters error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch chapters'
        });
    }
});

// AudioBooks stream endpoint
app.post('/api/audiobooks/stream', async (req, res) => {
    try {
        const { chapterId, serverType = 1 } = req.body;
        
        if (!chapterId) {
            return res.status(400).json({
                success: false,
                error: 'chapterId is required'
            });
        }
        
        const response = await axios.post(
            'https://api.galaxyaudiobook.com/api/getMp3Link',
            {
                chapterId: parseInt(chapterId),
                serverType: serverType
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Origin': 'https://zaudiobooks.com',
                    'Referer': 'https://zaudiobooks.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
                }
            }
        );
        
        res.json({
            success: true,
            data: response.data
        });
    } catch (error) {
        console.error('[AUDIOBOOKS] Stream error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to get stream link'
        });
    }
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