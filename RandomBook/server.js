const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Z-Library configuration for cover search
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

const ZLIB_DOMAINS = [
    'z-lib.gd',        // Primary
    'z-library.sk',    // Fallback 1
    'z-lib.fm',        // Fallback 2
    'z-lib.io',
    'z-lib.se', 
    'zlibrary.to',
    'singlelogin.re',
    'z-library.se'
];

// Helper function to get random user agent
function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Helper function to create axios instance with proper headers for Z-Library
function createZLibAxiosInstance() {
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

// Function to search Z-Library directly for cover URLs by matching both book title and author
async function getCoverByAuthor(authorName, bookTitle = '') {
    try {
        // Handle author being an array - extract the first author name
        let searchAuthor = authorName;
        if (Array.isArray(authorName)) {
            searchAuthor = authorName[0] || '';
        }
        
        if (!searchAuthor || searchAuthor.trim() === '') {
            console.log(`❌ No valid author name provided`);
            return null;
        }

        if (!bookTitle || bookTitle.trim() === '') {
            console.log(`❌ No valid book title provided`);
            return null;
        }
        
        console.log(`🔍 Searching Z-Library for: "${bookTitle}" by "${searchAuthor}"`);
        
        let searchResults = null;
        let workingDomain = null;

        // Try each Z-Library domain until one works
        for (const domain of ZLIB_DOMAINS) {
            try {
                console.log(`📚 Trying Z-Library domain: ${domain}`);
                
                const axiosInstance = createZLibAxiosInstance();
                // Search by book title for better results
                const searchUrl = `https://${domain}/s/${encodeURIComponent(bookTitle)}`;
                
                const response = await axiosInstance.get(searchUrl);
                
                if (response.status === 200 && response.data) {
                    searchResults = response.data;
                    workingDomain = domain;
                    console.log(`✅ Successfully connected to Z-Library: ${domain}`);
                    break;
                }
            } catch (error) {
                console.log(`❌ Failed to connect to ${domain}: ${error.message}`);
                continue;
            }
        }

        if (!searchResults) {
            console.log(`� Unable to connect to any Z-Library servers`);
            return null;
        }

        // Parse the HTML
        const $ = cheerio.load(searchResults);
        
        // Try multiple selectors for book results
        let bookElements = [];
        const selectors = [
            '.book-item',            // Most common current selector
            '.resItemBox',           // Legacy selector
            '.bookRow',              // Alternative layout
            '.result-item',          // Generic result
            '[itemtype*="Book"]',    // Schema.org markup
            'table tr',              // Table layout
            '.bookBox',              // Box layout
            'div[id*="book"]',       // Any div with "book" in ID
            '.booklist .book',       // Booklist layout
            '.search-item',          // Search item container
            'a[href*="/book/"]'      // Any link to a book page (fallback)
        ];
        
        for (const selector of selectors) {
            bookElements = $(selector);
            if (bookElements.length > 0) {
                // If we found links but no container elements, get their parents
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
            console.log(`❌ No book elements found on Z-Library page`);
            return null;
        }

        console.log(`📖 Found ${bookElements.length} book elements on Z-Library`);

        // Extract covers, titles and authors from the first few results
        const covers = [];
        bookElements.each((index, element) => {
            if (index >= 10) return false; // Limit to 10 results
            
            const $book = $(element);
            let coverUrl = null;
            let author = 'Unknown';
            let title = 'Unknown';
            
            // Strategy 1: Check for Z-Library web component (z-bookcard)
            const zbookcard = $book.find('z-bookcard').first();
            if (zbookcard.length) {
                const imgElement = zbookcard.find('img').first();
                if (imgElement.length) {
                    coverUrl = imgElement.attr('data-src') || imgElement.attr('src');
                }
                
                // Extract author from slot
                author = zbookcard.find('[slot="author"]').text().trim() || 
                        zbookcard.find('div[slot="author"]').text().trim() || 'Unknown';
                
                // Extract title from slot
                title = zbookcard.find('[slot="title"]').text().trim() || 
                       zbookcard.find('div[slot="title"]').text().trim() || 'Unknown';
            }
            
            // Strategy 2: Extract cover image, author and title from traditional HTML structure
            if (!coverUrl) {
                const coverSelectors = [
                    'img[data-src]',           // Z-Library uses data-src for lazy loading
                    'img[src*="cover"]',       // Images with cover in URL
                    '.itemCover img',          // Cover in item cover class
                    '.book-cover img',         // Book cover class
                    '.cover img',              // Generic cover class
                    'img[alt*="cover"]',       // Alt text mentions cover
                    'img[alt*="book"]',        // Alt text mentions book
                    'img'                      // Any image (as fallback)
                ];
                
                for (const selector of coverSelectors) {
                    const coverElement = $book.find(selector).first();
                    if (coverElement.length) {
                        const src = coverElement.attr('data-src') || coverElement.attr('src');
                        if (src && !src.includes('placeholder') && !src.includes('icon') && !src.includes('default')) {
                            coverUrl = src;
                            break;
                        }
                    }
                }
            }
            
            // Extract title if not found in z-bookcard
            if (title === 'Unknown') {
                const titleSelectors = [
                    'h3 a',                    // Title in h3 link
                    '.title a',                // Title in title class
                    '.book-title a',           // Book title class
                    '[class*="title"] a',      // Any class containing "title"
                    'a[href*="/book/"]',       // Link to book page
                    'h1, h2, h3, h4',          // Any heading
                    '.itemTitle',              // Item title class
                    '[itemprop="name"]'        // Schema.org name
                ];
                
                for (const selector of titleSelectors) {
                    const titleElement = $book.find(selector).first();
                    if (titleElement.length && titleElement.text().trim()) {
                        const titleText = titleElement.text().trim();
                        // Avoid very long text and common non-title text
                        if (titleText.length < 200 && 
                            !titleText.toLowerCase().includes('download') && 
                            !titleText.toLowerCase().includes('read online')) {
                            title = titleText;
                            break;
                        }
                    }
                }
            }
            
            // Extract author if not found in z-bookcard
            if (author === 'Unknown') {
                const authorSelectors = [
                    '.authors a',              // Authors link
                    '.author a',               // Author link
                    '[class*="author"]',       // Any class containing "author"
                    '.bookAuthor',             // Book author class
                    '.book-author',            // Book author with dash
                    'a[href*="/author/"]',     // Author page links
                    '.writer',                 // Writer class
                    'i',                       // Italics (often used for authors)
                    'em'                       // Emphasis (sometimes authors)
                ];
                
                for (const selector of authorSelectors) {
                    const authorElement = $book.find(selector).first();
                    if (authorElement.length && authorElement.text().trim()) {
                        const authorText = authorElement.text().trim();
                        // Avoid very long text (likely not just author name)
                        if (authorText.length < 100 && !authorText.toLowerCase().includes('download')) {
                            author = authorText;
                            break;
                        }
                    }
                }
                
                // Look for text patterns like "by AuthorName"
                if (author === 'Unknown') {
                    const fullText = $book.text().replace(/\s+/g, ' ').trim();
                    const byMatch = fullText.match(/by\s+([^,\n\r\|]+)/i);
                    if (byMatch && byMatch[1].trim().length > 2) {
                        author = byMatch[1].trim().split(/[,\n\r\|]/)[0].trim();
                    }
                }
            }
            
            // Make cover URL absolute if needed
            if (coverUrl && coverUrl.startsWith('/')) {
                coverUrl = `https://${workingDomain}${coverUrl}`;
            }
            
            // Only add if we found a cover URL
            if (coverUrl) {
                covers.push({
                    coverUrl: coverUrl,
                    author: author.replace(/\s+/g, ' ').trim(),
                    title: title.replace(/\s+/g, ' ').trim()
                });
                console.log(`📚 Found Z-Library book ${index + 1}: "${title}" by ${author} - ${coverUrl}`);
            }
        });

        if (covers.length === 0) {
            console.log(`❌ No covers found on Z-Library for "${bookTitle}" by "${searchAuthor}"`);
            return null;
        }

        console.log(`📖 Found ${covers.length} covers, matching against: "${bookTitle}" by "${searchAuthor}"`);

        // Helper function to normalize text for comparison
        const normalize = (text) => text.toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');

        // Now match both title and author from server.js with Z-Library results
        // First, try to find exact match for both title and author
        const exactMatch = covers.find(book => {
            const titleMatch = book.title && bookTitle && 
                normalize(book.title) === normalize(bookTitle);
            const authorMatch = book.author && searchAuthor && 
                normalize(book.author) === normalize(searchAuthor);
            return titleMatch && authorMatch;
        });
        
        if (exactMatch) {
            console.log(`✅ Found exact title+author match: "${exactMatch.title}" by "${exactMatch.author}" -> ${exactMatch.coverUrl}`);
            return exactMatch.coverUrl;
        }
        
        // If no exact match, try partial match for both title and author
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
            console.log(`📚 Found partial title+author match: "${partialMatch.title}" by "${partialMatch.author}" -> ${partialMatch.coverUrl}`);
            return partialMatch.coverUrl;
        }
        
        // If still no match, try title-only match with strong author similarity
        const titleOnlyMatch = covers.find(book => {
            if (!book.title || !book.author || !bookTitle || !searchAuthor) return false;
            
            const zlibTitle = normalize(book.title);
            const zlibAuthor = normalize(book.author);
            const libgenTitle = normalize(bookTitle);
            const libgenAuthor = normalize(searchAuthor);
            
            const titleMatch = zlibTitle.includes(libgenTitle) || libgenTitle.includes(zlibTitle);
            // More lenient author match (just check if key words match)
            const authorWords = libgenAuthor.split(' ').filter(word => word.length > 2);
            const authorSimilarity = authorWords.some(word => zlibAuthor.includes(word));
            
            return titleMatch && authorSimilarity;
        });
        
        if (titleOnlyMatch) {
            console.log(`📖 Found title match with author similarity: "${titleOnlyMatch.title}" by "${titleOnlyMatch.author}" -> ${titleOnlyMatch.coverUrl}`);
            return titleOnlyMatch.coverUrl;
        }
        
        console.log(`❌ No title+author match found for "${bookTitle}" by "${searchAuthor}" in Z-Library results`);
        
        // Log all found books for debugging
        covers.forEach((book, index) => {
            console.log(`  ${index + 1}. Z-Library: "${book.title}" by "${book.author}"`);
        });
        
        return null;
        
    } catch (error) {
        console.error(`💥 Error searching Z-Library for author "${authorName}":`, error.message);
        return null;
    }
}

// Function to get the download link - just return the libgen.download API link
async function getActualDownloadLink(bookId) {
    const downloadPageUrl = `https://libgen.download/api/download?id=${bookId}`;
    console.log(`Returning download link: ${downloadPageUrl}`);
    return downloadPageUrl;
}

// Function to process download links in parallel with concurrency limit and cover matching
async function getDownloadLinksInParallel(books, concurrency = 3) {
    const results = [];
    
    // Process books in chunks to limit concurrent requests
    for (let i = 0; i < books.length; i += concurrency) {
        const chunk = books.slice(i, i + concurrency);
        
        console.log(`Processing books ${i + 1}-${Math.min(i + concurrency, books.length)} of ${books.length}...`);
        
        // Process this chunk in parallel
        const chunkPromises = chunk.map(async (book) => {
            // Handle author being an array - extract the first author for display
            const authorForDisplay = Array.isArray(book.author) ? book.author[0] || 'Unknown' : book.author || 'Unknown';
            
            console.log(`🔄 Processing book: "${book.title}" by ${authorForDisplay}`);
            
            const actualDownloadLink = await getActualDownloadLink(book.id);
            
            // Try to get cover URL by matching both title and author
            console.log(`🖼️ Attempting to get cover for: "${book.title}" by ${JSON.stringify(book.author)}`);
            const coverUrl = await getCoverByAuthor(book.author, book.title);
            console.log(`🖼️ Cover result for "${book.title}": ${coverUrl ? 'FOUND' : 'NOT FOUND'}`);
            
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
            
            // Only add coverUrl if we found one
            if (coverUrl) {
                result.coverUrl = coverUrl;
                console.log(`✅ Added cover to result for "${book.title}": ${coverUrl}`);
            } else {
                console.log(`❌ No cover added for "${book.title}"`);
            }
            
            return result;
        });
        
        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
    }
    
    return results;
}

// API endpoint for searching books
app.get('/api/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        
        // Encode the query for URL
        const encodedQuery = encodeURIComponent(query);
        
        // API URL with the search query
        const apiUrl = `https://randombook.org/api/search/by-params?query=${encodedQuery}&collection=libgen&from=0`;
        
        console.log(`Fetching data from: ${apiUrl}`);
        
        // Fetch data from the external API
        const response = await axios.get(apiUrl);
        
        // Check if we have valid data
        if (!response.data || !response.data.result || !response.data.result.books) {
            return res.status(404).json({
                success: false,
                message: 'No books found for the given query'
            });
        }
        
        const books = response.data.result.books;
        
        // Limit to first 50 books, or all if fewer than 50 available
        const limitedBooks = books.slice(0, 15);
        
        // Transform the data to include actual download links using parallel processing
        const transformedBooks = await getDownloadLinksInParallel(limitedBooks, 3);
        
        // Sort books: ones with cover URLs first, then ones without covers
        const sortedBooks = transformedBooks.sort((a, b) => {
            // Books with coverUrl come first (return -1 for a, 1 for b)
            // Books without coverUrl come second
            const aHasCover = a.coverUrl ? 1 : 0;
            const bHasCover = b.coverUrl ? 1 : 0;
            
            // Sort in descending order (books with covers first)
            return bHasCover - aHasCover;
        });
        
        console.log(`📚 Sorted ${sortedBooks.length} books: ${sortedBooks.filter(b => b.coverUrl).length} with covers, ${sortedBooks.filter(b => !b.coverUrl).length} without covers`);
        
        // Return the formatted response
        res.json({
            success: true,
            query: query,
            totalBooks: sortedBooks.length,
            books: sortedBooks
        });
        
    } catch (error) {
        console.error('Error fetching data:', error.message);
        
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            return res.status(error.response.status).json({
                success: false,
                message: 'External API error',
                error: error.response.data || error.message
            });
        } else if (error.request) {
            // The request was made but no response was received
            return res.status(500).json({
                success: false,
                message: 'No response from external API',
                error: error.message
            });
        } else {
            // Something happened in setting up the request that triggered an Error
            return res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    }
});

// Endpoint to get download link for a specific book ID
app.get('/api/download/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`Getting download link for book ID: ${id}`);
        
        const downloadLink = await getActualDownloadLink(id);
        
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
        console.error('Error getting download link:', error.message);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'RandomBook Scraper API is running',
        timestamp: new Date().toISOString()
    });
});

// Default route
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Welcome to RandomBook Scraper API',
        endpoints: {
            search: '/api/search/{query}',
            download: '/api/download/{bookId}',
            health: '/health'
        },
        examples: {
            search: '/api/search/The midnight library',
            download: '/api/download/98593300'
        }
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 RandomBook Scraper API is running on http://localhost:${PORT}`);
    console.log(`📚 Try searching: http://localhost:${PORT}/api/search/The midnight library`);
});

module.exports = app;
