# SteamRip API Server

A standalone Express.js API server that provides access to the SteamRip game scraper data. This API serves game information, images, and metadata from the Ascendara game database.

## 🚀 Quick Start

### Installation

```bash
cd SteamRip
npm install
```

### Running the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on `http://localhost:3000` by default.

### Environment Variables

You can customize the port by setting the `PORT` environment variable:

```bash
PORT=8080 npm start
```

---

## 📡 API Endpoints

### Base URL
```
http://localhost:3000
```

---

### 1. Health Check

Check if the API server is running and view cache statistics.

**Endpoint:** `GET /api/health`

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-22T12:00:00.000Z",
  "cache": {
    "keys": 2,
    "stats": {
      "hits": 150,
      "misses": 5,
      "keys": 2
    }
  }
}
```

---

### 2. Get All Games

Retrieve the complete list of games from the database.

**Endpoint:** `GET /api/steamrip/all`

**Query Parameters:**
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl http://localhost:3000/api/steamrip/all
```

**Example Response:**
```json
{
  "games": [
    {
      "game": "Cyberpunk 2077",
      "name": "Cyberpunk 2077",
      "imgID": "abc123",
      "weight": 9,
      "category": ["Action", "RPG"],
      "description": "An open-world RPG set in Night City...",
      "download_links": {
        "torrent": "magnet:...",
        "direct": "https://..."
      }
    }
  ],
  "metadata": {
    "apiversion": "2.0",
    "games": 1500,
    "getDate": "2025-11-22",
    "source": "steamrip",
    "imagesAvailable": true
  }
}
```

---

### 3. Get Random Top Games

Get a random selection of highly-rated games (perfect for home screen carousels).

**Endpoint:** `GET /api/steamrip/random`

**Query Parameters:**
- `count` (optional): Number of games to return (default: `8`)
- `minWeight` (optional): Minimum weight/rating (default: `7`)
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl "http://localhost:3000/api/steamrip/random?count=5&minWeight=8"
```

**Example Response:**
```json
{
  "games": [
    {
      "game": "Red Dead Redemption 2",
      "name": "Red Dead Redemption 2",
      "imgID": "xyz789",
      "weight": 10,
      "category": ["Action", "Adventure"],
      "description": "An epic tale of life in America's unforgiving heartland..."
    }
  ],
  "count": 5
}
```

---

### 4. Search Games

Search for games by title, name, or description.

**Endpoint:** `GET /api/steamrip/search`

**Query Parameters:**
- `q` (required): Search query
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl "http://localhost:3000/api/steamrip/search?q=witcher"
```

**Example Response:**
```json
{
  "games": [
    {
      "game": "The Witcher 3: Wild Hunt",
      "name": "The Witcher 3: Wild Hunt",
      "imgID": "wit123",
      "weight": 10,
      "category": ["RPG", "Action"]
    }
  ],
  "count": 1,
  "query": "witcher"
}
```

---

### 5. Get Games by Category

Retrieve all games in a specific category.

**Endpoint:** `GET /api/steamrip/category/:category`

**Path Parameters:**
- `category`: The category name (e.g., "Action", "RPG", "Strategy")

**Query Parameters:**
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl http://localhost:3000/api/steamrip/category/RPG
```

**Example Response:**
```json
{
  "games": [
    {
      "game": "Elden Ring",
      "name": "Elden Ring",
      "imgID": "eld456",
      "weight": 10,
      "category": ["RPG", "Action"]
    }
  ],
  "count": 150,
  "category": "RPG"
}
```

---

### 6. Get Specific Game

Retrieve detailed information about a specific game by its image ID.

**Endpoint:** `GET /api/steamrip/game/:imgID`

**Path Parameters:**
- `imgID`: The unique image ID of the game

**Query Parameters:**
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl http://localhost:3000/api/steamrip/game/abc123
```

**Example Response:**
```json
{
  "game": {
    "game": "Cyberpunk 2077",
    "name": "Cyberpunk 2077",
    "imgID": "abc123",
    "weight": 9,
    "category": ["Action", "RPG"],
    "description": "An open-world RPG set in Night City...",
    "download_links": {
      "torrent": "magnet:...",
      "direct": "https://..."
    }
  }
}
```

**Error Response (404):**
```json
{
  "error": "Game not found",
  "imgID": "invalid123"
}
```

---

### 7. Get Game Image

Proxy endpoint to retrieve game cover images.

**Endpoint:** `GET /api/steamrip/image/:imgID`

**Path Parameters:**
- `imgID`: The unique image ID of the game

