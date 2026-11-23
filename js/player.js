// Thin wrapper over the YouTube IFrame Player API.

let apiReady = null;
function loadApi() {
  if (!apiReady) {
    apiReady = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.append(s);
    });
  }
  return apiReady;
}

// Error codes: 2 bad id, 5 HTML5 error, 100 removed/private,
// 101/150/153 embedding not allowed (often region or label restrictions).
export const UNPLAYABLE = new Set([2, 5, 100, 101, 150, 153]);

export class Player {
  constructor(mount, { onEnded, onError, onState, onTick } = {}) {
    this.mount = mount;
    this.cb = { onEnded, onError, onState, onTick };
    this.yt = null;
    this.ready = null;
    this.timer = null;
  }

  async play(videoId) {
    await loadApi();
    if (!this.yt) {
      this.ready = new Promise((resolve) => {
        const el = document.createElement('div');
        this.mount.replaceChildren(el);
        this.yt = new window.YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1 },
          events: {
            onReady: () => { this.yt.playVideo(); resolve(); },
            onStateChange: (e) => this._state(e.data),
            onError: (e) => this.cb.onError && this.cb.onError(e.data),
          },
        });
      });
      await this.ready;
    } else {
      await this.ready;
      this.yt.loadVideoById(videoId);
    }
    this._startTimer();
  }

  _state(s) {
    if (this.cb.onState) this.cb.onState(s);
    if (s === 0 && this.cb.onEnded) this.cb.onEnded();
  }

  _startTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.yt || !this.yt.getCurrentTime || !this.cb.onTick) return;
      this.cb.onTick(this.yt.getCurrentTime() || 0, this.yt.getDuration() || 0);
    }, 1000);
  }

  toggle() {
    if (!this.yt || !this.yt.getPlayerState) return;
    if (this.yt.getPlayerState() === 1) this.yt.pauseVideo(); else this.yt.playVideo();
  }

  seekBy(sec) {
    if (!this.yt || !this.yt.getCurrentTime) return;
    this.yt.seekTo(Math.max(0, this.yt.getCurrentTime() + sec), true);
  }

  seekFraction(f) {
    if (!this.yt || !this.yt.getDuration) return;
    this.yt.seekTo(this.yt.getDuration() * f, true);
  }

  stop() {
    clearInterval(this.timer);
    if (this.yt && this.yt.destroy) this.yt.destroy();
    this.yt = null;
    this.ready = null;
  }

  isPlaying() {
    return !!(this.yt && this.yt.getPlayerState && this.yt.getPlayerState() === 1);
  }

  pause() { if (this.yt && this.yt.pauseVideo) this.yt.pauseVideo(); }
  resume() { if (this.yt && this.yt.playVideo) this.yt.playVideo(); }
}
