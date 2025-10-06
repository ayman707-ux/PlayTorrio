# ⚡ PlayTorrio

**Playtorrio** is a clean and efficient **torrent streaming app** that uses [Jackett](https://github.com/Jackett/Jackett) to fetch torrent results and stream magnet links directly — all in one interface.

Built with ❤️ by **Ayman Marwan**.
PlayTorrio's official [website](https://playtorrio.netlify.app/)

---

## 🧩 Features
- 🔍 Fetch torrents from multiple sources via Jackett  
- 🎥 Stream magnet links instantly without full download  
- 💾 Lightweight and fast UI  
- ⚙️ Customizable Jackett URL and API key  
- 🌙 Simple, dark-themed interface  
- 🚀 Cross-platform support (Windows / Linux / macOS)

---

## 🛠️ Tech Stack
- **Backend:** Node.js / Electron  
- **Frontend:** HTML, CSS, JavaScript  
- **APIs:** Jackett API  
- **Streaming:** WebTorrent or similar engine

---

## ⚙️ Jackett Setup & Installation

Step 1: Install Jackett
Go to the official [Jackett](https://github.com/Jackett/Jackett/releases) release page
Download the latest Windows x64 Installer (Jackett.Installer.Windows.exe)
Run the installer and complete setup.
Run jackett by double clicking on it in the icon trey

<img width="237" height="219" alt="image" src="https://github.com/user-attachments/assets/7c650fb0-9f70-497c-8d71-91d1b59017d3" />

---
Note that jackett has to be running in order to use PlayTorrio
You can make jackett automatically start by right clicking on it then click on auto start on boot
---

<img width="489" height="184" alt="image" src="https://github.com/user-attachments/assets/5efc5588-dc1a-4e13-a13a-86334a51e5d8" />

After running Jackett go to http://127.0.0.1:9117/UI/Dashboard
or http://localhost:9117/UI/Dashboard
in any browser

Step 2: Add Indexers
Indexers are the torrent sources Jackett searches through.

In Jackett’s dashboard, click “Add Indexer”.

<img width="908" height="948" alt="image" src="https://github.com/user-attachments/assets/7b412338-5faf-4a2d-b492-60efd56650a5" />


Search for your favorite torrent sites (like RARBG, 1337x, ThePirateBay, etc.).

Click the + icon to add each one. or just tick it and then you can scroll down and click add selected to add all of them in one go

Some indexers may require login credentials — enter them if you have accounts.

<img width="893" height="870" alt="image" src="https://github.com/user-attachments/assets/408a7faf-e44e-4935-b347-a994025acb4b" />


Then scroll all the way down after selecting your Torrent sites and click add selected
<img width="894" height="304" alt="image" src="https://github.com/user-attachments/assets/c4531d56-a5b7-4415-9790-21c014fdbea3" />

Step 3: Get Your Jackett API Key

Playtorrio connects to Jackett using your personal API key.

Go to Jackett’s Dashboard.

At the top right corner, you’ll see your API Key.

Copy it.

<img width="902" height="923" alt="image" src="https://github.com/user-attachments/assets/f26f2987-0f64-4a47-b141-b9aba4c535bb" />



Go to PlayTorrio and either add the jackett api key in the initial setup or from the settings at the top right


🧑‍💻 Author

Ayman Marwan
GitHub Profile
https://github.com/ayman707-ux
Built for the open-source community ⚙️

Playtorrio and Jackett are intended for educational and legal use only.
You are solely responsible for the content you access.

If you enjoy Playtorrio, please give it a ⭐ on GitHub to show support!
