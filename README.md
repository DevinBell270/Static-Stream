# Static Stream

Static Stream is a self-hosted, algorithm-free television simulator. It takes hand-picked YouTube channels, groups them into custom categories, and turns them into a cable like experience.

## What It Does

- Uses `Node.js` and `Express` for the local backend
- Uses local JSON files instead of a database
- Lets you manage categories and YouTube handles from a browser-based admin dashboard
- Sanitizes all user inputs (such as category names and handles) to prevent Cross-Site Scripting (XSS)
- Fetches recent uploads from the YouTube Data API server-side only
- Ignores videos that are 3 minutes or shorter to keep Shorts out of the lineup, and 3 hours or longer to avoid excessively long content
- Builds a daily cable-style rotation with a mix of new uploads and reruns
- Simulates a live cable channel by calculating a shared playback position from a fixed weekly epoch
- Plays videos with the YouTube IFrame Player API

## Project Structure

```text
.
├── server.js
├── config.json
├── database.json
├── .env
├── .env.example
├── public/
│   ├── admin.html
│   ├── admin.js
│   ├── admin.css
│   ├── tv.html
│   ├── tv.js
│   └── tv.css
└── package.json
```

## Requirements

- `Node.js` 18 or newer
- A YouTube Data API v3 key

## Installation

1. Install dependencies:

```bash
npm install
```

2. Create your local environment file from the example:

```bash
cp .env.example .env
```

3. Edit `.env` and set your YouTube API key:

```env
YOUTUBE_API_KEY=your_real_api_key_here
REFRESH_INTERVAL_HOURS=24
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
```

`ADMIN_USERNAME` and `ADMIN_PASSWORD` are required to access the admin dashboard. The server will not start if they are missing. `REFRESH_INTERVAL_HOURS` is optional. The default is `24`. You can set it to `12` if you want the cached guide to refresh more often.

You do not need to manually create `config.json` or `database.json`.

- `config.json` is auto-created on first run with placeholder categories
- `database.json` is auto-created by the server as the local cached guide
- After startup, you can manage categories and channel handles from `/admin.html`

The auto-generated `config.json` starts with placeholder entries. After you add channels via the admin dashboard, it looks like this:

```json
{
  "categories": {
    "Travel Vlogs": [
      { "handle": "@exampletraveler", "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx" }
    ],
    "Tech Reviews": [
      { "handle": "@exampletech", "channelId": "UCyyyyyyyyyyyyyyyyyyyy" }
    ]
  }
}
```

Each channel entry includes the `@handle` you entered and the `channelId` resolved by the server. Legacy entries with only `channelId` are also supported.

## Running The App

Start the app in normal mode:

```bash
npm start
```

Run in watch mode during development:

```bash
npm run dev
```

Once the server is running, open:

- TV player: [http://localhost:3000/tv.html](http://localhost:3000/tv.html)
- Admin dashboard: [http://localhost:3000/admin.html](http://localhost:3000/admin.html)

The root URL redirects to the TV player:

- [http://localhost:3000](http://localhost:3000)

## How Data Works

Static Stream uses a zero-database setup:

- `config.json` stores your categories and YouTube channel IDs
- Handle-based entries are saved as both the original `@handle` and the resolved `channelId`
- `database.json` stores the cached guide data and fixed playback order for each category

Both files are local-only and git-ignored.

- `config.json` is seeded automatically if it does not exist yet
- `database.json` is generated and refreshed automatically by the server

The YouTube fetch process runs only when:

- the server starts
- you click `Save Changes` in the admin dashboard
- the scheduled refresh interval is reached

When the guide refreshes, the server builds each category like this:

1. Fetch the 30 most recent uploads for every configured channel
2. Discard anything that is 3 minutes or shorter, or 3 hours or longer
3. Pick a 5-video daily rotation per channel:
   - the 2 newest uploads
   - 3 random reruns from the remaining uploads
4. Combine those channel rotations into one category playlist
5. Shuffle that category playlist once with Fisher-Yates
6. Save that exact shuffled order to `database.json`

That saved order stays fixed until the next refresh, so every viewer tunes into the same position in the same loop.

## Admin Workflow

Use `/admin.html` to manage your lineup.

- Create categories
- Delete categories
- Add YouTube handles to a selected category from the dropdown
- Remove individual channels
- Save changes to write `config.json` and rebuild the cached guide

When you save a new `@handle`, the server resolves it once through the YouTube Data API, stores the matching `channelId` in `config.json`, and reuses that saved ID for later refreshes.

## TV Experience

Use `/tv.html` for the fullscreen player experience.

- The guide overlay appears on mouse movement
- Categories are loaded from the local guide cache
- Tuning into a category calls the local backend for the current live position
- Playback starts at the calculated second inside the correct video
- When a video ends, the player advances to the next item in the saved category loop
- Keyboard controls:
  - `Up`/`Down` Arrows: Navigate the channel guide
  - `Left`/`Right` Arrows: Cycle through channels directly
  - `Enter`: Tune into the selected channel or open the channel info box
  - `Spacebar`: Toggle audio mute/unmute

## API Endpoints

- `GET /api/config` returns the current config
- `POST /api/config` overwrites the config, resolves new `@handle` entries, and refreshes cached guide data
- `GET /api/guide` returns the compiled local guide
- `GET /api/tune-in/:category` returns the current live video and start offset for a category

## Notes

- The YouTube API key is only used server-side in `server.js`
- Frontend files never call the YouTube Data API directly
- `.env`, `config.json`, `database.json`, and `node_modules/` are ignored by git
- If the API key is missing or invalid, the app will still load, but categories will not have playable cached videos
