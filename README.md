# ⚡ PlayTorrio

**PlayTorrio** is a clean and efficient media center and torrent streaming app that uses [Jackett](https://github.com/Jackett/Jackett) and built-in scrapers to fetch torrent results and stream magnet links directly — all in one interface.

Built with ❤️ by **Ayman Marwan**.
PlayTorrio's official [website](https://playtorrio.netlify.app/)

---

## 🧩 Features
- 🔍 Fetch torrents from multiple sources via Jackett  
- 🔍 If you Dont want to use jackett, Torrentio and a private scraper are both bundled in the app
- 🎥 Stream magnet links instantly without full download  
- 💾 Lightweight and fast UI  
- ⚙️ Customizable Jackett URL and API key  
- 🌙 Simple, dark-themed interface  
- 🚀 Cross-platform support (Windows / Soon Linux / Soon macOS)
- 🌐 Debrid support (Real-Debrid, AllDebrid, TorBox, Premiumize)
- ⏯️ Resume where you left off
- 📝 Built-in subtitles with customization
- 🧭 Two UIs: modern and classic (switch in Settings)
- ⬇️ In-app downloader
- 🔗 In-app custom 111477 API to get download links
- 📚 Built-in Books search (Z‑Library mirrors) with reader
- 📺 Live TV/IPTV section
- ✅ Trakt integration: import Watchlist to My List and History to Done Watching
- 🗂️ My List and Done Watching, with episode-level tracking
- 🧰 Integrated microservices (Torrentless, 111477, Books, BookDownloader) auto-start with health checks
- 🔄 Auto-updater with persistent progress
- Online Z-Lib book reader
-In-App Book downloader and reader (BookTorrio)
-manga
- in-app nyaa.si anime torrent scraper and streamer
-anime
-Music
---

## 🛠️ Tech Stack
- **Backend:** Node.js / Electron  
- **Frontend:** HTML, CSS, JavaScript  
- **APIs:** Jackett API, TMDB, Trakt, Z‑Library scraping, 111477 api, torrentless api, LibGen Api
- **Streaming:** WebTorrent (integrated HTTP server), MPV optional but recommended, normal stream servers (check settings)

---

## ⚙️ Jackett Setup & Installation

Video Tutorial [here](https://www.youtube.com/watch?v=3igLReZFFzg)

---

### Step 1: Install Jackett
1. Go to the official [Jackett releases](https://github.com/Jackett/Jackett/releases)
2. Download the latest Windows x64 Installer (Jackett.Installer.Windows.exe)
3. Run the installer and complete setup.
4. Start Jackett from the system tray.

<img width="237" height="219" alt="image" src="https://github.com/user-attachments/assets/7c650fb0-9f70-497c-8d71-91d1b59017d3" />

> Note: Jackett must be running to use PlayTorrio. You can enable "Start on boot" from the tray menu.

<img width="489" height="184" alt="image" src="https://github.com/user-attachments/assets/5efc5588-dc1a-4e13-a13a-86334a51e5d8" />

Open Jackett in a browser:
- http://127.0.0.1:9117/UI/Dashboard or http://localhost:9117/UI/Dashboard

### Step 2: Add Indexers
Indexers are the torrent sources Jackett searches through.

- In Jackett’s dashboard, click “Add Indexer”.

<img width="908" height="948" alt="image" src="https://github.com/user-attachments/assets/7b412338-5faf-4a2d-b492-60efd56650a5" />

- Search for your favorite torrent sites (e.g., RARBG, 1337x, ThePirateBay, etc.).
- Click the + icon to add each one, or tick multiple and click "Add Selected" at the bottom.
- Some indexers may require login credentials.

<img width="893" height="870" alt="image" src="https://github.com/user-attachments/assets/408a7faf-e44e-4935-b347-a994025acb4b" />

Scroll to the bottom and click "Add Selected":

<img width="894" height="304" alt="image" src="https://github.com/user-attachments/assets/c4531d56-a5b7-4415-9790-21c014fdbea3" />

### Step 3: Get Your Jackett API Key
PlayTorrio connects to Jackett using your personal API key.

- In Jackett’s Dashboard, find the API Key at the top right and copy it.

<img width="902" height="923" alt="image" src="https://github.com/user-attachments/assets/f26f2987-0f64-4a47-b141-b9aba4c535bb" />

- In PlayTorrio, paste the API key in the initial setup or later in Settings (bottom-left).

---

## 🧑‍💻 Author
**Ayman Marwan**  
GitHub: https://github.com/ayman707-ux  
Built for the open-source community ⚙️

PlayTorrio and Jackett are intended for educational and legal use only. You are solely responsible for the content you access.

If you enjoy PlayTorrio, please give it a ⭐ on GitHub to show support!

License: The repository’s license covers the torrent scraper and all code within this repo.
