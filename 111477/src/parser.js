const cheerio = require('cheerio');

/**
 * Parse HTML content from a movie directory listing
 * @param {string} html - The HTML content to parse
 * @param {string} baseUrl - The base URL for the directory
 * @returns {Object} Parsed movie data with file links
 */
function parseMovieDirectory(html, baseUrl) {
    const $ = cheerio.load(html);
    const files = [];
    
    // Video file extensions to look for
    const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    
    // Find all table rows with file links
    $('tr').each((index, element) => {
        const link = $(element).find('a').first();
        const href = link.attr('href');
        const fileName = link.text().trim();
        
        // Skip if no href or if it's a parent directory
        if (!href || fileName.includes('Parent Directory') || href === '../') {
            return;
        }
        
        // Check if the file has a video extension
        const hasVideoExtension = videoExtensions.some(ext => 
            fileName.toLowerCase().endsWith(ext)
        );
        
        if (hasVideoExtension) {
            // Get file size from the data-sort attribute
            const sizeCell = $(element).find('td[data-sort]');
            const fileSize = sizeCell.attr('data-sort') || '0';
            
            // Ensure the URL is absolute
            let fileUrl = href;
            if (!href.startsWith('http')) {
                fileUrl = baseUrl.endsWith('/') ? baseUrl + href : baseUrl + '/' + href;
            }
            
            files.push({
                name: fileName,
                url: fileUrl,
                size: fileSize,
                sizeFormatted: formatFileSize(parseInt(fileSize))
            });
        }
    });
    
    // Extract movie name from URL or title
    const movieName = extractMovieName(baseUrl, $);
    
    return {
        success: true,
        movieName,
        baseUrl,
        fileCount: files.length,
        files: files.sort((a, b) => {
            // Sort by file size (largest first) then by name
            const sizeA = parseInt(a.size);
            const sizeB = parseInt(b.size);
            if (sizeA !== sizeB) {
                return sizeB - sizeA;
            }
            return a.name.localeCompare(b.name);
        })
    };
}

/**
 * Parse HTML content from a TV show directory listing
 * @param {string} html - The HTML content to parse
 * @param {string} baseUrl - The base URL for the directory
 * @param {number} filterSeason - Season number to filter (optional)
 * @param {number} filterEpisode - Episode number to filter (optional)
 * @returns {Object} Parsed TV show data with file links
 */
function parseTvDirectory(html, baseUrl, filterSeason = null, filterEpisode = null) {
    const $ = cheerio.load(html);
    const files = [];
    
    // Video file extensions to look for
    const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    
    // Find all table rows with file links
    $('tr').each((index, element) => {
        const link = $(element).find('a').first();
        const href = link.attr('href');
        const fileName = link.text().trim();
        
        // Skip if no href or if it's a parent directory
        if (!href || fileName.includes('Parent Directory') || href === '../') {
            return;
        }
        
        // Check if the file has a video extension
        const hasVideoExtension = videoExtensions.some(ext => 
            fileName.toLowerCase().endsWith(ext)
        );
        
        if (hasVideoExtension) {
            // If filtering by specific episode, check if filename matches pattern
            if (filterSeason !== null && filterEpisode !== null) {
                const episodeInfo = extractEpisodeInfo(fileName);
                
                // Skip if we can't extract episode info or if it doesn't match the filter
                if (!episodeInfo || 
                    episodeInfo.season !== filterSeason || 
                    episodeInfo.episode !== filterEpisode) {
                    return;
                }
            }
            
            // Get file size from the data-sort attribute
            const sizeCell = $(element).find('td[data-sort]');
            const fileSize = sizeCell.attr('data-sort') || '0';
            
            // Ensure the URL is absolute
            let fileUrl = href;
            if (!href.startsWith('http')) {
                fileUrl = baseUrl.endsWith('/') ? baseUrl + href : baseUrl + '/' + href;
            }
            
            // Extract episode info from filename
            const episodeInfo = extractEpisodeInfo(fileName);
            
            files.push({
                name: fileName,
                url: fileUrl,
                size: fileSize,
                sizeFormatted: formatFileSize(parseInt(fileSize)),
                episode: episodeInfo
            });
        }
    });
    
    // Extract TV show name from URL or title
    const tvName = extractTvName(baseUrl, $);
    
    return {
        success: true,
        tvName,
        baseUrl,
        fileCount: files.length,
        filterSeason,
        filterEpisode,
        files: files.sort((a, b) => {
            // Sort by episode info if available, then by file size
            if (a.episode && b.episode) {
                if (a.episode.season !== b.episode.season) {
                    return a.episode.season - b.episode.season;
                }
                if (a.episode.episode !== b.episode.episode) {
                    return a.episode.episode - b.episode.episode;
                }
            }
            
            // Fall back to size sorting
            const sizeA = parseInt(a.size);
            const sizeB = parseInt(b.size);
            if (sizeA !== sizeB) {
                return sizeB - sizeA;
            }
            return a.name.localeCompare(b.name);
        })
    };
}

