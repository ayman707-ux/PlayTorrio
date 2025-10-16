const express = require('express');
const cors = require('cors');
const { parseMovieDirectory, parseTvDirectory, isValidMovieUrl } = require('./parser');
const { fetchHtml, fetchMovieByName, buildMovieUrl, normalizeUrl } = require('./httpClient');
const { getMovieByTmdbId, getTvByTmdbId, isValidTmdbId, isApiKeyConfigured, searchMovies } = require('./tmdbClient');

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        tmdbApiConfigured: isApiKeyConfigured()
    });
});

// Get movie data by movie name
app.get('/api/movies/:movieName', async (req, res) => {
    try {
        const movieName = decodeURIComponent(req.params.movieName);
        console.log(`Fetching movie: ${movieName}`);
        
        const html = await fetchMovieByName(movieName);
        const movieUrl = buildMovieUrl(movieName);
        const result = parseMovieDirectory(html, movieUrl);
        
        res.json(result);
    } catch (error) {
        console.error('Error fetching movie:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            movieName: req.params.movieName
        });
    }
});

// Get movie data by TMDB ID
app.get('/api/tmdb/movie/:tmdbId', async (req, res) => {
    try {
        const tmdbId = req.params.tmdbId;
        
        if (!isValidTmdbId(tmdbId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid TMDB ID. Must be a positive number.'
            });
        }
        
        if (!isApiKeyConfigured()) {
            return res.status(500).json({
                success: false,
                error: 'TMDB API key not configured. Please set TMDB_API_KEY environment variable.'
            });
        }
        
        console.log(`Fetching movie by TMDB ID: ${tmdbId}`);
        
        // Get movie details from TMDB and construct URL
        const tmdbResult = await getMovieByTmdbId(tmdbId);
        console.log(`Constructed movie URL: ${tmdbResult.movieUrl}`);
        
        // Fetch the movie files from the constructed URL
        const html = await fetchHtml(tmdbResult.movieUrl);
        const parseResult = parseMovieDirectory(html, tmdbResult.movieUrl);
        
        // Combine TMDB data with parsed file data
        const result = {
            ...parseResult,
            tmdb: {
                id: tmdbResult.tmdbId,
                title: tmdbResult.title,
                originalTitle: tmdbResult.originalTitle,
                releaseDate: tmdbResult.releaseDate,
                year: tmdbResult.year,
                overview: tmdbResult.overview,
                posterPath: tmdbResult.posterPath ? `https://image.tmdb.org/t/p/w500${tmdbResult.posterPath}` : null,
                backdropPath: tmdbResult.backdropPath ? `https://image.tmdb.org/t/p/w1280${tmdbResult.backdropPath}` : null,
                genres: tmdbResult.genres,
                runtime: tmdbResult.runtime,
                imdbId: tmdbResult.imdbId
            }
        };
        
        res.json(result);
    } catch (error) {
        console.error('Error fetching movie by TMDB ID:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            tmdbId: req.params.tmdbId
        });
    }
});

// Get TV show data by TMDB ID (general, no specific season)
app.get('/api/tmdb/tv/:tmdbId', async (req, res) => {
    try {
        const tmdbId = req.params.tmdbId;
        
        if (!isValidTmdbId(tmdbId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid TMDB ID. Must be a positive number.'
            });
        }
        
        if (!isApiKeyConfigured()) {
            return res.status(500).json({
                success: false,
                error: 'TMDB API key not configured. Please set TMDB_API_KEY environment variable.'
            });
        }
        
        console.log(`Fetching TV show by TMDB ID: ${tmdbId}`);
        
        // Get TV show details from TMDB and construct URL
        const tmdbResult = await getTvByTmdbId(tmdbId);
        console.log(`Constructed TV show URL: ${tmdbResult.tvUrl}`);
        
        // Return TMDB data with available seasons info
        const result = {
            success: true,
            tvName: tmdbResult.tvName,
            baseUrl: tmdbResult.tvUrl,
            tmdb: {
                id: tmdbResult.tmdbId,
                name: tmdbResult.name,
                originalName: tmdbResult.originalName,
                firstAirDate: tmdbResult.firstAirDate,
                lastAirDate: tmdbResult.lastAirDate,
                year: tmdbResult.year,
                overview: tmdbResult.overview,
                posterPath: tmdbResult.posterPath ? `https://image.tmdb.org/t/p/w500${tmdbResult.posterPath}` : null,
                backdropPath: tmdbResult.backdropPath ? `https://image.tmdb.org/t/p/w1280${tmdbResult.backdropPath}` : null,
                genres: tmdbResult.genres,
                numberOfSeasons: tmdbResult.numberOfSeasons,
                numberOfEpisodes: tmdbResult.numberOfEpisodes,
                status: tmdbResult.status,
                networks: tmdbResult.networks
            },
            message: `Use /api/tmdb/tv/${tmdbId}/season/1 to get files for a specific season`
        };
        
        res.json(result);
    } catch (error) {
        console.error('Error fetching TV show by TMDB ID:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            tmdbId: req.params.tmdbId
        });
    }
});

