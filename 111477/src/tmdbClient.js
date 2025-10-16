const axios = require('axios');

// TMDB API configuration
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'b3556f3b206e16f82df4d1f6fd4545e6'; // You'll need to get this from TMDB

/**
 * Get movie details from TMDB by movie ID
 * @param {number|string} tmdbId - The TMDB movie ID
 * @returns {Promise<Object>} Movie details from TMDB
 */
async function getMovieDetails(tmdbId) {
    try {
        const response = await axios.get(`${TMDB_BASE_URL}/movie/${tmdbId}`, {
            params: {
                api_key: TMDB_API_KEY,
                language: 'en-US'
            },
            timeout: 10000
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            if (error.response.status === 404) {
                throw new Error(`Movie with TMDB ID ${tmdbId} not found`);
            } else if (error.response.status === 401) {
                throw new Error('Invalid TMDB API key. Please set a valid API key.');
            } else {
                throw new Error(`TMDB API error: ${error.response.status} - ${error.response.statusText}`);
            }
        } else {
            throw new Error(`Network error while fetching TMDB data: ${error.message}`);
        }
    }
}

/**
 * Get TV show details from TMDB by TV show ID
 * @param {number|string} tmdbId - The TMDB TV show ID
 * @returns {Promise<Object>} TV show details from TMDB
 */
async function getTvDetails(tmdbId) {
    try {
        const response = await axios.get(`${TMDB_BASE_URL}/tv/${tmdbId}`, {
            params: {
                api_key: TMDB_API_KEY,
                language: 'en-US'
            },
            timeout: 10000
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            if (error.response.status === 404) {
                throw new Error(`TV show with TMDB ID ${tmdbId} not found`);
            } else if (error.response.status === 401) {
                throw new Error('Invalid TMDB API key. Please set a valid API key.');
            } else {
                throw new Error(`TMDB API error: ${error.response.status} - ${error.response.statusText}`);
            }
        } else {
            throw new Error(`Network error while fetching TMDB data: ${error.message}`);
        }
    }
}

/**
 * Search for movies on TMDB by query
 * @param {string} query - Search query
 * @param {number} page - Page number (default: 1)
 * @returns {Promise<Object>} Search results from TMDB
 */
async function searchMovies(query, page = 1) {
    try {
        const response = await axios.get(`${TMDB_BASE_URL}/search/movie`, {
            params: {
                api_key: TMDB_API_KEY,
                language: 'en-US',
                query: query,
                page: page,
                include_adult: false
            },
            timeout: 10000
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            throw new Error(`TMDB API error: ${error.response.status} - ${error.response.statusText}`);
        } else {
            throw new Error(`Network error while searching TMDB: ${error.message}`);
        }
    }
}

/**
 * Construct movie directory name from TMDB movie data
 * @param {Object} movieData - TMDB movie data
 * @returns {string} Formatted movie name for directory (e.g., "Zodiac (2007)")
 */
function constructMovieName(movieData) {
    const title = movieData.title || movieData.original_title || 'Unknown Movie';
    const releaseDate = movieData.release_date;
    
    // Remove colons from the title for 111477 compatibility
    const cleanTitle = title.replace(/:/g, '');
    
    if (!releaseDate) {
        return cleanTitle;
    }
    
    // Extract year from release date (YYYY-MM-DD format)
    const year = releaseDate.split('-')[0];
    return `${cleanTitle} (${year})`;
}

/**
 * Construct movie directory name with colons replaced by hyphens
 * @param {Object} movieData - TMDB movie data
 * @returns {string} Formatted movie name for directory with hyphens (e.g., "Spider-Man - No Way Home (2021)")
 */
function constructMovieNameWithHyphens(movieData) {
    const title = movieData.title || movieData.original_title || 'Unknown Movie';
    const releaseDate = movieData.release_date;
    
    // Replace colons with hyphens for 111477 compatibility
    const hyphenTitle = title.replace(/:/g, ' -');
    
    if (!releaseDate) {
        return hyphenTitle;
    }
    
    // Extract year from release date (YYYY-MM-DD format)
    const year = releaseDate.split('-')[0];
    return `${hyphenTitle} (${year})`;
}

/**
 * Get both possible movie names (colon removed and colon replaced with hyphen)
 * @param {Object} movieData - TMDB movie data
 * @returns {Object} Object with both name variants
 */
function getMovieNameVariants(movieData) {
    const title = movieData.title || movieData.original_title || 'Unknown Movie';
    const hasColon = title.includes(':');
    
    if (!hasColon) {
        // If no colon, return single variant
        const singleName = constructMovieName(movieData);
        return {
            hasVariants: false,
            primary: singleName,
            variants: [singleName]
        };
    }
    
    // If has colon, return both variants
    const colonRemoved = constructMovieName(movieData);
    const colonToHyphen = constructMovieNameWithHyphens(movieData);
    
    return {
        hasVariants: true,
        primary: colonRemoved,
        secondary: colonToHyphen,
        variants: [colonRemoved, colonToHyphen]
    };
}

/**
 * Construct TV show directory name from TMDB TV data
 * @param {Object} tvData - TMDB TV show data
 * @returns {string} Formatted TV show name for directory (e.g., "The 100")
 */
function constructTvName(tvData) {
    const title = tvData.name || tvData.original_name || 'Unknown TV Show';
    // Remove colons from the title for 111477 compatibility
    return title.replace(/:/g, '');
}

/**
 * Construct TV show directory name with colons replaced by hyphens
 * @param {Object} tvData - TMDB TV show data
 * @returns {string} Formatted TV show name for directory with hyphens
 */
function constructTvNameWithHyphens(tvData) {
    const title = tvData.name || tvData.original_name || 'Unknown TV Show';
    // Replace colons with hyphens for 111477 compatibility
    return title.replace(/:/g, ' -');
}

/**
 * Get both possible TV show names (colon removed and colon replaced with hyphen)
 * @param {Object} tvData - TMDB TV show data
 * @returns {Object} Object with both name variants
 */
function getTvNameVariants(tvData) {
    const title = tvData.name || tvData.original_name || 'Unknown TV Show';
    const hasColon = title.includes(':');
    
    if (!hasColon) {
        // If no colon, return single variant
        const singleName = constructTvName(tvData);
        return {
            hasVariants: false,
            primary: singleName,
            variants: [singleName]
        };
    }
    
    // If has colon, return both variants
    const colonRemoved = constructTvName(tvData);
    const colonToHyphen = constructTvNameWithHyphens(tvData);
    
    return {
        hasVariants: true,
        primary: colonRemoved,
        secondary: colonToHyphen,
        variants: [colonRemoved, colonToHyphen]
    };
}

/**
 * Get movie URL format for the 111477.xyz site from TMDB data
 * @param {Object} movieData - TMDB movie data
 * @returns {string} The constructed movie URL
 */
function constructMovieUrl(movieData) {
    const movieName = constructMovieName(movieData);
    const baseUrl = 'https://a.111477.xyz/movies/';
    const encodedMovieName = encodeURIComponent(movieName);
    return `${baseUrl}${encodedMovieName}/`;
}

/**
 * Get TV show URL format for the 111477.xyz site from TMDB data
 * @param {Object} tvData - TMDB TV show data
 * @param {number} season - Season number (optional)
 * @returns {string} The constructed TV show URL
 */
function constructTvUrl(tvData, season = null) {
    const tvName = constructTvName(tvData);
    const baseUrl = 'https://a.111477.xyz/tvs/';
    const encodedTvName = encodeURIComponent(tvName);
    
    if (season !== null) {
        return `${baseUrl}${encodedTvName}/Season%20${season}/`;
    }
    
    return `${baseUrl}${encodedTvName}/`;
}

/**
 * Get movie details by TMDB ID and construct the corresponding 111477.xyz URL
 * @param {number|string} tmdbId - The TMDB movie ID
 * @returns {Promise<Object>} Object containing TMDB data and constructed URL
 */
async function getMovieByTmdbId(tmdbId) {
    const movieData = await getMovieDetails(tmdbId);
    const movieName = constructMovieName(movieData);
    const movieUrl = constructMovieUrl(movieData);
    
    return {
        tmdbId: parseInt(tmdbId),
        tmdbData: movieData,
        movieName,
        movieUrl,
        title: movieData.title,
        originalTitle: movieData.original_title,
        releaseDate: movieData.release_date,
        year: movieData.release_date ? movieData.release_date.split('-')[0] : null,
        overview: movieData.overview,
        posterPath: movieData.poster_path,
        backdropPath: movieData.backdrop_path,
        genres: movieData.genres,
        runtime: movieData.runtime,
        imdbId: movieData.imdb_id
    };
}

/**
 * Get TV show details by TMDB ID and construct the corresponding 111477.xyz URL
 * @param {number|string} tmdbId - The TMDB TV show ID
 * @param {number} season - Season number (optional)
 * @returns {Promise<Object>} Object containing TMDB data and constructed URL
 */
async function getTvByTmdbId(tmdbId, season = null) {
    const tvData = await getTvDetails(tmdbId);
    const tvName = constructTvName(tvData);
    const tvUrl = constructTvUrl(tvData, season);
    
    return {
        tmdbId: parseInt(tmdbId),
        tmdbData: tvData,
        tvName,
        tvUrl,
        name: tvData.name,
        originalName: tvData.original_name,
        firstAirDate: tvData.first_air_date,
        lastAirDate: tvData.last_air_date,
        year: tvData.first_air_date ? tvData.first_air_date.split('-')[0] : null,
        overview: tvData.overview,
        posterPath: tvData.poster_path,
        backdropPath: tvData.backdrop_path,
        genres: tvData.genres,
        numberOfSeasons: tvData.number_of_seasons,
        numberOfEpisodes: tvData.number_of_episodes,
        status: tvData.status,
        networks: tvData.networks,
        season: season
    };
}

/**
 * Validate TMDB ID
 * @param {any} tmdbId - The TMDB ID to validate
 * @returns {boolean} True if valid
 */
function isValidTmdbId(tmdbId) {
    const id = parseInt(tmdbId);
    return !isNaN(id) && id > 0;
}

/**
 * Check if TMDB API key is configured
 * @returns {boolean} True if API key is set and not the placeholder
 */
function isApiKeyConfigured() {
    return TMDB_API_KEY && TMDB_API_KEY !== 'YOUR_TMDB_API_KEY_HERE';
}

module.exports = {
    getMovieDetails,
    getTvDetails,
    searchMovies,
    constructMovieName,
    constructMovieNameWithHyphens,
    getMovieNameVariants,
    constructTvName,
    constructTvNameWithHyphens,
    getTvNameVariants,
    constructMovieUrl,
    constructTvUrl,
    getMovieByTmdbId,
    getTvByTmdbId,
    isValidTmdbId,
    isApiKeyConfigured,
    TMDB_BASE_URL
};