**Query Parameters:**
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl http://localhost:3000/api/steamrip/image/abc123 > cover.jpg
```

**Response:**
- Returns the image binary data
- Content-Type: `image/jpeg` or `image/png`
- Cached for 24 hours

**HTML Usage:**
```html
<img src="http://localhost:3000/api/steamrip/image/abc123" alt="Game Cover">
```

---

### 8. Get All Categories

Retrieve a list of all available game categories.

**Endpoint:** `GET /api/steamrip/categories`

**Query Parameters:**
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl http://localhost:3000/api/steamrip/categories
```

**Example Response:**
```json
{
  "categories": [
    "Action",
    "Adventure",
    "Horror",
    "Puzzle",
    "RPG",
    "Simulation",
    "Sports",
    "Strategy"
  ],
  "count": 8
}
```

---

### 9. Search Game Covers

Search for game covers with limited results (useful for autocomplete/search previews).

**Endpoint:** `GET /api/steamrip/covers`

**Query Parameters:**
- `q` (required): Search query
- `limit` (optional): Maximum results (default: `20`)
- `source` (optional): `steamrip` or `fitgirl` (default: `steamrip`)

**Example Request:**
```bash
curl "http://localhost:3000/api/steamrip/covers?q=dark&limit=5"
```

**Example Response:**
```json
{
  "covers": [
    {
      "id": "Dark Souls III",
      "title": "Dark Souls III",
      "imgID": "ds3123"
    },
    {
      "id": "Darkest Dungeon",
      "title": "Darkest Dungeon",
      "imgID": "dd456"
    }
  ],
  "count": 2,
  "query": "dark"
}
```

---

### 10. Clear Cache

Clear the server's cache (useful for development/testing).

**Endpoint:** `POST /api/cache/clear`

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/cache/clear
```

**Response:**
```json
{
  "message": "Cache cleared successfully",
  "timestamp": "2025-11-22T12:30:00.000Z"
}
```

---

## 📊 Response Codes

- `200 OK`: Successful request
- `404 Not Found`: Resource not found
- `500 Internal Server Error`: Server error

---

## 🔧 Features

- **Automatic Caching**: All game data is cached for 1 hour (3600 seconds) to reduce API calls
- **Fallback CDN**: If the primary API fails, automatically falls back to CDN
- **Text Sanitization**: Automatically fixes encoding issues in game titles
- **CORS Enabled**: Can be accessed from any domain
- **Image Proxy**: Direct access to game images through the API

---

## 💡 Usage Examples

### JavaScript/Fetch

```javascript
// Get all games
const response = await fetch('http://localhost:3000/api/steamrip/all');
const data = await response.json();
console.log(data.games);

// Search for games
const searchResponse = await fetch('http://localhost:3000/api/steamrip/search?q=cyberpunk');
const searchData = await searchResponse.json();
console.log(searchData.games);

// Get random games for home screen
const randomResponse = await fetch('http://localhost:3000/api/steamrip/random?count=10');
const randomData = await randomResponse.json();
console.log(randomData.games);
```

### React Component Example

```jsx
import React, { useEffect, useState } from 'react';

function GameList() {
  const [games, setGames] = useState([]);

  useEffect(() => {
    fetch('http://localhost:3000/api/steamrip/random?count=8')
      .then(res => res.json())
      .then(data => setGames(data.games));
  }, []);

  return (
    <div>
      {games.map(game => (
        <div key={game.imgID}>
          <img 
            src={`http://localhost:3000/api/steamrip/image/${game.imgID}`} 
            alt={game.name} 
          />
          <h3>{game.name}</h3>
          <p>{game.description}</p>
        </div>
      ))}
    </div>
  );
}
```

### Python Example

```python
import requests

# Get all games
response = requests.get('http://localhost:3000/api/steamrip/all')
data = response.json()
print(f"Total games: {data['metadata']['games']}")

# Search for games
search = requests.get('http://localhost:3000/api/steamrip/search', 
                     params={'q': 'witcher'})
games = search.json()['games']
for game in games:
    print(game['name'])
```

---

## 🐛 Troubleshooting

### Server won't start
- Make sure port 3000 is not already in use
- Try a different port: `PORT=8080 npm start`
- Check if all dependencies are installed: `npm install`

### No games returned
- Check your internet connection
- The API fetches data from `api.ascendara.app` - make sure it's accessible
- Clear the cache: `curl -X POST http://localhost:3000/api/cache/clear`

### Images not loading
- Make sure the imgID is correct
- Check if the source parameter matches the game source
- Images are cached for 24 hours on the client side

---

## 📝 Notes

- The cache is stored in memory and will be cleared when the server restarts
- The API uses the official Ascendara API as its data source
- All game data is fetched from `api.ascendara.app`
- Supports both SteamRip and FitGirl sources

---

## 🤝 Contributing

Feel free to submit issues or pull requests to improve this API server.

---

## 📄 License

CC-BY-NC-1.0 - Same as the parent Ascendara project
