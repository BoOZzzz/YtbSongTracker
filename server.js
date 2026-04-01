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
const SPOTIFY_CACHE_PATH = path.join(DATA_DIR, "spotify-cache.json");
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

    if (req.method === "POST" && url.pathname === "/api/enrich/listen") {
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

      return sendJson(res, 200, {
        ok: true,
        result: buildEnrichmentResponse(record, payload)
      });
    }

    if (req.method === "POST" && (url.pathname === "/api/me/listens" || url.pathname === "/api/listens/youtube")) {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const payload = await readJson(req);
      const validationError = validateListenEvent(payload);
      if (validationError) {
        return sendJson(res, 400, { ok: false, error: validationError });
      }

      const record = await persistListenPayload(payload);
      const allEvents = readEvents();
      const { accepted } = dedupeIncomingEvents(allEvents, [record]);
      if (accepted.length) {
        writeEvents([...accepted, ...allEvents]);
      }

      return sendJson(res, 201, {
        ok: true,
        id: record.id,
        result: buildEnrichmentResponse(record, payload),
        persisted: accepted.length > 0
      });
    }

    if (req.method === "POST" && url.pathname === "/api/import/listens") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const payload = await readJson(req);

      try {
        const result = importListenHistory(payload);
        return sendJson(res, 201, {
          ok: true,
          ...result
        });
      } catch (error) {
        return sendJson(res, 400, {
          ok: false,
          error: error.message
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/listens") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const events = readEvents();
      const limit = clampNumber(url.searchParams.get("limit"), 20, 1, 200);
      return sendJson(res, 200, {
        ok: true,
        items: events.slice(0, limit)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/stats/top-songs") {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const events = readEvents();
      const limit = clampNumber(url.searchParams.get("limit"), 30, 1, 100);
      const minConfidence = clampNumber(url.searchParams.get("minConfidence"), 0.55, 0, 1);
      const monthParam = parseMonthParam(url.searchParams.get("month")) || parseMonthParam(getCurrentMonthKey());
      return sendJson(res, 200, buildStatsResponse(events, {
        limit,
        minConfidence,
        monthKey: monthParam?.key || null
      }));
    }

    if (req.method === "GET" && url.pathname === "/api/public/top-songs") {
      const events = readEvents();
      const limit = clampNumber(url.searchParams.get("limit"), 30, 1, 100);
      const minConfidence = clampNumber(url.searchParams.get("minConfidence"), 0.55, 0, 1);
      const monthParam = parseMonthParam(url.searchParams.get("month")) || parseMonthParam(getCurrentMonthKey());
      return sendJson(res, 200, buildStatsResponse(events, {
        limit,
        minConfidence,
        monthKey: monthParam?.key || null
      }));
    }

    if (req.method === "GET" && url.pathname === "/api/spotify/search") {
      const title = normalizeWhitespace(url.searchParams.get("title"));
      const artist = normalizeWhitespace(url.searchParams.get("artist"));
      const rawTitle = normalizeWhitespace(url.searchParams.get("rawTitle"));
      const result = await maybeVerifyWithSpotify({ title, artist, rawTitle });
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
  if (!fs.existsSync(SPOTIFY_CACHE_PATH)) {
    fs.writeFileSync(SPOTIFY_CACHE_PATH, `${JSON.stringify(createEmptySpotifyCache(), null, 2)}\n`, "utf8");
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
    const maxBodyBytes = 25 * 1024 * 1024;

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBodyBytes) {
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

  return finalizeListenRecord({
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
  });
}

async function persistListenPayload(payload) {
  const record = hasPreEnrichedListenFields(payload)
    ? finalizeListenRecord({
        ...payload,
        id: payload.id || crypto.randomUUID(),
        storedAt: new Date().toISOString()
      })
    : await enrichEvent(payload);

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

  return record;
}

function hasPreEnrichedListenFields(payload) {
  if (!payload || typeof payload !== "object") return false;
  return Boolean(
    payload.finalClassification ||
    payload.classifierPrediction ||
    payload.spotifyVerificationStatus ||
    payload.spotifyTrackUri ||
    payload.spotifyMatch
  );
}

function buildEnrichmentResponse(record, payload) {
  return {
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
  };
}

function computeTopSongs(events, options) {
  const filteredEvents = filterEventsForPeriod(events, options);
  const bySong = new Map();

  for (const event of filteredEvents) {
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
      sampleExternalUrl: event.externalUrl || event.spotifyExternalUrl || "",
      confidenceAverage: 0,
      confidenceSamples: 0,
      sourceTypes: {}
    };

    existing.playCount += 1;
    existing.totalListenedSeconds += Number(event.listenedSeconds || 0);
    existing.lastPlayedAt = existing.lastPlayedAt > event.capturedAt ? existing.lastPlayedAt : event.capturedAt;
    existing.sourceTypes[event.sourceType || "unknown"] = (existing.sourceTypes[event.sourceType || "unknown"] || 0) + 1;
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
  const cacheKey = buildSpotifyCacheKey(candidate);
  const cached = getCachedSpotifyVerification(cacheKey);
  if (cached) {
    return cached;
  }

  if (!candidate.title && !candidate.artist) {
    return {
      status: "skipped",
      match: null,
      candidates: []
    };
  }

  try {
    const result = await verifyTrackCandidate(candidate);
    setCachedSpotifyVerification(cacheKey, result);
    return result;
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

function parseMonthParam(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month, key: `${match[1]}-${match[2]}` };
}

function getCurrentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function filterEventsForPeriod(events, options) {
  if (!options.monthKey) {
    return events;
  }

  return events.filter((event) => String(event.capturedAt || "").slice(0, 7) === options.monthKey);
}

function buildStatsResponse(events, options) {
  const filteredEvents = filterEventsForPeriod(events, options);
  const items = computeTopSongs(filteredEvents, options);
  const sourceBreakdown = {};
  let totalTrackedEvents = 0;
  let totalListenedSeconds = 0;

  for (const event of filteredEvents) {
    const effectiveClassification = event.finalClassification || (event.isLikelyMusic ? "song" : "video");
    const effectiveConfidence = Number(event.finalConfidence ?? event.confidence ?? 0);
    if (effectiveClassification !== "song") continue;
    if (effectiveConfidence < options.minConfidence) continue;

    const sourceType = event.sourceType || "unknown";
    sourceBreakdown[sourceType] = (sourceBreakdown[sourceType] || 0) + 1;
    totalTrackedEvents += 1;
    totalListenedSeconds += Number(event.listenedSeconds || 0);
  }

  return {
    ok: true,
    period: {
      month: options.monthKey || null,
      label: options.monthKey || "all-time"
    },
    summary: {
      trackedSongs: items.length,
      totalTrackedEvents,
      totalListenedSeconds,
      sources: sourceBreakdown
    },
    items
  };
}

function finalizeListenRecord(record) {
  const normalizedArtist = normalizeWhitespace(record.normalizedArtist || "");
  const normalizedTitle = normalizeWhitespace(record.normalizedTitle || record.rawTitle || "");
  const canonicalKey = record.canonicalKey || buildCanonicalKey(normalizedArtist, normalizedTitle);
  const capturedAt = normalizeCapturedAt(record.capturedAt);

  const finalized = {
    ...record,
    source: record.source || record.sourceType || "unknown",
    sourceType: record.sourceType || "unknown",
    normalizedArtist,
    normalizedTitle,
    canonicalKey,
    capturedAt,
    storedAt: normalizeCapturedAt(record.storedAt || new Date().toISOString()),
    listenedSeconds: Number(record.listenedSeconds || 0),
    durationSeconds: Number(record.durationSeconds || 0),
    progressPercent: Number(record.progressPercent || 0),
    thresholdSeconds: Number(record.thresholdSeconds || 0),
    confidence: Number(record.confidence || 0),
    finalConfidence: Number(record.finalConfidence ?? record.confidence ?? 0),
    isImported: Boolean(record.isImported),
    rawDescription: String(record.rawDescription || ""),
    rawChannelName: String(record.rawChannelName || ""),
    spotifyTrackId: String(record.spotifyTrackId || ""),
    spotifyTrackUri: String(record.spotifyTrackUri || ""),
    spotifyExternalUrl: String(record.spotifyExternalUrl || record.spotifyMatch?.externalUrl || ""),
    externalUrl: String(record.externalUrl || record.spotifyExternalUrl || "")
  };

  finalized.eventFingerprint = buildEventFingerprint(finalized);
  return finalized;
}

function normalizeCapturedAt(value) {
  const input = String(value || "").trim();
  if (!input) return new Date().toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function buildEventFingerprint(record) {
  const fingerprintSeed = [
    record.sourceType || "",
    record.videoId || "",
    record.spotifyTrackUri || "",
    record.normalizedArtist || record.rawChannelName || "",
    record.normalizedTitle || record.rawTitle || "",
    record.capturedAt || "",
    String(record.listenedSeconds || 0)
  ].join("||");

  return crypto.createHash("sha1").update(fingerprintSeed).digest("hex");
}

function dedupeIncomingEvents(existingEvents, incomingEvents) {
  const seen = new Set(existingEvents.map((event) => event.eventFingerprint || buildEventFingerprint(event)));
  const accepted = [];
  let skipped = 0;

  for (const event of incomingEvents) {
    const fingerprint = event.eventFingerprint || buildEventFingerprint(event);
    if (seen.has(fingerprint)) {
      skipped += 1;
      continue;
    }

    seen.add(fingerprint);
    accepted.push({
      ...event,
      eventFingerprint: fingerprint
    });
  }

  return { accepted, skipped };
}

function importListenHistory(payload) {
  const source = normalizeWhitespace(payload?.source || "spotify");
  const fileName = normalizeWhitespace(payload?.fileName || "");
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

  if (!records.length) {
    throw new Error("Import payload must include a non-empty items array");
  }

  const normalized = [];
  const rejected = [];

  for (const item of records) {
    const result = normalizeImportedListen(item, { source, fileName });
    if (result) {
      normalized.push(result);
    } else {
      rejected.push(item);
    }
  }

  const existingEvents = readEvents();
  const { accepted, skipped } = dedupeIncomingEvents(existingEvents, normalized);
  if (accepted.length) {
    writeEvents([...accepted, ...existingEvents]);
  }

  return {
    importedCount: accepted.length,
    skippedDuplicates: skipped,
    rejectedCount: rejected.length,
    sampleRejected: rejected.slice(0, 3)
  };
}

function normalizeImportedListen(item, context) {
  if (!item || typeof item !== "object") return null;

  const spotifyExtendedTitle = normalizeWhitespace(item.master_metadata_track_name);
  const spotifyExtendedArtist = normalizeWhitespace(item.master_metadata_album_artist_name);
  const spotifyLegacyTitle = normalizeWhitespace(item.trackName);
  const spotifyLegacyArtist = normalizeWhitespace(item.artistName);
  const title = spotifyExtendedTitle || spotifyLegacyTitle;
  const artist = spotifyExtendedArtist || spotifyLegacyArtist;
  const listenedMs = Number(item.ms_played ?? item.msPlayed ?? 0);
  const timestamp = normalizeImportedTimestamp(item);

  if (!title || !timestamp || listenedMs <= 0) {
    return null;
  }

  const spotifyTrackUri = normalizeWhitespace(item.spotify_track_uri || item.spotifyTrackUri || "");
  const spotifyTrackId = spotifyTrackUri.startsWith("spotify:track:") ? spotifyTrackUri.slice("spotify:track:".length) : "";
  const normalizedTitle = title;
  const normalizedArtist = artist;

  return finalizeListenRecord({
    id: crypto.randomUUID(),
    source: "spotify_import",
    sourceType: "spotify_import",
    rawTitle: title,
    rawChannelName: artist,
    rawDescription: "",
    parserTitle: title,
    parserArtist: artist,
    normalizedTitle,
    normalizedArtist,
    confidence: 1,
    isLikelyMusic: true,
    parsingStrategy: "imported_json",
    variantType: "",
    listenedSeconds: Math.max(1, Math.round(listenedMs / 1000)),
    durationSeconds: 0,
    progressPercent: 0,
    thresholdSeconds: 0,
    capturedAt: timestamp,
    storedAt: new Date().toISOString(),
    canonicalKey: spotifyTrackUri ? spotifyTrackUri : buildCanonicalKey(normalizedArtist, normalizedTitle),
    matchStatus: spotifyTrackUri ? "spotify_imported" : "imported",
    spotifyVerificationStatus: "imported",
    spotifyCandidates: [],
    spotifyQueries: [],
    spotifyMatch: spotifyTrackUri
      ? {
          id: spotifyTrackId,
          uri: spotifyTrackUri,
          title: normalizedTitle,
          artist: normalizedArtist,
          album: normalizeWhitespace(item.master_metadata_album_album_name || item.albumName || ""),
          externalUrl: spotifyTrackId ? `https://open.spotify.com/track/${spotifyTrackId}` : ""
        }
      : null,
    spotifyTrackId,
    spotifyTrackUri,
    spotifyExternalUrl: spotifyTrackId ? `https://open.spotify.com/track/${spotifyTrackId}` : "",
    classifierPrediction: null,
    finalClassification: "song",
    finalConfidence: 1,
    isImported: true,
    importSource: context.source,
    importFileName: context.fileName,
    importFormat: detectImportFormat(item),
    platform: normalizeWhitespace(item.platform || ""),
    reasonEnd: normalizeWhitespace(item.reason_end || ""),
    reasonStart: normalizeWhitespace(item.reason_start || "")
  });
}

function normalizeImportedTimestamp(item) {
  const timestamp = normalizeWhitespace(item.ts || item.endTime || item.playedAt || item.capturedAt || "");
  if (!timestamp) return "";

  if (item.endTime && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(item.endTime)) {
    return new Date(`${item.endTime}:00Z`).toISOString();
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
}

function detectImportFormat(item) {
  if (Object.prototype.hasOwnProperty.call(item, "master_metadata_track_name")) {
    return "spotify_extended_streaming_history";
  }
  if (Object.prototype.hasOwnProperty.call(item, "trackName")) {
    return "spotify_streaming_history";
  }
  return "generic_json";
}

function createEmptySpotifyCache() {
  return {
    version: 1,
    entries: {}
  };
}

function readSpotifyCache() {
  try {
    const raw = fs.readFileSync(SPOTIFY_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || !parsed.entries || typeof parsed.entries !== "object") {
      return createEmptySpotifyCache();
    }
    return parsed;
  } catch (error) {
    return createEmptySpotifyCache();
  }
}

function writeSpotifyCache(cache) {
  fs.writeFileSync(SPOTIFY_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function buildSpotifyCacheKey(candidate) {
  const title = normalizeWhitespace(candidate.title || "");
  const artist = normalizeWhitespace(candidate.artist || "");
  const rawTitle = normalizeWhitespace(candidate.rawTitle || "");
  return [title.toLowerCase(), artist.toLowerCase(), rawTitle.toLowerCase()].join("||");
}

function getCachedSpotifyVerification(cacheKey) {
  if (!cacheKey) return null;
  const cache = readSpotifyCache();
  const entry = cache.entries[cacheKey];
  if (!entry || !entry.result) return null;
  entry.lastAccessedAt = new Date().toISOString();
  writeSpotifyCache(cache);
  return entry.result;
}

function setCachedSpotifyVerification(cacheKey, result) {
  if (!cacheKey) return;
  const cache = readSpotifyCache();
  cache.entries[cacheKey] = {
    cachedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    result
  };
  writeSpotifyCache(cache);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}
