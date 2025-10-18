const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3004;

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(limiter);

// User agents for rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

// Z-Library domains to try
const ZLIB_DOMAINS = [
    'z-lib.gd',
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

// Helper function to create axios instance with proper headers
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

// Test endpoint
app.get('/test', (req, res) => {
    res.json({ message: 'Z-Library Book Search API is running!', timestamp: new Date().toISOString() });
});

// Helper function to get read link for a book
async function getReadLink(bookUrl, workingDomain) {
    try {
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get(bookUrl);
        
        if (response.status !== 200) {
            return null;
        }

        const $ = cheerio.load(response.data);
        
        // Find read online button with multiple strategies
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
        
        // Make URL absolute if needed
        if (readerUrl && readerUrl.startsWith('/')) {
            readerUrl = `https://${workingDomain}${readerUrl}`;
        }
        
        return readerUrl;
    } catch (error) {
        console.error('Error getting read link:', error.message);
        return null;
    }
}

// Main search endpoint
app.get('/search/:query', async (req, res) => {
    const query = req.params.query;
    
    if (!query || query.trim().length === 0) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    console.log(`Searching for: ${query}`);

    try {
        let searchResults = null;
        let workingDomain = null;

        // Try each domain until one works
        for (const domain of ZLIB_DOMAINS) {
            try {
                console.log(`Trying domain: ${domain}`);
                
                const axiosInstance = createAxiosInstance();
                const searchUrl = `https://${domain}/s/${encodeURIComponent(query)}`;
                
                const response = await axiosInstance.get(searchUrl);
                
                if (response.status === 200 && response.data) {
                    searchResults = response.data;
                    workingDomain = domain;
                    console.log(`Successfully connected to: ${domain}`);
                    break;
                }
            } catch (error) {
                console.log(`Failed to connect to ${domain}: ${error.message}`);
                continue;
            }
        }

        if (!searchResults) {
            return res.status(503).json({ 
                error: 'Unable to connect to any Z-Library servers. They might be temporarily down or blocked.',
                domains_tried: ZLIB_DOMAINS
            });
        }

        // Parse the HTML
        const $ = cheerio.load(searchResults);
        
        // Debug: log the page structure to see what we're working with
        console.log('Page title:', $('title').text());
        console.log('Looking for book results...');
        
        // Try multiple selectors for book results - Z-Library uses different layouts
        let bookElements = [];
        
        // Updated selectors based on current Z-Library structure
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
            console.log(`Trying selector "${selector}": found ${bookElements.length} elements`);
            
            if (bookElements.length > 0) {
                // If we found links but no container elements, get their parents
                if (selector === 'a[href*="/book/"]' && bookElements.length > 0) {
                    bookElements = bookElements.map((i, el) => {
                        const $el = $(el);
                        // Try to find a meaningful parent container
                        let parent = $el.closest('tr, div, li, article').first();
                        return parent.length ? parent[0] : el;
                    });
                }
                break;
            }
        }

        // If still no results, try to find any structure with book-like content
        if (bookElements.length === 0) {
            // Look for any element containing both a title-like link and author info
            const potentialBooks = $('*').filter(function() {
                const $this = $(this);
                const hasBookLink = $this.find('a[href*="/book/"]').length > 0;
                const hasText = $this.text().length > 20;
                const notTooNested = $this.parents().length < 10;
                return hasBookLink && hasText && notTooNested;
            });
            
            if (potentialBooks.length > 0) {
                bookElements = potentialBooks;
                console.log(`Found ${bookElements.length} potential book containers via content analysis`);
            }
        }

        if (bookElements.length === 0) {
            console.log('HTML preview (first 1000 chars):', searchResults.substring(0, 1000));
            return res.status(404).json({ 
                error: 'No books found for your search - the page structure may have changed',
                query: query,
                domain_used: workingDomain,
                debug_info: {
                    page_title: $('title').text(),
                    page_has_content: searchResults.length > 0,
                    selectors_tried: selectors
                }
            });
        }

        const books = [];
        
        bookElements.each((index, element) => {
            if (index >= 10) return false; // Limit to 10 results
            
            const $book = $(element);
            
            // Log the HTML structure for debugging (first item only)
            if (index === 0) {
                console.log('First book element HTML:', $book.html());
            }
            
            // Extract title and URL - UPDATED for Z-Library web components
            let title = '';
            let bookUrl = '';
            let author = 'Unknown';
            let year = 'Unknown';
            let language = 'Unknown';
            let pages = 'Unknown';
            let format = 'Unknown';
            let coverUrl = null;
            
            // Strategy 1: Check for Z-Library web component (z-bookcard)
            const zbookcard = $book.find('z-bookcard').first();
            if (zbookcard.length) {
                console.log('Found z-bookcard element');
                
                // Extract data from attributes
                bookUrl = zbookcard.attr('href') || '';
                year = zbookcard.attr('year') || 'Unknown';
                language = zbookcard.attr('language') || 'Unknown';
                format = zbookcard.attr('extension') || 'Unknown';
                
                // Extract title from slot
                title = zbookcard.find('[slot="title"]').text().trim() || 
                       zbookcard.find('div[slot="title"]').text().trim();
                
                // Extract author from slot
                author = zbookcard.find('[slot="author"]').text().trim() || 
                        zbookcard.find('div[slot="author"]').text().trim();
                
                // Extract cover image
                const imgElement = zbookcard.find('img').first();
                if (imgElement.length) {
                    coverUrl = imgElement.attr('data-src') || imgElement.attr('src');
                }
                
                console.log(`Z-bookcard data: title="${title}", author="${author}", url="${bookUrl}"`);
            }
            
            // Strategy 2: Fallback to traditional parsing if z-bookcard not found
            if (!title || !bookUrl) {
                console.log('Falling back to traditional parsing');
                
                // Look for common Z-Library title patterns
                const titleSelectors = [
                    'h3 a',                    // Standard h3 title
                    '.book-title a',           // Book title class
                    '.title a',                // Generic title class
                    'a[href*="/book/"]',       // Any book link
                    '.itemCover + div a',      // Link next to cover
                    'h3',                      // Just h3 (might contain text)
                    '.booktitle',              // Book title without link
                    'h2 a',                    // h2 titles
                    'h1 a'                     // h1 titles
                ];
                
                for (const selector of titleSelectors) {
                    const titleElement = $book.find(selector).first();
                    if (titleElement.length) {
                        title = titleElement.text().trim();
                        bookUrl = titleElement.attr('href') || '';
                        
                        // If we found a title but no URL, look for URL in parent/siblings
                        if (title && !bookUrl) {
                            const linkElement = $book.find('a[href*="/book/"]').first();
                            if (linkElement.length) {
                                bookUrl = linkElement.attr('href');
                            }
                        }
                        
                        if (title && bookUrl) {
                            console.log(`Found title with selector "${selector}": ${title.substring(0, 50)}...`);
                            break;
                        }
                    }
                }
                
                // If still no title/URL, look for any significant text + book link
                if (!title || !bookUrl) {
                    const bookLinks = $book.find('a[href*="/book/"]');
                    if (bookLinks.length > 0) {
                        const titleElement = bookLinks.first();
                        title = titleElement.text().trim();
                        bookUrl = titleElement.attr('href');
                        
                        if (title.length < 3) {
                            const parentText = titleElement.closest('div, td, li').text().trim();
                            const lines = parentText.split('\n').map(line => line.trim()).filter(line => line.length > 3);
                            if (lines.length > 0) {
                                title = lines[0];
                            }
                        }
                    }
                }
            }
            
            // Skip if we still couldn't find title and URL
            if (!title || !bookUrl || title.length < 2) {
                console.log(`Skipping item ${index}: title="${title}", bookUrl="${bookUrl}"`);
                return;
            }
            
            // Make URL absolute
            if (bookUrl && bookUrl.startsWith('/')) {
                bookUrl = `https://${workingDomain}${bookUrl}`;
            }
            
            // If we still don't have author and using fallback parsing
            if (author === 'Unknown' && !zbookcard.length) {
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
            
            // Extract additional metadata for non-z-bookcard elements
            if (!zbookcard.length) {
                function extractMetadata(keywords, fallbackPattern = null, defaultValue = 'Unknown') {
                    // Try structured data first
                    for (const keyword of keywords) {
                        const selectors = [
                            `.property_${keyword} .property_value`,
                            `[class*="${keyword}"]`,
                            `.${keyword}`,
                            `[data-${keyword}]`
                        ];
                        
                        for (const selector of selectors) {
                            const element = $book.find(selector).first();
                            if (element.length && element.text().trim()) {
                                const value = element.text().trim();
                                if (value !== 'Unknown' && value.length > 0) {
                                    return value;
                                }
                            }
                        }
                    }
                    
                    if (fallbackPattern) {
                        const text = $book.text().replace(/\s+/g, ' ');
                        const match = text.match(fallbackPattern);
                        if (match && match[1]) {
                            return match[1].trim();
                        }
                    }
                    
                    return defaultValue;
                }
                
                year = extractMetadata(['year', 'published', 'date'], /\b(19|20)\d{2}\b/, 'Unknown');
                language = extractMetadata(['language', 'lang'], /Language:\s*([^\s,\n]+)/i, 'Unknown');
                pages = extractMetadata(['pages'], /(\d+)\s*(?:pages|pp|p\.)/i, 'Unknown');
                format = extractMetadata(['extension', 'format', 'type'], /(PDF|EPUB|MOBI|DJVU|FB2|TXT|DOC|RTF|AZW3?)\b/i, 'Unknown');
            }
            
            // Extract cover image if not already found
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
            
            // Make cover URL absolute if needed
            if (coverUrl && coverUrl.startsWith('/')) {
                coverUrl = `https://${workingDomain}${coverUrl}`;
            }
            
            // Clean up the data
            const cleanText = (text) => text.replace(/\s+/g, ' ').trim();
            
            const bookData = {
                title: cleanText(title),
                author: cleanText(author),
                year: cleanText(year),
                language: cleanText(language),
                pages: cleanText(pages),
                format: cleanText(format).toUpperCase(),
                bookUrl: bookUrl,
                coverUrl: coverUrl,
                domain: workingDomain
            };
            
            console.log(`Extracted book ${index + 1}:`, {
                title: bookData.title.substring(0, 50) + '...',
                author: bookData.author,
                url: bookData.bookUrl
            });
            
            books.push(bookData);
        });

        if (books.length === 0) {
            // Provide more detailed debug information
            const sampleElement = bookElements.length > 0 ? $(bookElements[0]).html() : 'No elements found';
            return res.status(404).json({ 
                error: 'Could not parse book information from search results',
                query: query,
                domain_used: workingDomain,
                debug_info: {
                    elements_found: bookElements.length,
                    sample_html: sampleElement.substring(0, 500) + '...'
                }
            });
        }

        console.log(`Successfully parsed ${books.length} books, now fetching read links...`);
        
        // Fetch read links for each book
        const booksWithReadLinks = [];
        for (let i = 0; i < Math.min(books.length, 5); i++) { // Limit to 5 books to avoid timeouts
            const book = books[i];
            console.log(`Fetching read link for: ${book.title.substring(0, 30)}...`);
            
            const readLink = await getReadLink(book.bookUrl, workingDomain);
            
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

        console.log(`Successfully processed ${booksWithReadLinks.length} books with read links`);
        res.json({
            query: query,
            results: booksWithReadLinks
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ 
            error: 'Internal server error during search',
            details: error.message 
        });
    }
});

// Get book details and read link
app.get('/api/book/details', async (req, res) => {
    const bookUrl = req.query.url;
    
    if (!bookUrl) {
        return res.status(400).json({ error: 'Book URL is required' });
    }

    console.log(`Getting book details from: ${bookUrl}`);

    try {
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get(bookUrl);
        
        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.data);
        
        // Find read online button with multiple strategies - UPDATED for Z-Library
        let readerUrl = null;
        
        console.log('Looking for reader URL...');
        
        // Strategy 1: Look for Z-Library specific reader link patterns
        const readSelectors = [
            '.reader-link',                     // Z-Library reader link class (most specific)
            '.read-online .reader-link',        // Reader link within read-online container
            '.book-details-button .reader-link', // Reader link in book details button
            'a[href*="reader.z-lib"]',          // Direct Z-Library reader URLs
            'a[href*="/read/"]',                // URLs containing /read/
            '.read-online a[href*="reader"]',   // Read online container with reader URL
            '.dlButton.reader-link',            // Download button that's also reader link
            'a.btn[href*="reader"]',            // Button with reader in URL
            '.btn-primary[href*="reader"]',     // Primary button with reader URL
            'a[data-book_id][href*="reader"]'   // Links with book ID and reader URL
        ];
        
        for (const selector of readSelectors) {
            const elements = $(selector);
            console.log(`Trying selector "${selector}": found ${elements.length} elements`);
            
            elements.each((i, el) => {
                const $el = $(el);
                const href = $el.attr('href');
                const text = $el.text().toLowerCase().trim();
                
                console.log(`  Element ${i}: href="${href}", text="${text}"`);
                
                // Priority 1: Z-Library reader URLs
                if (href && href.includes('reader.z-lib')) {
                    readerUrl = href;
                    console.log(`Found Z-Library reader URL: ${href}`);
                    return false; // break
                }
                
                // Priority 2: URLs with /read/ path
                if (href && href.includes('/read/') && !href.includes('litera-reader')) {
                    readerUrl = href;
                    console.log(`Found /read/ URL: ${href}`);
                    return false; // break
                }
                
                // Priority 3: Any reader URL that's not generic
                if (href && href.includes('reader') && !href.includes('litera-reader') 
                    && !href.includes('#') && text.includes('read')) {
                    readerUrl = href;
                    console.log(`Found reader URL: ${href}`);
                    return false; // break
                }
            });
            
            if (readerUrl) break;
        }
        
        // Strategy 2: Look for specific Z-Library reader button structure
        if (!readerUrl) {
            console.log('Trying Z-Library button structure...');
            
            // Look for the specific button structure you showed
            const readOnlineContainer = $('.read-online, .book-details-button');
            if (readOnlineContainer.length) {
                const readerLink = readOnlineContainer.find('a[href*="reader"], a[href*="/read/"]').first();
                if (readerLink.length) {
                    const href = readerLink.attr('href');
                    if (href && !href.includes('litera-reader')) {
                        readerUrl = href;
                        console.log(`Found reader URL in container: ${href}`);
                    }
                }
            }
        }
        
        // Strategy 3: Look for any button/link with "Read Online" text and valid reader href
        if (!readerUrl) {
            console.log('Looking for Read Online text...');
            
            const readButtons = $('a, button').filter((index, element) => {
                const text = $(element).text().toLowerCase().replace(/\s+/g, ' ').trim();
                return text.includes('read online') || text === 'read online';
            });
            
            readButtons.each((i, el) => {
                const $el = $(el);
                const href = $el.attr('href');
                console.log(`Read Online button ${i}: href="${href}"`);
                
                if (href && (href.includes('reader.z-lib') || href.includes('/read/')) 
                    && !href.includes('litera-reader') && href !== '#') {
                    readerUrl = href;
                    console.log(`Found Read Online URL: ${href}`);
                    return false; // break
                }
            });
        }
        
        // Strategy 4: Look in page source for reader URLs (sometimes dynamically generated)
        if (!readerUrl) {
            console.log('Searching page content for reader URLs...');
            
            const pageHtml = $.html();
            const readerMatches = pageHtml.match(/href=["']([^"']*reader[^"']*z-lib[^"']*)['"]/gi);
            
            if (readerMatches && readerMatches.length > 0) {
                // Extract the URL from the first match
                const match = readerMatches[0].match(/href=["']([^"']+)['"]/i);
                if (match && match[1] && !match[1].includes('litera-reader')) {
                    readerUrl = match[1];
                    console.log(`Found reader URL in page source: ${readerUrl}`);
                }
            }
        }
        
        // Strategy 2: Look in JavaScript for reader URLs
        if (!readerUrl) {
            console.log('Searching JavaScript for reader URLs...');
            const scripts = $('script').map((i, el) => $(el).html()).get().join('\n');
            
            // Look for Z-Library reader URLs in JavaScript
            const jsReaderMatch = scripts.match(/["'](https?:\/\/reader\.z-lib[^"']+)["']/);
            if (jsReaderMatch && jsReaderMatch[1]) {
                readerUrl = jsReaderMatch[1];
                console.log(`Found reader URL in JavaScript: ${readerUrl}`);
            }
        }
        
        // Clean up the URL - decode HTML entities
        if (readerUrl) {
            // Decode HTML entities like &amp; to &
            readerUrl = readerUrl
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#039;/g, "'");
            
            console.log(`Final reader URL after cleanup: ${readerUrl}`);
        }
        
        // Make URL absolute if needed
        if (readerUrl && readerUrl.startsWith('/')) {
            const urlObj = new URL(bookUrl);
            readerUrl = `${urlObj.protocol}//${urlObj.host}${readerUrl}`;
        }
        
        // Extract additional book details from the book page
        const bookTitle = $('h1').first().text().trim() || 
                         $('.book-title, .title').first().text().trim() ||
                         $('[itemprop="name"]').first().text().trim();
        
        const bookAuthor = $('.author a, .authors a, [itemprop="author"]').first().text().trim();
        
        const description = $('.book-description, .description, #bookDescriptionBox, [itemprop="description"]').first().text().trim();
        
        console.log(`Book details extracted - Title: ${bookTitle}, Author: ${bookAuthor}, Reader URL: ${readerUrl ? 'Found' : 'Not found'}`);
        
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
        console.error('Book details error:', error);
        res.status(500).json({ 
            error: 'Failed to get book details',
            details: error.message 
        });
    }
});

// Proxy endpoint for general requests (fallback)
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get(targetUrl);
        
        res.set({
            'Content-Type': response.headers['content-type'] || 'text/html',
            'Access-Control-Allow-Origin': '*'
        });
        
        res.send(response.data);
        
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch URL',
            details: error.message 
        });
    }
});

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Z-Library Book Search API running on http://localhost:${PORT}`);
    console.log(`📚 API endpoints:`);
    console.log(`   GET /test - Test connection`);
    console.log(`   GET /search/:query - Search books (returns photo and read link)`);
    console.log(`   GET /api/book/details?url=... - Get book details`);
    console.log(`   GET /api/proxy?url=... - Generic proxy`);
    console.log(`💡 Example: http://localhost:3000/search/python programming`);
});

module.exports = app;
