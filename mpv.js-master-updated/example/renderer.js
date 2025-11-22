"use strict";

const path = require("path");
const React = require("react");
const ReactDOM = require("react-dom");
const {remote} = require("electron");
const {ReactMPV} = require("../index");

class Main extends React.PureComponent {
  constructor(props) {
    super(props);
    this.mpv = null;
    this.hideControlsTimeout = null;
    this.subPosInterval = null;
    this.state = {
      pause: true,
      "time-pos": 0,
      duration: 0,
      fullscreen: false,
      url: "",
      volume: 100,
      muted: false,
      showControls: true,
      showUrlInput: false,
      showSubtitlesMenu: false,
      showAudioMenu: false,
      subtitleTracks: [],
      audioTracks: [],
      currentSubTrack: null,
      currentAudioTrack: null,
      "demuxer-cache-duration": 0,
      "demuxer-cache-time": 0,
      "sub-delay": 0,
      "paused-for-cache": false,
      "core-idle": true,
      "sub-pos": 100,
      "sub-visibility": true,
      externalSubtitles: [],
      loadingExternalSubs: false
    };
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleMPVReady = this.handleMPVReady.bind(this);
    this.handlePropertyChange = this.handlePropertyChange.bind(this);
    this.toggleFullscreen = this.toggleFullscreen.bind(this);
    this.togglePause = this.togglePause.bind(this);
    this.handleStop = this.handleStop.bind(this);
    this.handleSeek = this.handleSeek.bind(this);
    this.handleSeekMouseDown = this.handleSeekMouseDown.bind(this);
    this.handleSeekMouseUp = this.handleSeekMouseUp.bind(this);
    this.handleLoad = this.handleLoad.bind(this);
    this.handleUrlChange = this.handleUrlChange.bind(this);
    this.handleUrlLoad = this.handleUrlLoad.bind(this);
    this.handleSkipForward = this.handleSkipForward.bind(this);
    this.handleSkipBackward = this.handleSkipBackward.bind(this);
    this.toggleMute = this.toggleMute.bind(this);
    this.handleVolumeChange = this.handleVolumeChange.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.resetHideControlsTimer = this.resetHideControlsTimer.bind(this);
    this.toggleUrlInput = this.toggleUrlInput.bind(this);
    this.handleWatchUrl = this.handleWatchUrl.bind(this);
    this.handleMinimize = this.handleMinimize.bind(this);
    this.handleMaximize = this.handleMaximize.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.toggleSubtitlesMenu = this.toggleSubtitlesMenu.bind(this);
    this.selectSubtitleTrack = this.selectSubtitleTrack.bind(this);
    this.toggleAudioMenu = this.toggleAudioMenu.bind(this);
    this.selectAudioTrack = this.selectAudioTrack.bind(this);
    this.loadSubtitleTracks = this.loadSubtitleTracks.bind(this);
    this.loadAudioTracks = this.loadAudioTracks.bind(this);
    this.loadAllTracks = this.loadAllTracks.bind(this);
    this.nextSubtitleTrack = this.nextSubtitleTrack.bind(this);
    this.prevSubtitleTrack = this.prevSubtitleTrack.bind(this);
    this.increaseSubDelay = this.increaseSubDelay.bind(this);
    this.decreaseSubDelay = this.decreaseSubDelay.bind(this);
    this.moveSubtitleUp = this.moveSubtitleUp.bind(this);
    this.moveSubtitleDown = this.moveSubtitleDown.bind(this);
    this.toggleSubVisibility = this.toggleSubVisibility.bind(this);
    this.startMoveSubUp = this.startMoveSubUp.bind(this);
    this.startMoveSubDown = this.startMoveSubDown.bind(this);
    this.stopMoveSubPosition = this.stopMoveSubPosition.bind(this);
    this.loadExternalSubtitles = this.loadExternalSubtitles.bind(this);
    this.loadExternalSubtitle = this.loadExternalSubtitle.bind(this);
  }
  componentDidMount() {
    document.addEventListener("keydown", this.handleKeyDown, false);
    this.resetHideControlsTimer();
  }
  componentWillUnmount() {
    document.removeEventListener("keydown", this.handleKeyDown, false);
    if (this.hideControlsTimeout) {
      clearTimeout(this.hideControlsTimeout);
    }
    if (this.subPosInterval) {
      clearInterval(this.subPosInterval);
    }
  }
  handleKeyDown(e) {
    // Allow typing in input fields
    if (e.target.tagName === "INPUT") {
      return;
    }
    
    // Only handle specific keys, let MPV handle the rest (J for audio, V for subs, etc.)
    if (e.key === "f" || (e.key === "Escape" && this.state.fullscreen)) {
      e.preventDefault();
      this.toggleFullscreen();
    } else if (this.state.duration) {
      // Pass all keys to MPV - it has built-in shortcuts:
      // J - cycle audio tracks
      // V or v - cycle subtitle tracks  
      // Space - play/pause
      // Arrow keys - seek
      this.mpv.keypress(e);
    }
  }
  handleMPVReady(mpv) {
    this.mpv = mpv;
    console.log("MPV Ready - available methods:", Object.keys(mpv));
    const observe = mpv.observe.bind(mpv);
    ["pause", "time-pos", "duration", "eof-reached", "volume", "mute", "track-list", "sid", "aid", "demuxer-cache-duration", "demuxer-cache-time", "sub-delay", "paused-for-cache", "core-idle", "sub-pos", "sub-visibility"].forEach(observe);
    this.mpv.property("hwdec", "auto");
    this.mpv.property("volume", this.state.volume);
    // Enable subtitle auto-loading
    this.mpv.property("sub-auto", "fuzzy");
    this.mpv.property("sub-file-paths", "");
    
    // Auto-load URL if provided from command line
    const initialUrl = remote.getGlobal("initialUrl");
    if (initialUrl) {
      this.mpv.command("loadfile", initialUrl);
      this.setState({url: initialUrl});
      
      // Load external subtitles if TMDB ID is provided
      const tmdbId = remote.getGlobal("tmdbId");
      if (tmdbId) {
        this.loadExternalSubtitles(tmdbId);
      }
    }
  }
  loadExternalSubtitles(tmdbId) {
    const seasonNum = remote.getGlobal("seasonNum");
    const episodeNum = remote.getGlobal("episodeNum");
    
    let url = `https://sub.wyzie.ru/search?id=${tmdbId}`;
    if (seasonNum && episodeNum) {
      url += `&season=${seasonNum}&episode=${episodeNum}`;
    }
    
    this.setState({loadingExternalSubs: true});
    
    fetch(url)
      .then(response => response.json())
      .then(data => {
        console.log("External subtitles fetched:", data);
        this.setState({
          externalSubtitles: data,
          loadingExternalSubs: false
        });
      })
      .catch(error => {
        console.error("Error fetching external subtitles:", error);
        this.setState({loadingExternalSubs: false});
      });
  }
  loadExternalSubtitle(subtitleUrl) {
    if (!this.mpv) return;
    // Load external subtitle file
    this.mpv.command("sub-add", subtitleUrl);
    this.setState({showSubtitlesMenu: false});
  }
  handlePropertyChange(name, value) {
    if (name === "time-pos" && this.seeking) {
      return;
    } else if (name === "eof-reached" && value) {
      this.mpv.property("time-pos", 0);
    } else if (name === "mute") {
      this.setState({muted: value});
    } else if (name === "volume") {
      this.setState({volume: Math.round(value)});
    } else if (name === "track-list") {
      console.log("Track list update:", value);
      this.loadAllTracks(value);
    } else if (name === "sid") {
      console.log("Current subtitle track:", value);
      this.setState({currentSubTrack: value});
    } else if (name === "aid") {
      console.log("Current audio track:", value);
      this.setState({currentAudioTrack: value});
    } else if (name === "duration" && value > 0) {
      console.log("Video duration loaded:", value);
      this.setState({[name]: value});
    } else {
      this.setState({[name]: value});
    }
  }
  toggleFullscreen() {
    const win = remote.getCurrentWindow();
    const newFullscreenState = !this.state.fullscreen;
    
    // Use true fullscreen mode which hides taskbar
    win.setFullScreen(newFullscreenState);
    
    this.setState({fullscreen: newFullscreenState});
  }
  togglePause(e) {
    if (e && e.target) e.target.blur();
    if (!this.state.duration) return;
    this.mpv.property("pause", !this.state.pause);
    this.setState({showControls: true});
    this.resetHideControlsTimer();
  }
  handleStop(e) {
    e.target.blur();
    this.mpv.property("pause", true);
    this.mpv.command("stop");
    this.setState({"time-pos": 0, duration: 0});
  }
  handleSeekMouseDown() {
    this.seeking = true;
  }
  handleSeek(e) {
    e.target.blur();
    const timePos = +e.target.value;
    this.setState({"time-pos": timePos});
    this.mpv.property("time-pos", timePos);
  }
  handleSeekMouseUp() {
    this.seeking = false;
  }
  handleLoad(e) {
    e.target.blur();
    const items = remote.dialog.showOpenDialog({filters: [
      {name: "Videos", extensions: ["mkv", "webm", "mp4", "mov", "avi"]},
      {name: "All files", extensions: ["*"]},
    ]});
    if (items) {
      this.mpv.command("loadfile", items[0]);
    }
  }
  handleUrlChange(e) {
    this.setState({url: e.target.value});
  }
  handleUrlLoad(e) {
    if (e.key === "Enter" && this.state.url.trim()) {
      this.mpv.command("loadfile", this.state.url.trim());
      this.setState({showUrlInput: false});
      e.target.blur();
    }
  }
  toggleUrlInput() {
    this.setState({showUrlInput: !this.state.showUrlInput});
  }
  handleWatchUrl() {
    if (this.state.url.trim()) {
      this.mpv.command("loadfile", this.state.url.trim());
      this.setState({showUrlInput: false});
    }
  }
  handleSkipForward() {
    if (!this.state.duration) return;
    const newPos = Math.min(this.state["time-pos"] + 10, this.state.duration);
    this.mpv.property("time-pos", newPos);
  }
  handleSkipBackward() {
    if (!this.state.duration) return;
    const newPos = Math.max(this.state["time-pos"] - 10, 0);
    this.mpv.property("time-pos", newPos);
  }
  toggleMute() {
    this.mpv.property("mute", !this.state.muted);
  }
  handleVolumeChange(e) {
    const volume = parseInt(e.target.value);
    this.setState({volume});
    this.mpv.property("volume", volume);
    if (volume > 0 && this.state.muted) {
      this.mpv.property("mute", false);
    }
  }
  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  loadSubtitleTracks(trackList) {
    if (!trackList) return;
    console.log("Track list received:", trackList);
    const subs = trackList.filter(track => track.type === "sub");
    console.log("Subtitle tracks:", subs);
    this.setState({subtitleTracks: subs});
  }
  loadAudioTracks(trackList) {
    if (!trackList) return;
    const audio = trackList.filter(track => track.type === "audio");
    console.log("Audio tracks:", audio);
    this.setState({audioTracks: audio});
  }
  loadAllTracks(trackList) {
    if (!trackList) {
      console.warn("loadAllTracks called with null/undefined trackList");
      return;
    }
    console.log("All tracks received:", trackList);
    console.log("Track list type:", typeof trackList);
    console.log("Track list is array:", Array.isArray(trackList));
    
    if (!Array.isArray(trackList)) {
      console.error("track-list is not an array!");
      return;
    }
    
    const subs = trackList.filter(track => track.type === "sub");
    const audio = trackList.filter(track => track.type === "audio");
    console.log("Subtitle tracks:", subs);
    console.log("Audio tracks:", audio);
    this.setState({
      subtitleTracks: subs,
      audioTracks: audio
    });
  }
  toggleSubtitlesMenu() {
    this.setState({showSubtitlesMenu: !this.state.showSubtitlesMenu});
  }
  nextSubtitleTrack() {
    if (!this.mpv) return;
    // Use 'j' key to cycle to next subtitle track
    this.mpv.keypress({key: 'j'});
  }
  prevSubtitleTrack() {
    if (!this.mpv) return;
    // Use 'J' (Shift+j) key to cycle to previous subtitle track
    this.mpv.keypress({key: 'J', shiftKey: true});
  }
  increaseSubDelay() {
    if (!this.mpv) return;
    // Use 'x' key to increase subtitle delay by 100ms
    this.mpv.keypress({key: 'x'});
  }
  decreaseSubDelay() {
    if (!this.mpv) return;
    // Use 'z' key to decrease subtitle delay by 100ms
    this.mpv.keypress({key: 'z'});
  }
  moveSubtitleUp() {
    if (!this.mpv) return;
    // Use 'r' key to move subtitle position up
    this.mpv.keypress({key: 'r'});
  }
  moveSubtitleDown() {
    if (!this.mpv) return;
    // Use 't' key to move subtitle position down
    this.mpv.keypress({key: 't'});
  }
  startMoveSubUp() {
    this.moveSubtitleUp();
    this.subPosInterval = setInterval(() => this.moveSubtitleUp(), 100);
  }
  startMoveSubDown() {
    this.moveSubtitleDown();
    this.subPosInterval = setInterval(() => this.moveSubtitleDown(), 100);
  }
  stopMoveSubPosition() {
    if (this.subPosInterval) {
      clearInterval(this.subPosInterval);
      this.subPosInterval = null;
    }
  }
  toggleSubVisibility() {
    if (!this.mpv) return;
    // Use 'v' key to toggle subtitle visibility
    this.mpv.keypress({key: 'v'});
  }
  selectSubtitleTrack(id) {
    this.mpv.property("sid", id);
    this.setState({showSubtitlesMenu: false, currentSubTrack: id});
  }
  toggleAudioMenu() {
    // Use '#' key to cycle through audio tracks
    if (this.mpv) {
      this.mpv.keypress({key: '#'});
    }
  }
  selectAudioTrack(id) {
    this.mpv.property("aid", id);
    this.setState({showAudioMenu: false, currentAudioTrack: id});
  }
  handleMinimize() {
    remote.getCurrentWindow().minimize();
  }
  handleMaximize() {
    const win = remote.getCurrentWindow();
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
  handleClose() {
    remote.getCurrentWindow().close();
  }
  handleMouseMove() {
    this.setState({showControls: true});
    this.resetHideControlsTimer();
  }
  resetHideControlsTimer() {
    if (this.hideControlsTimeout) {
      clearTimeout(this.hideControlsTimeout);
    }
    this.hideControlsTimeout = setTimeout(() => {
      if (!this.state.pause && !this.state.showSubtitlesMenu && !this.state.showAudioMenu) {
        this.setState({showControls: false});
      }
    }, 2000);
  }
  render() {
    const progressPercent = this.state.duration > 0
      ? (this.state["time-pos"] / this.state.duration) * 100
      : 0;
    
    // Calculate cache percentage
    const cacheEndTime = this.state["demuxer-cache-time"] || this.state["time-pos"];
    const cachePercent = this.state.duration > 0
      ? (cacheEndTime / this.state.duration) * 100
      : 0;

    return (
      <div className="container" onMouseMove={this.handleMouseMove}>
        <div className={`title-bar ${this.state.fullscreen ? 'hidden' : ''}`}>
          <div className="title-bar-drag">
            <div className="title-bar-title">PlayTorrio Player</div>
          </div>
          <div className="window-controls">
            <button className="window-btn minimize" onClick={this.handleMinimize} title="Minimize">
              <svg viewBox="0 0 12 12">
                <line x1="1" y1="6" x2="11" y2="6" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <button className="window-btn maximize" onClick={this.handleMaximize} title="Maximize">
              <svg viewBox="0 0 12 12">
                <rect x="2" y="2" width="8" height="8" strokeWidth="1.5" rx="1"/>
              </svg>
            </button>
            <button className="window-btn close" onClick={this.handleClose} title="Close">
              <svg viewBox="0 0 12 12">
                <path d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
        <div className="player-wrapper">
          <ReactMPV
            className="player"
            onReady={this.handleMPVReady}
            onPropertyChange={this.handlePropertyChange}
          />
          {(this.state["paused-for-cache"] || (this.state["core-idle"] && !this.state.duration)) && (
            <div className="loading-overlay">
              <div className="spinner"></div>
              <div className="loading-text">{this.state.duration ? 'Buffering...' : 'Loading...'}</div>
            </div>
          )}
          <div className="controls-overlay" style={{opacity: this.state.showControls ? 1 : 0}}>
            <div className="progress-container" 
                 onClick={(e) => {
                   if (!this.state.duration) return;
                   const rect = e.currentTarget.getBoundingClientRect();
                   const pos = (e.clientX - rect.left) / rect.width;
                   this.mpv.property("time-pos", pos * this.state.duration);
                 }}>
              <div className="progress-bar">
                <div className="progress-cache" style={{width: `${cachePercent}%`}}></div>
                <div className="progress-filled" style={{width: `${progressPercent}%`}}>
                  <div className="progress-thumb"></div>
                </div>
              </div>
            </div>
            
            <div className="time-display">
              <span>{this.formatTime(this.state["time-pos"])}</span>
              <span>{this.formatTime(this.state.duration)}</span>
            </div>

            <div className="controls-bottom">
              <div className="controls-left">
                <button className="control-btn skip" onClick={this.handleSkipBackward} title="Rewind 10s">
                  <svg viewBox="0 0 24 24" width="28" height="28">
                    <path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                    <text x="12" y="15" fontSize="7" textAnchor="middle" fill="currentColor" fontWeight="bold">10</text>
                  </svg>
                </button>

                <button className="control-btn play-pause" onClick={this.togglePause} title={this.state.pause ? "Play" : "Pause"}>
                  {this.state.pause ? (
                    <svg viewBox="0 0 24 24" width="32" height="32">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="32" height="32">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
                    </svg>
                  )}
                </button>

                <button className="control-btn skip" onClick={this.handleSkipForward} title="Forward 10s">
                  <svg viewBox="0 0 24 24" width="28" height="28">
                    <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                    <text x="12" y="15" fontSize="7" textAnchor="middle" fill="currentColor" fontWeight="bold">10</text>
                  </svg>
                </button>

                <div className="volume-container">
                  <button className="control-btn" onClick={this.toggleMute} title={this.state.muted ? "Unmute" : "Mute"}>
                    {this.state.muted || this.state.volume === 0 ? (
                      <svg viewBox="0 0 24 24" width="24" height="24">
                        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                      </svg>
                    ) : this.state.volume < 50 ? (
                      <svg viewBox="0 0 24 24" width="24" height="24">
                        <path d="M7 9v6h4l5 5V4l-5 5H7z"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="24" height="24">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                      </svg>
                    )}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={this.state.volume}
                    onChange={this.handleVolumeChange}
                    style={{width: '80px'}}
                    title={`Volume: ${this.state.volume}%`}
                  />
                </div>
              </div>

              <div className="controls-right">
                <button className="control-btn" onClick={this.toggleAudioMenu} title="Audio Tracks">
                  <svg viewBox="0 0 24 24" width="24" height="24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                  {this.state.currentAudioTrack && (
                    <span style={{fontSize: '14px', marginLeft: '4px', fontWeight: 'bold'}}>#{this.state.currentAudioTrack}</span>
                  )}
                </button>
                <button className="control-btn" onClick={this.toggleSubtitlesMenu} title="Subtitles">
                  <svg viewBox="0 0 24 24" width="24" height="24">
                    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/>
                  </svg>
                  {this.state.currentSubTrack && (
                    <span style={{fontSize: '14px', marginLeft: '4px', fontWeight: 'bold'}}>#{this.state.currentSubTrack}</span>
                  )}
                </button>
                <button className="control-btn" onClick={this.toggleFullscreen} title="Fullscreen">
                  {this.state.fullscreen ? (
                    <svg viewBox="0 0 24 24" width="24" height="24">
                      <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="24" height="24">
                      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {this.state.showSubtitlesMenu && (
            <div className="subtitles-menu" 
                 style={{opacity: this.state.showControls ? 1 : 0, pointerEvents: this.state.showControls ? 'auto' : 'none'}}
                 onMouseMove={this.handleMouseMove}
            >
              <div className="subtitles-menu-header">
                Subtitles ({this.state.subtitleTracks.length} available)
              </div>
              
              <div className="subtitle-navigation">
                <button className="nav-btn" onClick={this.prevSubtitleTrack} title="Previous Subtitle">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                  </svg>
                </button>
                <div className="current-sub-info">
                  <div className="sub-track-number">Track #{this.state.currentSubTrack || 'Off'}</div>
                  <div className="sub-track-name">
                    {this.state.currentSubTrack 
                      ? (this.state.subtitleTracks.find(t => t.id === this.state.currentSubTrack) 
                         ? (this.state.subtitleTracks.find(t => t.id === this.state.currentSubTrack).title || 
                            this.state.subtitleTracks.find(t => t.id === this.state.currentSubTrack).lang || 'Unknown')
                         : 'Unknown')
                      : 'Disabled'}
                  </div>
                </div>
                <button className="nav-btn" onClick={this.nextSubtitleTrack} title="Next Subtitle">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                  </svg>
                </button>
              </div>

              <div className="subtitle-delay-controls">
                <div className="delay-label">Subtitle Delay</div>
                <div className="delay-buttons">
                  <button className="delay-btn" onClick={this.decreaseSubDelay} title="Decrease delay by 100ms (Z)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M19 13H5v-2h14v2z"/>
                    </svg>
                    <span>100ms</span>
                  </button>
                  <div className="delay-value">{(this.state["sub-delay"] * 1000).toFixed(0)}ms</div>
                  <button className="delay-btn" onClick={this.increaseSubDelay} title="Increase delay by 100ms (X)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                    </svg>
                    <span>100ms</span>
                  </button>
                </div>
              </div>

              <div className="subtitle-delay-controls">
                <div className="delay-label">Subtitle Position</div>
                <div className="delay-buttons">
                  <button 
                    className="delay-btn" 
                    onMouseDown={this.startMoveSubUp}
                    onMouseUp={this.stopMoveSubPosition}
                    onMouseLeave={this.stopMoveSubPosition}
                    title="Move subtitles up (R) - Hold to repeat"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>
                    </svg>
                    <span>Up</span>
                  </button>
                  <div className="delay-value">{this.state["sub-pos"]}</div>
                  <button 
                    className="delay-btn" 
                    onMouseDown={this.startMoveSubDown}
                    onMouseUp={this.stopMoveSubPosition}
                    onMouseLeave={this.stopMoveSubPosition}
                    title="Move subtitles down (T) - Hold to repeat"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
                    </svg>
                    <span>Down</span>
                  </button>
                </div>
              </div>

              <div className="subtitle-visibility-control">
                <button className="visibility-btn" onClick={this.toggleSubVisibility}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    {this.state["sub-visibility"] ? (
                      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                    ) : (
                      <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                    )}
                  </svg>
                  <span>{this.state["sub-visibility"] ? 'Hide Subtitles (V)' : 'Show Subtitles (V)'}</span>
                </button>
              </div>

              <div className="subtitle-list-header">MPV Tracks</div>
              <div className="subtitles-menu-item" onClick={() => this.selectSubtitleTrack(0)}>
                <span>Off</span>
                {(this.state.currentSubTrack === 0 || this.state.currentSubTrack === false) && <span className="checkmark">✓</span>}
              </div>
              {this.state.subtitleTracks.length > 0 && this.state.subtitleTracks.map(track => (
                <div 
                  key={track.id} 
                  className="subtitles-menu-item" 
                  onClick={() => this.selectSubtitleTrack(track.id)}
                >
                  <span>#{track.id} - {track.title || track.lang || 'Unknown'}</span>
                  {this.state.currentSubTrack === track.id && <span className="checkmark">✓</span>}
                </div>
              ))}
              
              {this.state.externalSubtitles.length > 0 && (
                <div>
                  <div className="subtitle-list-header">External Subtitles</div>
                  {(() => {
                    const grouped = {};
                    this.state.externalSubtitles.forEach(sub => {
                      const lang = sub.display;
                      if (!grouped[lang]) grouped[lang] = [];
                      grouped[lang].push(sub);
                    });
                    
                    return Object.keys(grouped).sort().map(lang => {
                      const subs = grouped[lang];
                      return subs.map((sub, index) => {
                        const displayName = subs.length > 1 ? `${lang} ${index + 1}` : lang;
                        return (
                          <div 
                            key={sub.id} 
                            className="subtitles-menu-item external-sub-item" 
                            onClick={() => this.loadExternalSubtitle(sub.url)}
                          >
                            <img src={sub.flagUrl} alt={lang} style={{width: '20px', height: '15px', marginRight: '8px'}} />
                            <span>{displayName}</span>
                          </div>
                        );
                      });
                    });
                  })()}
                </div>
              )}
              
              {this.state.loadingExternalSubs && (
                <div style={{padding: '15px', textAlign: 'center', color: 'rgba(224, 179, 255, 0.7)', fontSize: '12px'}}>
                  Loading external subtitles...
                </div>
              )}
              
              <div style={{fontSize: '11px', opacity: 0.6, padding: '8px 15px', borderTop: '1px solid rgba(139, 63, 219, 0.2)', textAlign: 'center'}}>
                J = Cycle | Z/X = Delay | R/T = Position | V = Visibility
              </div>
            </div>
          )}

          {this.state.showAudioMenu && (
            <div className="subtitles-menu" style={{right: '130px', opacity: this.state.showControls ? 1 : 0, pointerEvents: this.state.showControls ? 'auto' : 'none'}}>
              <div className="subtitles-menu-header">
                Audio Tracks
              </div>
              {this.state.audioTracks.length > 0 && this.state.audioTracks.map(track => (
                <div 
                  key={track.id} 
                  className="subtitles-menu-item" 
                  onClick={() => this.selectAudioTrack(track.id)}
                >
                  <span>{track.name}</span>
                  {this.state.currentAudioTrack === track.id && <span className="checkmark">✓</span>}
                </div>
              ))}
              <div className="track-input-container">
                <span style={{marginRight: '10px'}}>Or enter track #:</span>
                <input 
                  type="number" 
                  min="1"
                  max="999"
                  placeholder="Track #"
                  style={{
                    width: '60px',
                    padding: '4px 8px',
                    borderRadius: '3px',
                    border: '1px solid #555',
                    background: '#222',
                    color: '#fff'
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const trackNum = parseInt(e.target.value);
                      if (trackNum > 0) {
                        this.selectAudioTrack(trackNum);
                        e.target.value = '';
                      }
                    }
                  }}
                />
              </div>
              <div style={{fontSize: '11px', opacity: 0.7, padding: '8px 15px', borderTop: '1px solid rgba(255,255,255,0.1)'}}>
                Tip: Press # to cycle through tracks
              </div>
            </div>
          )}

          {this.state.showUrlInput && (
            <div className="url-input-popup" onClick={(e) => e.stopPropagation()}>
              <input
                className="url-input-field"
                type="text"
                placeholder="Paste video URL here..."
                value={this.state.url}
                onChange={this.handleUrlChange}
                onKeyPress={this.handleUrlLoad}
                autoFocus
                ref={(input) => input && input.focus()}
              />
              <button className="watch-btn" onClick={this.handleWatchUrl}>
                Watch
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
}

ReactDOM.render(<Main/>, document.getElementById("main"));