// Get TV show season data by TMDB ID
app.get('/api/tmdb/tv/:tmdbId/season/:season', async (req, res) => {
    try {
        const tmdbId = req.params.tmdbId;
        const season = parseInt(req.params.season);
        
        if (!isValidTmdbId(tmdbId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid TMDB ID. Must be a positive number.'
            });
        }
        
        if (!season || season < 1) {
            return res.status(400).json({
                success: false,
                error: 'Invalid season number. Must be a positive number.'
            });
        }
        
        if (!isApiKeyConfigured()) {
            return res.status(500).json({
                success: false,
                error: 'TMDB API key not configured. Please set TMDB_API_KEY environment variable.'
            });
        }
        
        console.log(`Fetching TV show by TMDB ID: ${tmdbId}, Season: ${season}`);
        
        // Get TV show details from TMDB and construct URL
        const tmdbResult = await getTvByTmdbId(tmdbId, season);
        console.log(`Constructed TV show season URL: ${tmdbResult.tvUrl}`);
        
        // Fetch the TV show files from the constructed URL
        const html = await fetchHtml(tmdbResult.tvUrl);
        const parseResult = parseTvDirectory(html, tmdbResult.tvUrl, season);
        
        // Combine TMDB data with parsed file data
        const result = {
            ...parseResult,
            tmdb: {
                id: tmdbResult.tmdbId,
                name: tmdbResult.name,
                originalName: tmdbResult.originalName,
                firstAirDate: tmdbResult.firstAirDate,
                lastAirDate: tmdbResult.lastAirDate,
                year: tmdbResult.year,
                overview: tmdbResult.overview,
                posterPath: tmdbResult.posterPath ? `https://image.tmdb.org/t/p/w500${tmdbResult.posterPath}` : null,
                backdropPath: tmdbResult.backdropPath ? `https://image.tmdb.org/t/p/w1280${tmdbResult.backdropPath}` : null,
                genres: tmdbResult.genres,
                numberOfSeasons: tmdbResult.numberOfSeasons,
                numberOfEpisodes: tmdbResult.numberOfEpisodes,
                status: tmdbResult.status,
                networks: tmdbResult.networks
            },
            season
        };
        
        res.json(result);
    } catch (error) {
        console.error('Error fetching TV show season by TMDB ID:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            tmdbId: req.params.tmdbId,
            season: req.params.season
        });
    }
});

// Get specific episode data by TMDB ID
app.get('/api/tmdb/tv/:tmdbId/season/:season/episode/:episode', async (req, res) => {
    try {
        const tmdbId = req.params.tmdbId;
        const season = parseInt(req.params.season);
        const episode = parseInt(req.params.episode);
        
        if (!isValidTmdbId(tmdbId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid TMDB ID. Must be a positive number.'
            });
        }
        
        if (!season || season < 1) {
            return res.status(400).json({
                success: false,
                error: 'Invalid season number. Must be a positive number.'
            });
        }
        
        if (!episode || episode < 1) {
            return res.status(400).json({
                success: false,
                error: 'Invalid episode number. Must be a positive number.'
            });
        }
        
        if (!isApiKeyConfigured()) {
            return res.status(500).json({
                success: false,
                error: 'TMDB API key not configured. Please set TMDB_API_KEY environment variable.'
            });
        }
        
        console.log(`Fetching TV show by TMDB ID: ${tmdbId}, Season: ${season}, Episode: ${episode}`);
        
        // Get TV show details from TMDB and construct URL
        const tmdbResult = await getTvByTmdbId(tmdbId, season);
        console.log(`Constructed TV show season URL: ${tmdbResult.tvUrl}`);
        
        // Fetch the TV show files from the constructed URL and filter by episode
        const html = await fetchHtml(tmdbResult.tvUrl);
        const parseResult = parseTvDirectory(html, tmdbResult.tvUrl, season, episode);
        
        // Combine TMDB data with parsed file data
        const result = {
            ...parseResult,
            tmdb: {
                id: tmdbResult.tmdbId,
                name: tmdbResult.name,
                originalName: tmdbResult.originalName,
                firstAirDate: tmdbResult.firstAirDate,
                lastAirDate: tmdbResult.lastAirDate,
                year: tmdbResult.year,
                overview: tmdbResult.overview,
                posterPath: tmdbResult.posterPath ? `https://image.tmdb.org/t/p/w500${tmdbResult.posterPath}` : null,
                backdropPath: tmdbResult.backdropPath ? `https://image.tmdb.org/t/p/w1280${tmdbResult.backdropPath}` : null,
                genres: tmdbResult.genres,
                numberOfSeasons: tmdbResult.numberOfSeasons,
                numberOfEpisodes: tmdbResult.numberOfEpisodes,
                status: tmdbResult.status,
                networks: tmdbResult.networks
            },
            season,
            episode
        };
        
        res.json(result);
    } catch (error) {
        console.error('Error fetching specific episode by TMDB ID:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            tmdbId: req.params.tmdbId,
            season: req.params.season,
            episode: req.params.episode
        });
    }
});

