# Music Library

An always-on, shareable website for a rated YouTube music library. Every song has a
**category**, a **1–5 star rating** and optional **flairs**. Tick the filters you want and the
site builds the playlist on the spot, then plays it right in the page, in order, shuffled, or
with **Shuffle unheard**.

**Live site:** https://proj-yeet.github.io/yt-music-library/

Companion userscript (rates songs on YouTube and files them into playlists):
**[YouTube Channel Playlist Collector](https://github.com/ProJ-Yeet/yt-channel-playlist-collector)**

## What it does

- **Library grid**: thumbnails with the category letter on top and the stars underneath.
  Long and Secondary flairs and the duration are shown on the thumbnail.
- **Filters**: categories, stars, Long (any / only / hide), Secondary, length range, text
  search over title and channel, and several sort orders. Each chip shows how many songs it
  would add.
- **Share links**: the filters live in the URL, so 🔗 Share copies a link to exactly that
  playlist for a friend.
- **Player**: YouTube's embedded player with a queue, next/previous and keyboard shortcuts
  (Space, ←/→, Ctrl+←/→ to seek 5 s, 0–9 to jump). Videos whose owners block playback
  outside YouTube are skipped automatically.
- **Shuffle unheard**: songs you heard within the cool-down period (default 7 days) don't
  play until everything else has. After that a song's chance grows the longer it has been
  since you heard it. Each song's cool-down is stretched by a random 0–50%, so a batch you
  heard together comes back spread over several days instead of all at once. Listening
  history stays in your own browser.
- **Open on YouTube**: the first 50 songs as a temporary YouTube playlist.
- **Real time**: the library is a Firestore database, so a rating changed on the website or
  on YouTube shows up on every open copy of the site within a second or two.
- **Editing**: only the owner can edit, after signing in with Google. Everyone else can
  browse and play.

### Categories and flairs

| Letter | Category | Meaning |
|---|---|---|
| S | Song | songs with lyrics |
| M | Music | instrumental, no words |
| R | Relax | ambient music to work to |
| Sl | Slow | songs on the slow side |
| E | Electric | EDM |
| C | Classical | |
| P | Pop | |
| Ro | Rock | |
| Ep | Epic | |
| Mc | Minecraft | |
| H | Hololive | Hololive talents |

Flairs: **Long** (set automatically for anything over 15 minutes) and **Secondary**.

Each combination of stars, category and flairs (for example "4★ Song" or "3★ Relax · Long")
has its own YouTube playlist. The userscript creates the playlist when the first song arrives
and starts the next one ("… 2") when YouTube's 5,000-video limit is reached.

## How it fits together

```
 YouTube (logged in)                    Firestore (free Spark plan)           This website
 ┌──────────────────────────┐  writes   ┌──────────────────────────┐  live   ┌───────────────┐
 │ Collector userscript     │ ────────▶ │ library/meta             │ ──────▶ │ grid, filters │
 │  rating strip, filing,   │  via the  │ library/c00 … c31        │         │ player        │
 │  moves, import           │  Library  │ (songs grouped in 32     │ ◀────── │ owner edits   │
 │                          │  Bridge   │  documents)              │  edits  │               │
 └──────────────────────────┘ ◀──────── └──────────────────────────┘         └───────────────┘
            moves songs rated on the site into their playlist
```

Songs are grouped into 32 documents, so a visit costs about 33 reads, well within the free
50,000 per day.

Song record (`library/cNN`, field `v.<videoId>`):

| Field | Meaning |
|---|---|
| `t`, `a`, `d` | title, channel, duration in seconds |
| `c`, `s`, `f` | category, stars, flairs (`L` Long, `S` Secondary) |
| `p` | the YouTube playlist the song currently sits in |
| `x`, `u` | added / last changed (ms) |

`library/meta` holds `ownerUid` and `buckets`, the list of YouTube playlists for each
combination, with their sizes.

## Running your own copy

1. Create a Firebase project. Add a **Firestore** database, turn on **Google** sign-in, and
   add your GitHub Pages domain under Authentication → Settings → Authorized domains.
2. Put your web config in `js/firebase-config.js`.
3. Publish `firestore.rules` with your Google account's email in it.
4. Serve the folder from anywhere static. GitHub Pages works.
5. Sign in once. The first sign-in by the account the rules allow becomes the owner.

There is no build step: plain ES modules, with the Firebase SDK loaded from Google's CDN.
Tests for the filtering and shuffle logic: `npm test` (Node 20+).

## Credits

- Inspired by [playlistShuffle](https://github.com/imagevars/playlistShuffle) by imagevars:
  the idea of shuffling YouTube playlists in a web player, and its keyboard shortcuts. No code
  was copied.
- Playback uses the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference).
- Data and sign-in use [Firebase](https://firebase.google.com/).
- Built with help from Claude (Anthropic).

## License

[MIT](LICENSE)
