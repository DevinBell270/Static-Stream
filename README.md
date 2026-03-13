# Static Stream

Static Stream is a self-hosted, algorithm-free television simulator. It takes hand-picked YouTube channels, groups them into custom categories, and turns them into a shared "live TV" experience with a synchronized tune-in point for every viewer.

## What It Does

- Uses `Node.js` and `Express` for the local backend
- Uses local JSON files instead of a database
- Lets you manage categories and YouTube handles from a browser-based admin dashboard
- Fetches recent uploads from the YouTube Data API server-side only
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
```

`REFRESH_INTERVAL_HOURS` is optional. The default is `24`. You can set it to `12` if you want the cached guide to refresh more often.

You do not need to manually create `config.json` or `database.json`.

- `config.json` is auto-created on first run with placeholder categories
- `database.json` is auto-created by the server as the local cached guide
- After startup, you can manage categories and channel handles from `/admin.html`

The auto-generated `config.json` starts with a shape like this:

```json
{
  "categories": {
    "Theme Parks": [
      { "channelId": "UC_BELLS_IN_DISNEY_PLACEHOLDER" }
    ],
    "Kentucky Outdoors": [
      { "channelId": "UC_KENTUCKY_OUTDOORS_PLACEHOLDER" }
    ]
  }
}
```

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
- `database.json` stores the cached guide data fetched from YouTube

Both files are local-only and git-ignored.

- `config.json` is seeded automatically if it does not exist yet
- `database.json` is generated and refreshed automatically by the server

The YouTube fetch process runs only when:

- the server starts
- you click `Save Changes` in the admin dashboard
- the scheduled refresh interval is reached

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
- When a video ends, the player advances through the category loop

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
