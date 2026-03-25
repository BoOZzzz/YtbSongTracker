# Ytb Song Tracker Extension

Private Chrome extension that watches `youtube.com` and `music.youtube.com`, counts a listen once playback passes your threshold, and posts the event to your backend so your site can update from your own database.

This folder now also includes a minimal local backend that stores events in JSON and exposes a basic top-songs API.
It also now includes an optional lightweight metadata classifier you can train from your own labeled examples.

## What this MVP does

- Tracks YouTube and YouTube Music playback in the browser.
- Collects classifier candidate metadata when you land on a YouTube video page.
- Waits until a video is meaningfully listened to before counting it.
- Extracts the raw video title and channel name.
- Normalizes likely song title and artist values with a lightweight parser.
- Optionally trains a small local classifier on title, channel, description, and parser-derived signals.
- Sends a JSON event to your backend endpoint.
- Queues failed deliveries in local extension storage for debugging.

## Files

- `manifest.json`: Chrome extension manifest (MV3).
- `content.js`: Runs on YouTube pages and detects listen milestones.
- `background.js`: Receives listen events and posts them to your backend.
- `parser.js`: Shared lightweight title/channel parser.
- `classifier.js`: Local feature extraction, training, and inference utilities.
- `scripts/train-classifier.js`: CLI entry point to train the classifier from labeled examples.
- `scripts/generate-label-batch.js`: Exports a batch of unlabeled browser-collected candidates.
- `scripts/import-labeled-batch.js`: Imports a labeled batch and optionally retrains the classifier.
- `options.html`, `options.css`, `options.js`: Settings UI.

## Load it locally

1. Open Chrome or Edge.
2. Go to `chrome://extensions` or `edge://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder: `D:\Projects\YtbSongTracker`.
6. Open the extension options page and set your backend URL.

After changing any extension file, reload the unpacked extension in `chrome://extensions` or `edge://extensions` before testing again.

## Run the backend

1. Open a terminal in `D:\Projects\YtbSongTracker`.
2. Set Spotify credentials if you want search verification
3. Run `npm start`
4. The backend will start on `http://localhost:3000`
5. Set the extension `Backend endpoint` to `http://localhost:3000/api/listens/youtube`

Optional auth:

- Set `YTB_TRACKER_API_TOKEN` before starting the server.
- Put the same token into the extension `Bearer token` field.
- Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to enable Spotify verification.
- Optional: set `SPOTIFY_MARKET` if you do not want the default `US`.

Example PowerShell:

```powershell
$env:YTB_TRACKER_API_TOKEN = "your-secret-token"
$env:SPOTIFY_CLIENT_ID = "your-spotify-client-id"
$env:SPOTIFY_CLIENT_SECRET = "your-spotify-client-secret"
npm start
```

Or create a local [.env](/D:/Projects/YtbSongTracker/.env) file:

```env
YTB_TRACKER_API_TOKEN=your-secret-token
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
SPOTIFY_MARKET=US
```

Then just run:

```powershell
npm start
```

## Suggested settings

- `Backend endpoint`: `http://localhost:3000/api/listens/youtube`
- `Minimum listened seconds`: `30`
- `Minimum completion percent`: `0.5`

The extension counts a listen when either threshold is reached.

## Event payload

The background worker posts JSON like this:

```json
{
  "source": "music.youtube.com",
  "sourceType": "youtube_music",
  "videoId": "abc123",
  "videoUrl": "https://music.youtube.com/watch?v=abc123",
  "pageUrl": "https://music.youtube.com/watch?v=abc123",
  "rawTitle": "IU - Love wins all (Official MV)",
  "rawChannelName": "IU Official",
  "normalizedTitle": "Love wins all",
  "normalizedArtist": "IU",
  "confidence": 0.8,
  "isLikelyMusic": true,
  "parsingStrategy": "title-separator",
  "listenedSeconds": 42,
  "durationSeconds": 267,
  "progressPercent": 0.157,
  "thresholdSeconds": 30,
  "capturedAt": "2026-03-22T15:00:00.000Z"
}
```

## Backend endpoints

- `GET /health`
- `POST /api/listens/youtube`
- `GET /api/listens?limit=20`
- `GET /api/stats/top-songs?limit=10&minConfidence=0.55`
- `GET /api/spotify/search?title=Love%20Song&artist=L4WUDU`
- `GET /api/classifier/status`
- `GET /api/classifier/labels?limit=50`
- `GET /api/classifier/candidates?limit=50&status=pending_label`
- `POST /api/classifier/labels`
- `POST /api/classifier/train`
- `POST /api/classifier/batches/next`
- `POST /api/classifier/candidates/collect`

