import express from 'express';
import cors from 'cors';
import axios from 'axios';
import NodeCache from 'node-cache';

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize cache with 1 hour TTL
const cache = new NodeCache({ stdTTL: 3600 });

// Middleware
app.use(cors());
app.use(express.json());

// Constants
const API_URL = "https://api.ascendara.app";
const BACKUP_CDN = "https://cdn.ascendara.app/files/data.json";

// Helper function to sanitize text
function sanitizeText(text) {
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
  const cachedData = cache.get(cacheKey);
  
  if (cachedData) {
    return cachedData;
  }

  let endpoint = `${API_URL}/json/games`;
  if (source === 'fitgirl') {
    endpoint = `${API_URL}/json/sources/fitgirl/games`;
  }

  try {
    const response = await axios.get(endpoint);
    const data = response.data;

    // Sanitize game titles
    if (data.games) {
      data.games = data.games.map(game => ({
        ...game,
        name: sanitizeText(game.name),
        game: sanitizeText(game.game),
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

    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.warn('Primary API failed, trying backup CDN:', error.message);
    
    try {
      const response = await axios.get(BACKUP_CDN);
      const data = response.data;

      if (data.games) {
        data.games = data.games.map(game => ({
          ...game,
          name: sanitizeText(game.name),
          game: sanitizeText(game.game),
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

      cache.set(cacheKey, result);
      return result;
    } catch (cdnError) {
      throw new Error('Failed to fetch game data from both primary and backup sources');
    }
  }
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats()
    }
  });
});

// Get all games
app.get('/api/steamrip/all', async (req, res) => {
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
app.get('/api/steamrip/random', async (req, res) => {
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
app.get('/api/steamrip/search', async (req, res) => {
  try {
    const query = req.query.q || '';
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
app.get('/api/steamrip/category/:category', async (req, res) => {
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
app.get('/api/steamrip/game/:imgID', async (req, res) => {
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
app.get('/api/steamrip/image/:imgID', async (req, res) => {
  try {
    const { imgID } = req.params;
    const source = req.query.source || 'steamrip';
    
    let imageUrl;
    if (source === 'fitgirl') {
      imageUrl = `${API_URL}/v2/fitgirl/image/${imgID}`;
    } else {
      imageUrl = `${API_URL}/v2/image/${imgID}`;
    }
    
    const response = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 10000
    });
    
    res.set('Content-Type', response.headers['content-type']);
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.send(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      error: 'Failed to fetch image', 
      message: error.message 
    });
  }
});

// Get all categories
app.get('/api/steamrip/categories', async (req, res) => {
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
app.get('/api/steamrip/covers', async (req, res) => {
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

// Clear cache endpoint (useful for development)
app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ 
    message: 'Cache cleared successfully',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║         SteamRip API Server               ║
║         Running on port ${PORT}              ║
╚═══════════════════════════════════════════╝

📡 API Endpoints:
   • GET  /api/health
   • GET  /api/steamrip/all
   • GET  /api/steamrip/random
   • GET  /api/steamrip/search?q=
   • GET  /api/steamrip/category/:category
   • GET  /api/steamrip/game/:imgID
   • GET  /api/steamrip/image/:imgID
   • GET  /api/steamrip/categories
   • GET  /api/steamrip/covers?q=
   • POST /api/cache/clear

🌐 Server: http://localhost:${PORT}
📖 Docs: See README.md for detailed API documentation
  `);
});

export default app;