/**
 * Extract movie name from URL or page content
 * @param {string} url - The URL of the directory
 * @param {Object} $ - Cheerio object
 * @returns {string} The extracted movie name
 */
function extractMovieName(url, $) {
    // Try to get from page title first
    const title = $('title').text();
    if (title && title.includes('Index of')) {
        const match = title.match(/Index of \/movies\/(.+)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }
    
    // Fallback to extracting from URL
    const urlParts = url.split('/');
    const moviePart = urlParts.find(part => part && part !== 'movies');
    
    if (moviePart) {
        return decodeURIComponent(moviePart);
    }
    
    return 'Unknown Movie';
}

/**
 * Extract TV show name from URL or page content
 * @param {string} url - The URL of the directory
 * @param {Object} $ - Cheerio object
 * @returns {string} The extracted TV show name
 */
function extractTvName(url, $) {
    // Try to get from page title first
    const title = $('title').text();
    if (title && title.includes('Index of')) {
        const match = title.match(/Index of \/tvs\/(.+?)(?:\/Season|$)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }
    
    // Fallback to extracting from URL
    const urlParts = url.split('/');
    const tvIndex = urlParts.findIndex(part => part === 'tvs');
    if (tvIndex !== -1 && urlParts[tvIndex + 1]) {
        return decodeURIComponent(urlParts[tvIndex + 1]);
    }
    
    return 'Unknown TV Show';
}

/**
 * Extract episode information from filename
 * @param {string} fileName - The filename to parse
 * @returns {Object|null} Episode info with season and episode numbers
 */
function extractEpisodeInfo(fileName) {
    // Comprehensive list of episode patterns
    const patterns = [
        // Standard formats
        /S(\d{1,2})E(\d{1,2})/i,                    // S01E01, S1E1, S03E22
        /S(\d{1,2})\.E(\d{1,2})/i,                  // S01.E01, S3.E22
        /S(\d{1,2})\s*E(\d{1,2})/i,                 // S01 E01, S3 E22
        /Season\s*(\d+)\s*Episode\s*(\d+)/i,        // Season 1 Episode 1
        /(\d{1,2})x(\d{1,2})/,                      // 1x01, 3x22
        /(\d{1,2})\.(\d{1,2})/,                     // 1.01, 3.22
        
        // Less common but valid formats
        /Ep(\d+).*S(\d+)/i,                         // Ep22 S3 (reversed)
        /Episode\s*(\d+).*Season\s*(\d+)/i,         // Episode 22 Season 3 (reversed)
        /S(\d{1,2})-E(\d{1,2})/i,                   // S01-E01
        /S(\d{1,2})_E(\d{1,2})/i,                   // S01_E01
        /(\d{1,2})-(\d{1,2})/,                      // 1-01, 3-22
        /(\d{1,2})_(\d{1,2})/,                      // 1_01, 3_22
        
        // More flexible patterns (be careful with order)
        /(\d{1,2})\s*[xX]\s*(\d{1,2})/,            // 1 x 01, 3X22
        /S(\d{1,2})[^\dE]*(\d{1,2})/i,              // S03 22, S3-22 (catch-all for S##<separator>##)
    ];
    
    for (const pattern of patterns) {
        const match = fileName.match(pattern);
        if (match) {
            let season, episode;
            
            // Handle patterns where episode and season might be reversed
            if (pattern.source.includes('Ep.*S') || pattern.source.includes('Episode.*Season')) {
                episode = parseInt(match[1]);
                season = parseInt(match[2]);
            } else {
                season = parseInt(match[1]);
                episode = parseInt(match[2]);
            }
            
            // Sanity check: seasons and episodes should be reasonable numbers
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

/**
 * Format file size in human readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Validate if a URL looks like a valid movie directory URL
 * @param {string} url - The URL to validate
 * @returns {boolean} True if URL appears valid
 */
function isValidMovieUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }
    
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('111477.xyz') && 
               urlObj.pathname.includes('/movies/');
    } catch (error) {
        return false;
    }
}

module.exports = {
    parseMovieDirectory,
    parseTvDirectory,
    extractMovieName,
    extractTvName,
    extractEpisodeInfo,
    formatFileSize,
    isValidMovieUrl
};