Stored events are written to [listen-events.json](/D:/Projects/YtbSongTracker/data/listen-events.json) after the first successful POST.
Classifier labels are stored in [classifier-labels.json](/D:/Projects/YtbSongTracker/data/classifier-labels.json), and the trained model is stored in [classifier-model.json](/D:/Projects/YtbSongTracker/data/classifier-model.json).
Automatically collected label candidates are stored in [classifier-candidates.json](/D:/Projects/YtbSongTracker/data/classifier-candidates.json).

`GET /api/stats/top-songs` currently groups by:

- verified Spotify track when matched
- otherwise `normalizedArtist + normalizedTitle` when available
- otherwise raw-title fallback when no artist was parsed

When Spotify credentials are configured, the backend now:

- searches Spotify using the parsed artist/title candidate
- stores the best verified match when the score is strong enough
- keeps parser output as a fallback when Spotify does not confirm the track

When a trained classifier model exists, the backend also:

- scores each listen using raw title, channel, description, and parser-derived features
- uses Spotify as the strongest signal when a verified match exists
- otherwise lets the classifier override the parser when it has been trained

## Lightweight classifier workflow

The classifier is intentionally lightweight and dependency-free. It uses:

- hashed title/channel/description tokens
- parser confidence and parsing strategy
- flags such as `official`, `lyrics`, `topic`, `vevo`, `remix`, `cover`, `live`
- simple metadata lengths and separator counts

Recommended flow:

1. Browse YouTube normally and let the backend collect candidate items automatically from visited video pages.
2. Export an unlabeled batch from the candidate pool.
3. Label each item as `song`, `video`, or `uncertain`.
4. Import the batch and retrain.
5. Keep repeating with mistake-driven batches.

`uncertain` labels are stored but excluded from training, so metadata-invisible cases do not pollute the model.

Example label request:

```powershell
$headers = @{ "Content-Type" = "application/json" }
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/classifier/labels" `
  -Headers $headers `
  -Body (@{
    videoId = "abc123"
    rawTitle = "IU - Love wins all (Official MV)"
    rawChannelName = "IU Official"
    rawDescription = "Official music video"
    sourcePage = "www.youtube.com"
    label = "song"
  } | ConvertTo-Json)
```

Generate a batch from your automatically collected browse history:

```powershell
npm run label:batch -- --limit 20
```

Seed the candidate pool from your existing stored listen history:

```powershell
npm run label:backfill
```

This writes a new JSON file into [data](/D:/Projects/YtbSongTracker/data). Fill each `label` field with:

- `song`
- `video`
- `uncertain`

Import a labeled batch and retrain in one step:

```powershell
npm run label:import -- --file D:\Projects\YtbSongTracker\data\auto-label-batch-YYYY-MM-DDTHH-MM-SS-Z.json
```

Train only from the command line:

```powershell
npm run train:classifier
```

Or trigger training through the backend:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/classifier/train"
```

Check whether a model is ready:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/classifier/status"
```

Inspect pending auto-collected candidates:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/classifier/candidates?status=pending_label&limit=20"
```

This backend is still intentionally simple. It is a good local bridge for the extension, but you will still want a stronger app database and Spotify-library matching layer for your real site.


## Rate-limit testing

You can replay representative Spotify-search traffic through your backend with:

```powershell
npm run rate-test -- --rps 2 --duration 30
```

Optional flags:

- `--baseUrl http://localhost:3000`
- `--queries D:\Projects\YtbSongTracker\scripts\sample-queries.json`
- `--rps 1`
- `--duration 60`

This hits your local `/api/spotify/search` endpoint, not Spotify directly, so it exercises the same search flow your app uses and reports:

- total requests
- successful responses
- `429` responses
- `Retry-After` values
- average response time

Keep this test gentle. The goal is to understand your real query pattern and caching needs, not to hammer Spotify.
## Notes and limitations

- This only tracks listens from the browser where the extension is installed.
- `music.youtube.com` will usually produce cleaner metadata than regular YouTube.
- Video titles can still be noisy, even with the improved parser. Spotify verification is much better, but it still depends on the parser producing a usable candidate title and artist.
- The classifier only becomes useful after you label enough examples. Around 50-100 labels is enough to start experimenting, but a few hundred will be noticeably better.
- The manifest currently allows arbitrary backend URLs for convenience during development. Once your backend domain is fixed, you should narrow `host_permissions`.

