const axios = require('axios');
const cheerio = require('cheerio');

// Function to scrape search results
async function scrapeSearchResults(query) {
    try {
        const searchUrl = `https://www.torrentdownload.info/search?q=${encodeURIComponent(query)}`;
        
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const results = [];
        
        // Find all torrent rows
        $('tr').each((index, element) => {
            const $row = $(element);
            const $nameCell = $row.find('td.tdleft');
            
            if ($nameCell.length > 0) {
                const $link = $nameCell.find('.tt-name a');
                const href = $link.attr('href');
                const name = $link.text().trim();
                
                const seeds = $row.find('td.tdseed').text().trim();
                const leech = $row.find('td.tdleech').text().trim();
                
                if (href && name) {
                    results.push({
                        name: name,
                        href: href,
                        seeds: seeds,
                        leech: leech
                    });
                }
            }
        });
        
        return results;
    } catch (error) {
        throw error;
    }
}

// Function to scrape magnet link from detail page
async function scrapeMagnetLink(href) {
    try {
        const detailUrl = `https://www.torrentdownload.info${href}`;
        
        const response = await axios.get(detailUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        
        // Find the magnet link
        const magnetLink = $('a.tosa[href^="magnet:"]').attr('href');
        
        return magnetLink || null;
    } catch (error) {
        return null;
    }
}

// Main search function that can be called from other modules
async function searchTorrentDownload(query) {
    try {
        // Step 1: Get search results
        const searchResults = await scrapeSearchResults(query);
        
        if (searchResults.length === 0) {
            return [];
        }
        
        // Step 2: Get magnet link for each result in parallel for faster execution
        const resultsWithMagnets = await Promise.all(
            searchResults.map(async (result) => {
                const magnetLink = await scrapeMagnetLink(result.href);
                return {
                    title: result.name,
                    magnet: magnetLink,
                    seeds: parseInt(result.seeds.replace(/,/g, ''), 10) || 0,
                    leechers: parseInt(result.leech.replace(/,/g, ''), 10) || 0
                };
            })
        );
        
        // Filter out results without magnet links
        const validResults = resultsWithMagnets.filter(result => result.magnet !== null);
        
        return validResults;
        
    } catch (error) {
        console.error('[TorrentDownload] Search error:', error?.message);
        return [];
    }
}

// Export the main function
module.exports = { searchTorrentDownload };
