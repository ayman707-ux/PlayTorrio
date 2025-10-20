const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 5500;

// Enable CORS for all routes
app.use(cors());

// Common trackers to add to magnet links
const trackers = [
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

// Helper function to parse seeder count and size from title
function parseStreamInfo(title) {
  const seederMatch = title.match(/👤\s*(\d+)/);
  const sizeMatch = title.match(/💾\s*([\d.]+\s*[A-Z]+)/);
  
  return {
    seeders: seederMatch ? parseInt(seederMatch[1]) : 0,
    size: sizeMatch ? sizeMatch[1] : 'Unknown'
  };
}

// Helper function to construct magnet link
function constructMagnetLink(infoHash, filename) {
  const encodedName = encodeURIComponent(filename);
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${trackers}`;
}

// API endpoint for movies
app.get('/api/:imdbid', async (req, res) => {
  try {
    const { imdbid } = req.params;
    
    // Validate IMDb ID format
    if (!imdbid.match(/^tt\d+$/)) {
      return res.status(400).json({ error: 'Invalid IMDb ID format. Must be in format: tt1234567' });
    }

    const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex/stream/movie/${imdbid}.json`;
    
    const response = await axios.get(torrentioUrl);
    
    if (!response.data || !response.data.streams || response.data.streams.length === 0) {
      return res.status(404).json({ error: 'No streams found for this movie' });
    }

    // Process all streams
    const allStreams = response.data.streams.map(stream => {
      const info = parseStreamInfo(stream.title);
      const filename = stream.behaviorHints?.filename || 'movie.mkv';
      const magnetLink = constructMagnetLink(stream.infoHash, filename);

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
    console.error('Error fetching movie:', error.message);
    if (error.response) {
      res.status(error.response.status).json({ error: `Torrentio API error: ${error.response.statusText}` });
    } else {
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  }
});

// API endpoint for TV shows
app.get('/api/:imdbid/:season/:episode', async (req, res) => {
  try {
    const { imdbid, season, episode } = req.params;
    
    // Validate IMDb ID format
    if (!imdbid.match(/^tt\d+$/)) {
      return res.status(400).json({ error: 'Invalid IMDb ID format. Must be in format: tt1234567' });
    }

    // Validate season and episode are numbers
    if (isNaN(season) || isNaN(episode)) {
      return res.status(400).json({ error: 'Season and episode must be numbers' });
    }

    const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex/stream/series/${imdbid}:${season}:${episode}.json`;
    
    const response = await axios.get(torrentioUrl);
    
    if (!response.data || !response.data.streams || response.data.streams.length === 0) {
      return res.status(404).json({ error: 'No streams found for this episode' });
    }

    // Process all streams
    const allStreams = response.data.streams.map(stream => {
      const info = parseStreamInfo(stream.title);
      const filename = stream.behaviorHints?.filename || `episode_S${season}E${episode}.mkv`;
      const magnetLink = constructMagnetLink(stream.infoHash, filename);

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
    console.error('Error fetching TV show:', error.message);
    if (error.response) {
      res.status(error.response.status).json({ error: `Torrentio API error: ${error.response.statusText}` });
    } else {
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    endpoints: {
      movies: '/api/:imdbid',
      tvshows: '/api/:imdbid/:season/:episode'
    },
    examples: {
      movie: '/api/tt5950044',
      tvshow: '/api/tt13159924/2/1'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Torrentio API Server running on http://localhost:${PORT}`);
  console.log(`\nExamples:`);
  console.log(`  Movie: http://localhost:${PORT}/api/tt5950044`);
  console.log(`  TV Show: http://localhost:${PORT}/api/tt13159924/2/1`);
});
