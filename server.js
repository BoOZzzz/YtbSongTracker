require("./env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { verifyTrackCandidate } = require("./spotify");
const {
  DEFAULT_LABELS_PATH,
  DEFAULT_MODEL_PATH,
  DEFAULT_CANDIDATES_PATH,
  ensureClassifierStorage,
  readLabels,
  readCandidates,
  upsertLabel,
  upsertCandidate,
  readModel,
  writeModel,
  writeCandidates,
  trainClassifier,
  predictClassification,
  createLabelBatch,
  markCandidatesInBatch
} = require("./classifier");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const EVENTS_PATH = path.join(DATA_DIR, "listen-events.json");
const API_TOKEN = process.env.YTB_TRACKER_API_TOKEN || "";

ensureStorage();
ensureClassifierStorage();

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/classifier/status") {
      const labels = readLabels(DEFAULT_LABELS_PATH);
      const model = readModel(DEFAULT_MODEL_PATH);
      return sendJson(res, 200, {
        ok: true,
        labelsCount: labels.length,
        model: {
          trainedAt: model.trainedAt || null,
          sampleCount: Number(model.sampleCount || 0),
          trainingAccuracy: model.metrics?.trainingAccuracy ?? null
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/classifier/labels") {
      const labels = readLabels(DEFAULT_LABELS_PATH);
      const limit = clampNumber(url.searchParams.get("limit"), 50, 1, 500);
      return sendJson(res, 200, {
        ok: true,
        items: labels.slice(0, limit)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/classifier/labels") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const payload = await readJson(req);
      let record;

      try {
        record = upsertLabel(payload, DEFAULT_LABELS_PATH);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }

      return sendJson(res, 201, {
        ok: true,
        item: record
      });
    }

    if (req.method === "POST" && url.pathname === "/api/classifier/train") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const labels = readLabels(DEFAULT_LABELS_PATH);
      const model = trainClassifier(labels);
      writeModel(model, DEFAULT_MODEL_PATH);
      return sendJson(res, 200, {
        ok: true,
        model: {
          trainedAt: model.trainedAt,
          sampleCount: model.sampleCount,
          trainingAccuracy: model.metrics.trainingAccuracy
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/classifier/candidates") {
      const candidates = readCandidates(DEFAULT_CANDIDATES_PATH);
      const limit = clampNumber(url.searchParams.get("limit"), 50, 1, 500);
      const status = normalizeWhitespace(url.searchParams.get("status"));
      const filtered = status ? candidates.filter((item) => String(item.status || "") === status) : candidates;
      return sendJson(res, 200, {
        ok: true,
        items: filtered.slice(0, limit)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/classifier/batches/next") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const payload = await readJson(req);
      const limit = clampNumber(payload.limit, 20, 1, 200);
      const batchId = normalizeWhitespace(payload.batchId) || undefined;
      const candidates = readCandidates(DEFAULT_CANDIDATES_PATH);
      const batch = createLabelBatch(candidates, { limit, batchId });
      const updatedCandidates = markCandidatesInBatch(candidates, batch);
      writeCandidates(updatedCandidates, DEFAULT_CANDIDATES_PATH);

      return sendJson(res, 200, {
        ok: true,
        batchId: batch[0]?.batchId || batchId || "",
        items: batch
      });
    }

    if (req.method === "POST" && url.pathname === "/api/classifier/candidates/collect") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const payload = await readJson(req);
      if (!payload.videoId || !payload.rawTitle) {
        return sendJson(res, 400, { ok: false, error: "videoId and rawTitle are required" });
      }

      const classifierPrediction = predictClassification(payload, readModel(DEFAULT_MODEL_PATH));
      const candidate = upsertCandidate({
        ...payload,
        classifierPrediction,
        finalClassification: classifierPrediction?.label || payload.parserClassification || "",
        finalConfidence: Number(classifierPrediction?.confidence ?? payload.parserConfidence ?? 0)
      }, DEFAULT_CANDIDATES_PATH);

      return sendJson(res, 201, {
        ok: true,
        item: candidate
      });
    }

    if (req.method === "POST" && url.pathname === "/api/listens/youtube") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const payload = await readJson(req);
      const validationError = validateListenEvent(payload);
      if (validationError) {
        return sendJson(res, 400, { ok: false, error: validationError });
      }

      const record = await enrichEvent(payload);
      upsertCandidate({
        videoId: record.videoId,
        videoUrl: record.videoUrl,
        pageUrl: record.pageUrl,
        rawTitle: record.rawTitle,
        rawChannelName: record.rawChannelName,
        rawDescription: record.rawDescription,
        sourcePage: record.source,
        parserClassification: payload.isLikelyMusic ? "song" : "video",
        parserConfidence: Number(payload.confidence || 0),
        variantType: record.variantType,
        listenedSeconds: record.listenedSeconds,
        durationSeconds: record.durationSeconds,
        progressPercent: record.progressPercent,
        capturedAt: record.capturedAt,
        classifierPrediction: record.classifierPrediction,
        finalClassification: record.finalClassification,
        finalConfidence: record.finalConfidence
      }, DEFAULT_CANDIDATES_PATH);
      const allEvents = readEvents();
      allEvents.unshift(record);
      writeEvents(allEvents);

      return sendJson(res, 201, {
        ok: true,
        id: record.id,
        matchedKey: record.canonicalKey,
        matchStatus: record.matchStatus,
        spotifyMatch: record.spotifyMatch,
        spotifyVerificationStatus: record.spotifyVerificationStatus,
        spotifyQueries: record.spotifyQueries,
        spotifyCandidates: record.spotifyCandidates,
        parserClassification: payload.isLikelyMusic ? "song" : "video",
        parserConfidence: Number(payload.confidence || 0),
        classifierPrediction: record.classifierPrediction,
        variantType: record.variantType,
        finalClassification: record.finalClassification,
        finalConfidence: record.finalConfidence
      });
    }

    if (req.method === "GET" && url.pathname === "/api/listens") {
      const events = readEvents();
      const limit = clampNumber(url.searchParams.get("limit"), 20, 1, 200);
      return sendJson(res, 200, {
        ok: true,
        items: events.slice(0, limit)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/stats/top-songs") {
      const events = readEvents();
      const limit = clampNumber(url.searchParams.get("limit"), 10, 1, 100);
      const minConfidence = clampNumber(url.searchParams.get("minConfidence"), 0.55, 0, 1);
      const items = computeTopSongs(events, { limit, minConfidence });
      return sendJson(res, 200, {
        ok: true,
        items
      });
    }

    if (req.method === "GET" && url.pathname === "/api/spotify/search") {
      const title = normalizeWhitespace(url.searchParams.get("title"));
      const artist = normalizeWhitespace(url.searchParams.get("artist"));
      const rawTitle = normalizeWhitespace(url.searchParams.get("rawTitle"));
      const result = await verifyTrackCandidate({ title, artist, rawTitle });
      return sendJson(res, 200, {
        ok: true,
        query: { title, artist, rawTitle },
        result
      });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error("[Ytb Song Tracker] Backend error", error);
    return sendJson(res, 500, {
      ok: false,
      error: "Internal server error"
    });
  }
});

server.listen(PORT, () => {
  console.log(`[Ytb Song Tracker] Backend listening on http://localhost:${PORT}`);
});

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_PATH)) {
    fs.writeFileSync(EVENTS_PATH, "[]\n", "utf8");
  }
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_TOKEN}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function validateListenEvent(payload) {
  if (!payload || typeof payload !== "object") return "Invalid payload";
  if (!payload.videoId) return "videoId is required";
  if (!payload.rawTitle) return "rawTitle is required";
  if (!payload.sourceType) return "sourceType is required";
  if (!payload.capturedAt) return "capturedAt is required";
  return "";
}

async function enrichEvent(payload) {
  const parsedTitle = normalizeWhitespace(payload.normalizedTitle || payload.rawTitle);
  const parsedArtist = normalizeWhitespace(payload.normalizedArtist || "");
  const classifierPrediction = predictClassification(payload, readModel(DEFAULT_MODEL_PATH));
  const spotifyVerification = await maybeVerifyWithSpotify({
    title: parsedTitle,
    artist: parsedArtist,
    rawTitle: payload.rawTitle
  });
  const canonicalTitle = spotifyVerification.match?.title || parsedTitle;
  const canonicalArtist = spotifyVerification.match?.artist || parsedArtist;
  const canonicalKey = buildCanonicalKey(canonicalArtist, canonicalTitle);

  return {
    id: crypto.randomUUID(),
    source: payload.source,
    sourceType: payload.sourceType,
    videoId: payload.videoId,
    videoUrl: payload.videoUrl,
    pageUrl: payload.pageUrl,
    rawTitle: payload.rawTitle,
    rawChannelName: payload.rawChannelName || "",
    rawDescription: payload.rawDescription || "",
    parserTitle: parsedTitle,
    parserArtist: parsedArtist,
    normalizedTitle: canonicalTitle,
    normalizedArtist: canonicalArtist,
    confidence: Number(payload.confidence || 0),
    isLikelyMusic: Boolean(payload.isLikelyMusic),
    parsingStrategy: payload.parsingStrategy || "unknown",
    variantType: payload.variantType || "",
    listenedSeconds: Number(payload.listenedSeconds || 0),
    durationSeconds: Number(payload.durationSeconds || 0),
    progressPercent: Number(payload.progressPercent || 0),
    thresholdSeconds: Number(payload.thresholdSeconds || 0),
    capturedAt: payload.capturedAt,
    storedAt: new Date().toISOString(),
    canonicalKey,
    matchStatus: getMatchStatus(spotifyVerification, canonicalArtist),
    spotifyVerificationStatus: spotifyVerification.status,
    spotifyCandidates: spotifyVerification.candidates,
    spotifyQueries: spotifyVerification.queries || [],
    spotifyMatch: spotifyVerification.match,
    spotifyTrackId: spotifyVerification.match?.id || "",
    spotifyTrackUri: spotifyVerification.match?.uri || "",
    classifierPrediction,
    finalClassification: decideFinalClassification(payload, spotifyVerification, classifierPrediction),
    finalConfidence: decideFinalConfidence(payload, spotifyVerification, classifierPrediction)
  };
}

function computeTopSongs(events, options) {
  const bySong = new Map();

  for (const event of events) {
    const effectiveClassification = event.finalClassification || (event.isLikelyMusic ? "song" : "video");
    const effectiveConfidence = Number(event.finalConfidence ?? event.confidence ?? 0);
    if (effectiveClassification !== "song") continue;
    if (effectiveConfidence < options.minConfidence) continue;

    const key = event.canonicalKey || buildCanonicalKey(event.normalizedArtist, event.normalizedTitle);
    if (!key) continue;

    const existing = bySong.get(key) || {
      canonicalKey: key,
      title: event.normalizedTitle || event.rawTitle,
      artist: event.normalizedArtist || "",
      spotifyTrackId: event.spotifyTrackId || "",
      spotifyTrackUri: event.spotifyTrackUri || "",
      playCount: 0,
      totalListenedSeconds: 0,
      lastPlayedAt: event.capturedAt,
      sampleVideoUrl: event.videoUrl,
      confidenceAverage: 0,
      confidenceSamples: 0
    };

    existing.playCount += 1;
    existing.totalListenedSeconds += Number(event.listenedSeconds || 0);
    existing.lastPlayedAt = existing.lastPlayedAt > event.capturedAt ? existing.lastPlayedAt : event.capturedAt;
    existing.confidenceSamples += 1;
    existing.confidenceAverage = Number(
      (
        (existing.confidenceAverage * (existing.confidenceSamples - 1) + effectiveConfidence) /
        existing.confidenceSamples
      ).toFixed(3)
    );

    bySong.set(key, existing);
  }

  return Array.from(bySong.values())
    .sort((a, b) => {
      if (b.playCount !== a.playCount) return b.playCount - a.playCount;
      return b.lastPlayedAt.localeCompare(a.lastPlayedAt);
    })
    .slice(0, options.limit);
}

function readEvents() {
  const raw = fs.readFileSync(EVENTS_PATH, "utf8");
  return JSON.parse(raw || "[]");
}

function writeEvents(events) {
  fs.writeFileSync(EVENTS_PATH, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

function buildCanonicalKey(artist, title) {
  const normalizedArtist = slugify(artist);
  const normalizedTitle = slugify(title);
  if (!normalizedTitle) return "";
  return normalizedArtist ? `${normalizedArtist}::${normalizedTitle}` : normalizedTitle;
}

async function maybeVerifyWithSpotify(candidate) {
  if (!candidate.title && !candidate.artist) {
    return {
      status: "skipped",
      match: null,
      candidates: []
    };
  }

  try {
    return await verifyTrackCandidate(candidate);
  } catch (error) {
    console.error("[Ytb Song Tracker] Spotify verification failed", error.message);
    return {
      status: "error",
      match: null,
      candidates: []
    };
  }
}

function getMatchStatus(spotifyVerification, canonicalArtist) {
  if (spotifyVerification.match) return "spotify_matched";
  if (canonicalArtist) return "parsed";
  return "unresolved";
}

function decideFinalClassification(payload, spotifyVerification, classifierPrediction) {
  if (spotifyVerification.match) return "song";

  if (classifierPrediction?.label === "song" && shouldTrustClassifierSongOverride(payload, classifierPrediction)) {
    return "song";
  }

  if (classifierPrediction?.label === "video") {
    return "video";
  }

  return (payload.isLikelyMusic || payload.variantType) ? "song" : "video";
}

function decideFinalConfidence(payload, spotifyVerification, classifierPrediction) {
  if (spotifyVerification.match?.score) {
    return Number(spotifyVerification.match.score.toFixed(3));
  }

  if (classifierPrediction?.label === "song" && shouldTrustClassifierSongOverride(payload, classifierPrediction)) {
    return classifierPrediction.confidence;
  }

  if (classifierPrediction?.label === "video" && classifierPrediction?.confidence) {
    return classifierPrediction.confidence;
  }

  return Number(Number(payload.confidence || 0).toFixed(3));
}

function shouldTrustClassifierSongOverride(payload, classifierPrediction) {
  if (!classifierPrediction || classifierPrediction.label !== "song") return false;
  if ((payload.source || payload.sourcePage || "").includes("music.youtube.com")) return true;
  if (payload.isLikelyMusic) return true;
  if (payload.variantType) return true;

  const parserConfidence = Number(payload.confidence || 0);
  const classifierConfidence = Number(classifierPrediction.confidence || 0);
  const rawTitle = String(payload.rawTitle || "");
  const hasStrongTitleMarker =
    /\blyric\s+video\b|\bofficial\s+(music\s+)?video\b|\bofficial\s+audio\b|\bvisualizer\b|\bremix\b|\bcover\b|\blive\b/i.test(rawTitle);

  if (parserConfidence < 0.35) {
    return classifierConfidence >= 0.97 && hasStrongTitleMarker;
  }

  return classifierConfidence >= 0.8;
}

function slugify(value) {
  return normalizeWhitespace((value || "").toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}
