"use strict";

const path = require("path");
const {BrowserWindow, app} = require("electron");
const {getPluginEntry} = require("../index");
require("electron-debug")({showDevTools: false});

// Use platform-specific directory with bundled mpv libraries
const platformDir = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const pdir = path.join(__dirname, "..", "mpv", platformDir);
// Change directory to load bundled libraries on all platforms
process.chdir(pdir);
// On Linux, set LD_LIBRARY_PATH so the system can find libmpv.so.2
if (process.platform === "linux") {
  process.env.LD_LIBRARY_PATH = pdir + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
}
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("ignore-gpu-blacklist");
app.commandLine.appendSwitch("register-pepper-plugins", getPluginEntry(pdir));

app.on("ready", () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    autoHideMenuBar: true,
    useContentSize: process.platform !== "linux",
    title: "PlayTorrio Player",
    frame: false,
    resizable: true,
    icon: path.join(__dirname, "..", "icon.ico"),
    webPreferences: {plugins: true, nodeIntegration: true, contextIsolation: false},
  });
  win.setMenu(null);
  win.loadURL(`file://${__dirname}/index.html`);
  
  global.mainWindow = win;
  // Pass arguments to renderer: URL, TMDB ID, Season, Episode
  const args = process.argv.filter(arg => !arg.startsWith("-") && arg !== process.execPath && !arg.endsWith("index.js") && !arg.endsWith("example") && !arg.endsWith(".exe"));
  if (args.length > 0) {
    global.initialUrl = args[0];
    if (args.length > 1) {
      global.tmdbId = args[1];
    }
    if (args.length > 2) {
      global.seasonNum = args[2];
    }
    if (args.length > 3) {
      global.episodeNum = args[3];
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
