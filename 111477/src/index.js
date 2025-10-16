const express = require('express');
const cors = require('cors');
const { parseMovieDirectory, parseTvDirectory, isValidMovieUrl } = require('./parser');
const { fetchHtml, fetchMovieByName, buildMovieUrl, normalizeUrl } = require('./httpClient');
const { getMovieByTmdbId, getTvByTmdbId, isValidTmdbId, isApiKeyConfigured, searchMovies, getMovieNameVariants, getTvNameVariants } = require('./tmdbClient');

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
        
        // Get movie details from TMDB
        const tmdbResult = await getMovieByTmdbId(tmdbId);
        
        // Check if title contains colon for dual search
        const hasColon = tmdbResult.title.includes(':');
        
        if (hasColon) {
            console.log(`Movie "${tmdbResult.title}" contains colon - performing dual content search`);
            
            // Get both name variants
            const nameVariants = getMovieNameVariants(tmdbResult.tmdbData);
            
            // Try both variants and return the one with content, or combine results
            const searchResults = [];
            
            for (let i = 0; i < nameVariants.variants.length; i++) {
                const variantName = nameVariants.variants[i];
                const variantUrl = `https://a.111477.xyz/movies/${encodeURIComponent(variantName)}/`;
                const variantType = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
                
                try {
                    console.log(`Trying variant ${i + 1}: ${variantUrl}`);
                    const html = await fetchHtml(variantUrl);
                    const parseResult = parseMovieDirectory(html, variantUrl);
                    
                    if (parseResult.success && parseResult.files && parseResult.files.length > 0) {
                        console.log(`✅ Found content in variant ${i + 1} (${variantType}): ${parseResult.files.length} files`);
                        
                        searchResults.push({
                            ...parseResult,
                            movieName: variantName,
                            baseUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: true,
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
                        });
                    } else {
                        console.log(`❌ No content found in variant ${i + 1} (${variantType})`);
                        searchResults.push({
                            success: false,
                            movieName: variantName,
                            baseUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: false,
                            message: 'No files found or directory does not exist',
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
                        });
                    }
                } catch (error) {
                    console.log(`❌ Error fetching variant ${i + 1} (${variantType}): ${error.message}`);
                    searchResults.push({
                        success: false,
                        movieName: variantName,
                        baseUrl: variantUrl,
                        searchVariant: variantType,
                        contentFound: false,
                        error: error.message,
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
                    });
                }
            }
            
            // Return combined results
            const foundResults = searchResults.filter(result => result.contentFound);
            
            res.json({
                success: true,
                tmdbId: parseInt(tmdbId),
                dualSearchPerformed: true,
                variantsChecked: searchResults.length,
                variantsWithContent: foundResults.length,
                results: searchResults
            });
            
        } else {
            // Single search for movies without colons (original behavior)
            console.log(`Movie "${tmdbResult.title}" has no colon - single search`);
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
        }
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
        
        // Get TV show details from TMDB
        const tmdbResult = await getTvByTmdbId(tmdbId);
        
        // Check if title contains colon for dual search
        const hasColon = tmdbResult.name.includes(':');
        
        if (hasColon) {
            console.log(`TV show "${tmdbResult.name}" contains colon - showing dual search info`);
            
            // Get both name variants
            const nameVariants = getTvNameVariants(tmdbResult.tmdbData);
            
            // Return TMDB data with dual search info
            const result = {
                success: true,
                tmdbId: parseInt(tmdbId),
                dualSearchCapable: true,
                tvVariants: {
                    colonRemoved: nameVariants.primary,
                    colonToHyphen: nameVariants.secondary
                },
                baseUrls: {
                    colonRemoved: `https://a.111477.xyz/tvs/${encodeURIComponent(nameVariants.primary)}/`,
                    colonToHyphen: `https://a.111477.xyz/tvs/${encodeURIComponent(nameVariants.secondary)}/`
                },
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
                message: `Use /api/tmdb/tv/${tmdbId}/season/1 to get files for a specific season. Both name variants will be checked automatically.`
            };
            
            res.json(result);
        } else {
            // Single search for TV shows without colons (original behavior)
            console.log(`TV show "${tmdbResult.name}" has no colon - single search info`);
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
        }
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
        
        // Get TV show details from TMDB
        const tmdbResult = await getTvByTmdbId(tmdbId, season);
        
        // Check if title contains colon for dual search
        const hasColon = tmdbResult.name.includes(':');
        
        if (hasColon) {
            console.log(`TV show "${tmdbResult.name}" contains colon - performing dual content search for season ${season}`);
            
            // Get both name variants
            const nameVariants = getTvNameVariants(tmdbResult.tmdbData);
            
            // Try both variants and return results
            const searchResults = [];
            
            for (let i = 0; i < nameVariants.variants.length; i++) {
                const variantName = nameVariants.variants[i];
                const variantUrl = `https://a.111477.xyz/tvs/${encodeURIComponent(variantName)}/Season%20${season}/`;
                const variantType = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
                
                try {
                    console.log(`Trying variant ${i + 1}: ${variantUrl}`);
                    const html = await fetchHtml(variantUrl);
                    const parseResult = parseTvDirectory(html, variantUrl, season);
                    
                    if (parseResult.success && parseResult.files && parseResult.files.length > 0) {
                        console.log(`✅ Found content in variant ${i + 1} (${variantType}): ${parseResult.files.length} files`);
                        
                        searchResults.push({
                            ...parseResult,
                            tvName: variantName,
                            baseUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: true,
                            season,
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
                            }
                        });
                    } else {
                        console.log(`❌ No content found in variant ${i + 1} (${variantType})`);
                        searchResults.push({
                            success: false,
                            tvName: variantName,
                            baseUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: false,
                            message: 'No files found or directory does not exist',
                            season,
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
                            }
                        });
                    }
                } catch (error) {
                    console.log(`❌ Error fetching variant ${i + 1} (${variantType}): ${error.message}`);
                    searchResults.push({
                        success: false,
                        tvName: variantName,
                        baseUrl: variantUrl,
                        searchVariant: variantType,
                        contentFound: false,
                        error: error.message,
                        season,
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
                        }
                    });
                }
            }
            
            // Return combined results
            const foundResults = searchResults.filter(result => result.contentFound);
            
            res.json({
                success: true,
                tmdbId: parseInt(tmdbId),
                season,
                dualSearchPerformed: true,
                variantsChecked: searchResults.length,
                variantsWithContent: foundResults.length,
                results: searchResults
            });
            
        } else {
            // Single search for TV shows without colons (original behavior)
            console.log(`TV show "${tmdbResult.name}" has no colon - single search for season ${season}`);
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
        }
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
        
        // Get TV show details from TMDB
        const tmdbResult = await getTvByTmdbId(tmdbId, season);
        
        // Check if title contains colon for dual search
        const hasColon = tmdbResult.name.includes(':');
        
        if (hasColon) {
            console.log(`TV show "${tmdbResult.name}" contains colon - performing dual content search for season ${season}, episode ${episode}`);
            
            // Get both name variants
            const nameVariants = getTvNameVariants(tmdbResult.tmdbData);
            
            // Try both variants and return results
            const searchResults = [];
            
            for (let i = 0; i < nameVariants.variants.length; i++) {
                const variantName = nameVariants.variants[i];
                const variantUrl = `https://a.111477.xyz/tvs/${encodeURIComponent(variantName)}/Season%20${season}/`;
                const variantType = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
                
                try {
                    console.log(`Trying variant ${i + 1} for episode ${episode}: ${variantUrl}`);
                    const html = await fetchHtml(variantUrl);
                    const parseResult = parseTvDirectory(html, variantUrl, season, episode);
                    
                    if (parseResult.success && parseResult.files && parseResult.files.length > 0) {
                        console.log(`✅ Found episode ${episode} in variant ${i + 1} (${variantType}): ${parseResult.files.length} files`);
                        
                        searchResults.push({
                            ...parseResult,
                            tvName: variantName,
                            baseUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: true,
                            season,
                            episode,
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
                            }
                        });
                    } else {
                        console.log(`❌ No episode ${episode} found in variant ${i + 1} (${variantType})`);
                        searchResults.push({
                            success: false,
                            tvName: variantName,
                            baseUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: false,
                            message: `Episode ${episode} not found or directory does not exist`,
                            season,
                            episode,
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
                            }
                        });
                    }
                } catch (error) {
                    console.log(`❌ Error fetching episode ${episode} from variant ${i + 1} (${variantType}): ${error.message}`);
                    searchResults.push({
                        success: false,
                        tvName: variantName,
                        baseUrl: variantUrl,
                        searchVariant: variantType,
                        contentFound: false,
                        error: error.message,
                        season,
                        episode,
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
                        }
                    });
                }
            }
            
            // Return combined results
            const foundResults = searchResults.filter(result => result.contentFound);
            
            res.json({
                success: true,
                tmdbId: parseInt(tmdbId),
                season,
                episode,
                dualSearchPerformed: true,
                variantsChecked: searchResults.length,
                variantsWithContent: foundResults.length,
                results: searchResults
            });
            
        } else {
            // Single search for TV shows without colons (original behavior)
            console.log(`TV show "${tmdbResult.name}" has no colon - single search for season ${season}, episode ${episode}`);
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
        }
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
        
        // Check if query contains colon for dual search
        const hasColon = query.includes(':');
        const allResults = [];
        let totalResults = 0;
        let totalPages = 0;
        
        // First search with original query
        const firstSearchResults = await searchMovies(query, page);
        console.log(`First search (original query) found ${firstSearchResults.results.length} results`);
        
        // Process first search results
        for (const movie of firstSearchResults.results) {
            const releaseYear = movie.release_date ? movie.release_date.split('-')[0] : null;
            const nameVariants = getMovieNameVariants(movie);
            
            // Create base movie object
            const baseMovie = {
                tmdbId: movie.id,
                title: movie.title,
                originalTitle: movie.original_title,
                releaseDate: movie.release_date,
                year: releaseYear,
                overview: movie.overview,
                posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                backdropPath: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                popularity: movie.popularity,
                voteAverage: movie.vote_average,
                voteCount: movie.vote_count,
                searchQuery: query,
                searchType: 'original'
            };
            
            allResults.push({
                ...baseMovie,
                constructedName: nameVariants.primary,
                constructedUrl: `https://a.111477.xyz/movies/${encodeURIComponent(nameVariants.primary)}/`,
                searchVariant: nameVariants.hasVariants ? 'colon_removed' : 'single'
            });
        }
        
        totalResults = firstSearchResults.total_results;
        totalPages = firstSearchResults.total_pages;
        
        // Second search if query contains colon (replace colon with hyphen)
        if (hasColon) {
            const hyphenQuery = query.replace(/:/g, ' -');
            console.log(`Performing second search with hyphen query: ${hyphenQuery}`);
            
            try {
                const secondSearchResults = await searchMovies(hyphenQuery, page);
                console.log(`Second search (hyphen query) found ${secondSearchResults.results.length} results`);
                
                // Process second search results
                for (const movie of secondSearchResults.results) {
                    // Check if this movie is already in results (avoid duplicates)
                    const isDuplicate = allResults.some(existing => existing.tmdbId === movie.id);
                    
                    if (!isDuplicate) {
                        const releaseYear = movie.release_date ? movie.release_date.split('-')[0] : null;
                        const nameVariants = getMovieNameVariants(movie);
                        
                        const baseMovie = {
                            tmdbId: movie.id,
                            title: movie.title,
                            originalTitle: movie.original_title,
                            releaseDate: movie.release_date,
                            year: releaseYear,
                            overview: movie.overview,
                            posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                            backdropPath: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                            popularity: movie.popularity,
                            voteAverage: movie.vote_average,
                            voteCount: movie.vote_count,
                            searchQuery: hyphenQuery,
                            searchType: 'hyphen_variant'
                        };
                        
                        allResults.push({
                            ...baseMovie,
                            constructedName: nameVariants.hasVariants ? nameVariants.secondary : nameVariants.primary,
                            constructedUrl: `https://a.111477.xyz/movies/${encodeURIComponent(nameVariants.hasVariants ? nameVariants.secondary : nameVariants.primary)}/`,
                            searchVariant: nameVariants.hasVariants ? 'colon_to_hyphen' : 'single'
                        });
                    }
                }
                
                // Update totals to include both searches
                totalResults += secondSearchResults.total_results;
            } catch (secondSearchError) {
                console.error('Error in second search:', secondSearchError.message);
                // Continue with first search results only
            }
        }
        
        res.json({
            success: true,
            query,
            page: firstSearchResults.page,
            totalResults: totalResults,
            totalPages: totalPages,
            originalResultCount: firstSearchResults.results.length,
            expandedResultCount: allResults.length,
            dualSearchPerformed: hasColon,
            results: allResults
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

// Search movies on TMDB with content fetching (dual search for movies with colons)
app.get('/api/tmdb/search/:query/fetch', async (req, res) => {
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
        
        console.log(`Searching TMDB with content fetching for: ${query} (page ${page})`);
        
        // Check if query contains colon for dual search
        const hasColon = query.includes(':');
        const allResults = [];
        let totalResults = 0;
        let totalPages = 0;
        
        // Collect all movies from both searches
        const allMovies = [];
        
        // First search with original query
        const firstSearchResults = await searchMovies(query, page);
        console.log(`First search (original query) found ${firstSearchResults.results.length} results`);
        
        // Add movies from first search
        firstSearchResults.results.forEach(movie => {
            allMovies.push({
                ...movie,
                searchQuery: query,
                searchType: 'original'
            });
        });
        
        totalResults = firstSearchResults.total_results;
        totalPages = firstSearchResults.total_pages;
        
        // Second search if query contains colon (replace colon with hyphen)
        if (hasColon) {
            const hyphenQuery = query.replace(/:/g, ' -');
            console.log(`Performing second search with hyphen query: ${hyphenQuery}`);
            
            try {
                const secondSearchResults = await searchMovies(hyphenQuery, page);
                console.log(`Second search (hyphen query) found ${secondSearchResults.results.length} results`);
                
                // Add movies from second search (avoid duplicates)
                secondSearchResults.results.forEach(movie => {
                    const isDuplicate = allMovies.some(existing => existing.id === movie.id);
                    if (!isDuplicate) {
                        allMovies.push({
                            ...movie,
                            searchQuery: hyphenQuery,
                            searchType: 'hyphen_variant'
                        });
                    }
                });
                
                totalResults += secondSearchResults.total_results;
            } catch (secondSearchError) {
                console.error('Error in second search:', secondSearchError.message);
            }
        }
        
        // Process all movies and fetch content
        for (const movie of allMovies) {
            const releaseYear = movie.release_date ? movie.release_date.split('-')[0] : null;
            const nameVariants = getMovieNameVariants(movie);
            
            // Create base movie object
            const baseMovie = {
                tmdbId: movie.id,
                title: movie.title,
                originalTitle: movie.original_title,
                releaseDate: movie.release_date,
                year: releaseYear,
                overview: movie.overview,
                posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                backdropPath: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                popularity: movie.popularity,
                voteAverage: movie.vote_average,
                voteCount: movie.vote_count,
                searchQuery: movie.searchQuery,
                searchType: movie.searchType
            };
            
            if (nameVariants.hasVariants) {
                // For movies with colons, fetch content for both variants
                console.log(`Movie "${movie.title}" has colon - fetching content for both variants`);
                
                for (let i = 0; i < nameVariants.variants.length; i++) {
                    const variantName = nameVariants.variants[i];
                    const variantUrl = `https://a.111477.xyz/movies/${encodeURIComponent(variantName)}/`;
                    const variantType = i === 0 ? 'colon_removed' : 'colon_to_hyphen';
                    
                    try {
                        console.log(`Fetching content from: ${variantUrl}`);
                        const html = await fetchHtml(variantUrl);
                        const parseResult = parseMovieDirectory(html, variantUrl);
                        
                        if (parseResult.success && parseResult.files && parseResult.files.length > 0) {
                            // Found content for this variant
                            allResults.push({
                                ...baseMovie,
                                constructedName: variantName,
                                constructedUrl: variantUrl,
                                searchVariant: variantType,
                                contentFound: true,
                                files: parseResult.files,
                                fileCount: parseResult.files.length
                            });
                        } else {
                            // No content found for this variant
                            allResults.push({
                                ...baseMovie,
                                constructedName: variantName,
                                constructedUrl: variantUrl,
                                searchVariant: variantType,
                                contentFound: false,
                                message: 'No files found or directory does not exist'
                            });
                        }
                    } catch (error) {
                        // Error fetching this variant
                        allResults.push({
                            ...baseMovie,
                            constructedName: variantName,
                            constructedUrl: variantUrl,
                            searchVariant: variantType,
                            contentFound: false,
                            error: error.message
                        });
                    }
                }
            } else {
                // For movies without colons, fetch single variant
                const variantName = nameVariants.primary;
                const variantUrl = `https://a.111477.xyz/movies/${encodeURIComponent(variantName)}/`;
                
                try {
                    console.log(`Fetching content from: ${variantUrl}`);
                    const html = await fetchHtml(variantUrl);
                    const parseResult = parseMovieDirectory(html, variantUrl);
                    
                    if (parseResult.success && parseResult.files && parseResult.files.length > 0) {
                        allResults.push({
                            ...baseMovie,
                            constructedName: variantName,
                            constructedUrl: variantUrl,
                            searchVariant: 'single',
                            contentFound: true,
                            files: parseResult.files,
                            fileCount: parseResult.files.length
                        });
                    } else {
                        allResults.push({
                            ...baseMovie,
                            constructedName: variantName,
                            constructedUrl: variantUrl,
                            searchVariant: 'single',
                            contentFound: false,
                            message: 'No files found or directory does not exist'
                        });
                    }
                } catch (error) {
                    allResults.push({
                        ...baseMovie,
                        constructedName: variantName,
                        constructedUrl: variantUrl,
                        searchVariant: 'single',
                        contentFound: false,
                        error: error.message
                    });
                }
            }
        }
        
        const foundResults = allResults.filter(result => result.contentFound);
        
        res.json({
            success: true,
            query,
            page: firstSearchResults.page,
            totalResults: totalResults,
            totalPages: totalPages,
            originalMovieCount: allMovies.length,
            expandedResultCount: allResults.length,
            foundContentCount: foundResults.length,
            dualSearchPerformed: hasColon,
            results: allResults
        });
    } catch (error) {
        console.error('Error searching TMDB with content fetching:', error.message);
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
            'GET /api/tmdb/search/:query/fetch',
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
