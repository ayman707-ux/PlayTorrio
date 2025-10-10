# Torrentless

A minimal search UI served by a tiny Node.js backend that fetches a public search page and parses items, including magnet links, sizes, seeds, leechers, and age.

Important: This project is for educational/informational purposes only. Ensure you have the rights to access any content and follow your local laws.

## Quick start (Windows PowerShell)

1. Install Node.js (v18+ recommended)
2. In this folder, install dependencies and start the server:

```powershell
# From the project root
npm install
npm start
```

3. Open your browser at:

```
http://localhost:3002
```

Type a search term (e.g., Batman) and hit Search.

## How it works

- Frontend (in `public/`) serves a search box and results table.
- Backend (Express) exposes `GET /api/search?q=…&page=N`.
- The scraper (`src/scraper.js`) fetches the target search page and parses:
  - title, magnet link, torrent page URL
  - size, seeds, leechers, age, category
  - simple pagination (next page)

## Notes

- If the target site changes its HTML, parsing selectors may need updates in `src/scraper.js`.
- Network, region, or anti-bot protections may occasionally block requests. Try again later or adjust headers/timeouts.
- Use responsibly. You are solely responsible for how you use this software.

## Troubleshooting

- If you see no results, check the server logs for errors.
- If fetches hang or fail, the site may be slow or blocking. You can try increasing the timeout inside `src/scraper.js` or setting a different User-Agent.


made by ayman for PlayTorrio! enjoy