// Search movies on TMDB
app.get('/api/tmdb/search/:query', async (req, res) => {
    try {
        const query = decodeURIComponent(req.params.query);
        const page = parseInt(req.query.page) || 1;
        
        if (!query || query.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Search query is required'
            });
        }
        
        if (!isApiKeyConfigured()) {
            return res.status(500).json({
                success: false,
                error: 'TMDB API key not configured. Please set TMDB_API_KEY environment variable.'
            });
        }
        
        console.log(`Searching TMDB for: ${query} (page ${page})`);
        
        const searchResults = await searchMovies(query, page);
        
        // Format results with movie name construction
        const formattedResults = searchResults.results.map(movie => {
            const releaseYear = movie.release_date ? movie.release_date.split('-')[0] : null;
            const constructedName = releaseYear ? `${movie.title} (${releaseYear})` : movie.title;
            
            return {
                tmdbId: movie.id,
                title: movie.title,
                originalTitle: movie.original_title,
                releaseDate: movie.release_date,
                year: releaseYear,
                overview: movie.overview,
                posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                backdropPath: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                constructedName,
                constructedUrl: `https://a.111477.xyz/movies/${encodeURIComponent(constructedName)}/`,
                popularity: movie.popularity,
                voteAverage: movie.vote_average,
                voteCount: movie.vote_count
            };
        });
        
        res.json({
            success: true,
            query,
            page: searchResults.page,
            totalResults: searchResults.total_results,
            totalPages: searchResults.total_pages,
            results: formattedResults
        });
    } catch (error) {
        console.error('Error searching TMDB:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            query: req.params.query
        });
    }
});

// Parse custom URL
app.post('/api/parse', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL is required in request body'
            });
        }
        
        const normalizedUrl = normalizeUrl(url);
        
        if (!isValidMovieUrl(normalizedUrl)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid movie URL. Must be from 111477.xyz/movies/'
            });
        }
        
        console.log(`Parsing URL: ${normalizedUrl}`);
        
        const html = await fetchHtml(normalizedUrl);
        const result = parseMovieDirectory(html, normalizedUrl);
        
        res.json(result);
    } catch (error) {
        console.error('Error parsing URL:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            url: req.body.url
        });
    }
});

// Get all movie files from multiple URLs
app.post('/api/parse-batch', async (req, res) => {
    try {
        const { urls } = req.body;
        
        if (!urls || !Array.isArray(urls)) {
            return res.status(400).json({
                success: false,
                error: 'URLs array is required in request body'
            });
        }
        
        const results = [];
        
        for (const url of urls) {
            try {
                const normalizedUrl = normalizeUrl(url);
                
                if (!isValidMovieUrl(normalizedUrl)) {
                    results.push({
                        url,
                        success: false,
                        error: 'Invalid movie URL'
                    });
                    continue;
                }
                
                const html = await fetchHtml(normalizedUrl);
                const result = parseMovieDirectory(html, normalizedUrl);
                results.push({
                    url,
                    ...result
                });
            } catch (error) {
                results.push({
                    url,
                    success: false,
                    error: error.message
                });
            }
        }
        
        res.json({
            success: true,
            count: results.length,
            results
        });
    } catch (error) {
        console.error('Error in batch parsing:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Search for movies (future endpoint)
app.get('/api/search/:query', (req, res) => {
    res.status(501).json({
        success: false,
        error: 'Search functionality not implemented yet',
        message: 'This endpoint will be available in future versions'
    });
});

// List popular movies (future endpoint)
app.get('/api/popular', (req, res) => {
    res.status(501).json({
        success: false,
        error: 'Popular movies listing not implemented yet',
        message: 'This endpoint will be available in future versions'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET /health',
            'GET /api/movies/:movieName',
            'GET /api/tmdb/movie/:tmdbId',
            'GET /api/tmdb/tv/:tmdbId',
            'GET /api/tmdb/tv/:tmdbId/season/:season',
            'GET /api/tmdb/tv/:tmdbId/season/:season/episode/:episode',
            'GET /api/tmdb/search/:query',
            'POST /api/parse',
            'POST /api/parse-batch'
        ]
    });
});

// Error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🎬 Movie Parser API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🎯 API Base URL: http://localhost:${PORT}/api`);
    console.log(`📖 Example: http://localhost:${PORT}/api/movies/Zodiac%20(2007)`);
});

module.exports = app;
