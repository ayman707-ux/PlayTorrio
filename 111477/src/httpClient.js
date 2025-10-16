const axios = require('axios');

/**
 * Fetch HTML content from a URL
 * @param {string} url - The URL to fetch
 * @returns {Promise<string>} The HTML content
 */
async function fetchHtml(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 30000, // 30 seconds timeout
            maxRedirects: 5
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            // Server responded with error status
            throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
        } else if (error.request) {
            // Request was made but no response received
            throw new Error('No response received from server');
        } else {
            // Error in request setup
            throw new Error(`Request error: ${error.message}`);
        }
    }
}

/**
 * Build movie URL from movie name
 * @param {string} movieName - The movie name (e.g., "Zodiac (2007)")
 * @returns {string} The full URL to the movie directory
 */
function buildMovieUrl(movieName) {
    const baseUrl = 'https://a.111477.xyz/movies/';
    const encodedMovieName = encodeURIComponent(movieName);
    return `${baseUrl}${encodedMovieName}/`;
}

/**
 * Validate and normalize URL
 * @param {string} url - The URL to validate
 * @returns {string} The normalized URL
 */
function normalizeUrl(url) {
    if (!url) {
        throw new Error('URL is required');
    }
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    
    // Ensure URL ends with /
    if (!url.endsWith('/')) {
        url += '/';
    }
    
    return url;
}

/**
 * Fetch movie data by movie name
 * @param {string} movieName - The name of the movie
 * @returns {Promise<string>} The HTML content
 */
async function fetchMovieByName(movieName) {
    const url = buildMovieUrl(movieName);
    return await fetchHtml(url);
}

/**
 * Test if a URL is accessible
 * @param {string} url - The URL to test
 * @returns {Promise<boolean>} True if URL is accessible
 */
async function testUrl(url) {
    try {
        const response = await axios.head(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

module.exports = {
    fetchHtml,
    fetchMovieByName,
    buildMovieUrl,
    normalizeUrl,
    testUrl
};
