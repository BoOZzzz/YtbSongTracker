importScripts("parser.js", "tracker-storage.js");

const DEFAULT_SETTINGS = {
  backendUrl: "",
  syncBackendUrl: "",
  apiKey: "",
  listenThresholdSec: 30,
  minProgressPercent: 0.5,
  debug: false
};
const backendHealthCache = {
  checkedAt: 0,
  backendBaseUrl: "",
  isHealthy: false
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(existing);

  if (reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRACK_LISTEN_EVENT") {
    handleListenEvent(message.payload, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        console.error("Failed to process listen event", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message?.type === "COLLECT_CLASSIFIER_CANDIDATE") {
    handleClassifierCandidate(message.payload, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        console.error("Failed to collect classifier candidate", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message?.type === "GET_SETTINGS") {
    chrome.storage.sync.get(DEFAULT_SETTINGS).then((settings) => sendResponse(settings));
    return true;
  }

  if (message?.type === "GET_TOP_SONGS") {
    handleGetTopSongs(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_LISTEN_HISTORY") {
    handleGetListenHistory(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_TOP_VIDEOS") {
    handleGetTopVideos(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "IMPORT_LISTEN_HISTORY") {
    importListenHistory(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "UPDATE_CLASSIFICATION_OVERRIDE") {
    updateClassificationOverride(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function handleListenEvent(payload, sender) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const parsed = SongTrackerParser.parseVideoMetadata(payload);
  const listenEvent = {
    source: payload.sourcePage,
    sourcePage: payload.sourcePage,
    sourceType: payload.sourcePage.includes("music") ? "youtube_music" : "youtube",
    sessionId: payload.sessionId,
    videoId: payload.videoId,
    videoUrl: payload.videoUrl,
    pageUrl: sender?.tab?.url || payload.videoUrl,
    rawTitle: payload.title,
    rawChannelName: payload.channelName,
    rawDescription: payload.description || "",
    normalizedTitle: parsed.normalizedTitle,
    normalizedArtist: parsed.normalizedArtist,
    confidence: parsed.confidence,
    isLikelyMusic: parsed.isLikelyMusic,
    parsingStrategy: parsed.parsingStrategy,
    variantType: parsed.variantType,
    listenedSeconds: payload.listenedSeconds,
    durationSeconds: payload.durationSeconds,
    progressPercent: payload.progressPercent,
    thresholdSeconds: settings.listenThresholdSec,
    capturedAt: new Date().toISOString()
  };

  const responseBody = await enrichWithBackendLookup(settings, listenEvent);
  const record = SongTrackerStorage.createListenRecord({
    ...listenEvent,
    normalizedTitle: responseBody?.spotifyMatch?.title || listenEvent.normalizedTitle,
    normalizedArtist: responseBody?.spotifyMatch?.artist || listenEvent.normalizedArtist,
    canonicalKey: buildCanonicalKey(
      responseBody?.spotifyMatch?.artist || listenEvent.normalizedArtist,
      responseBody?.spotifyMatch?.title || listenEvent.normalizedTitle || listenEvent.rawTitle
    ),
    matchStatus: responseBody?.matchStatus || (responseBody?.spotifyMatch ? "spotify_matched" : (listenEvent.normalizedArtist ? "parsed" : "unresolved")),
    spotifyVerificationStatus: responseBody?.spotifyVerificationStatus || responseBody?.status || (settings.backendUrl ? "not_checked" : "backend_unconfigured"),
    spotifyCandidates: responseBody?.spotifyCandidates || responseBody?.candidates || [],
    spotifyQueries: responseBody?.spotifyQueries || responseBody?.queries || [],
    spotifyMatch: responseBody?.spotifyMatch || responseBody?.match || null,
    spotifyTrackId: responseBody?.spotifyMatch?.id || responseBody?.match?.id || "",
    spotifyTrackUri: responseBody?.spotifyMatch?.uri || responseBody?.match?.uri || "",
    spotifyExternalUrl: responseBody?.spotifyMatch?.externalUrl || responseBody?.match?.externalUrl || "",
    classifierPrediction: responseBody?.classifierPrediction || null,
    finalClassification: responseBody?.finalClassification || ((responseBody?.spotifyMatch || responseBody?.match || listenEvent.isLikelyMusic) ? "song" : "video"),
    finalConfidence: responseBody?.finalConfidence ?? responseBody?.spotifyMatch?.score ?? listenEvent.confidence
  });
  logDebug(settings, "Prepared listen record before IndexedDB merge", {
    videoId: record.videoId,
    sessionId: record.sessionId,
    listenedSeconds: record.listenedSeconds,
    durationSeconds: record.durationSeconds,
    progressPercent: record.progressPercent,
    eventFingerprint: record.eventFingerprint,
    finalClassification: record.finalClassification,
    matchStatus: record.matchStatus
  });
  const stored = await SongTrackerStorage.putListen(record);
  logDebug(settings, "IndexedDB merge result", {
    videoId: stored.record.videoId,
    sessionId: stored.record.sessionId,
    inserted: stored.inserted,
    listenedSeconds: stored.record.listenedSeconds,
    durationSeconds: stored.record.durationSeconds,
    progressPercent: stored.record.progressPercent,
    eventFingerprint: stored.record.eventFingerprint,
    finalClassification: stored.record.finalClassification
  });
  const syncResult = await syncPrivateListenRecord(settings, stored.record);

  logDebug(settings, "Delivered listen event", {
    videoId: listenEvent.videoId,
    backendUrl: settings.backendUrl || "",
    syncBackendUrl: settings.syncBackendUrl || "",
    parserClassification: listenEvent.isLikelyMusic ? "song" : "video",
    parserConfidence: listenEvent.confidence,
    variantType: listenEvent.variantType || "",
    finalClassification: stored.record.finalClassification || (listenEvent.isLikelyMusic ? "song" : "video"),
    finalConfidence: stored.record.finalConfidence ?? listenEvent.confidence,
    matchStatus: stored.record.matchStatus || "unknown",
    spotifyVerificationStatus: stored.record.spotifyVerificationStatus || "unknown",
    spotifyQueries: stored.record.spotifyQueries || [],
    spotifyMatch: stored.record.spotifyMatch || null,
    syncResult
  });

  return {
    stored: true,
    inserted: stored.inserted,
    synced: syncResult.synced,
    confidence: parsed.confidence,
    finalClassification: stored.record.finalClassification || (listenEvent.isLikelyMusic ? "song" : "video"),
    finalConfidence: stored.record.finalConfidence ?? parsed.confidence
  };
}

async function handleClassifierCandidate(payload, sender) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const parsed = SongTrackerParser.parseVideoMetadata(payload);
  const candidate = {
    source: payload.sourcePage,
    sourcePage: payload.sourcePage,
    sourceType: payload.sourcePage.includes("music") ? "youtube_music" : "youtube",
    videoId: payload.videoId,
    videoUrl: payload.videoUrl,
    pageUrl: sender?.tab?.url || payload.videoUrl,
    rawTitle: payload.title,
    rawChannelName: payload.channelName,
    rawDescription: payload.description || "",
    normalizedTitle: parsed.normalizedTitle,
    normalizedArtist: parsed.normalizedArtist,
    parserClassification: parsed.isLikelyMusic ? "song" : "video",
    parserConfidence: parsed.confidence,
    parsingStrategy: parsed.parsingStrategy,
    variantType: parsed.variantType,
    capturedAt: new Date().toISOString()
  };

  if (!settings.backendUrl) {
    return { queued: false, reason: "Missing backendUrl" };
  }

  const backendHealthy = await isBackendHealthy(settings);
  if (!backendHealthy) {
    logDebug(settings, "Skipped classifier candidate because backend is unavailable", {
      videoId: candidate.videoId,
      backendUrl: settings.backendUrl
    });
    return { collected: false, reason: "Backend unavailable" };
  }

  const response = await fetch(buildCandidateCollectionUrl(settings.backendUrl), {
    method: "POST",
    headers: buildHeaders(settings),
    body: JSON.stringify(candidate)
  });

  if (!response.ok) {
    throw new Error(`Candidate endpoint responded with ${response.status}`);
  }

  return { collected: true };
}

async function handleGetTopSongs(payload) {
  const monthKey = normalizeMonthKey(payload?.month);
  return SongTrackerStorage.getTopSongs({
    limit: Number(payload?.limit || 30),
    minConfidence: Number(payload?.minConfidence ?? 0.55),
    monthKey
  });
}

async function handleGetListenHistory(payload) {
  const history = await SongTrackerStorage.getListenHistory({
    monthKey: payload?.month || ""
  });

  return {
    items: history
  };
}

async function handleGetTopVideos(payload) {
  const monthKey = normalizeMonthKey(payload?.month);
  return SongTrackerStorage.getTopVideos({
    monthKey,
    minConfidence: Number(payload?.minConfidence ?? 0.55)
  });
}

async function importListenHistory(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    throw new Error("Import payload must include a non-empty items array");
  }

  const normalized = items
    .map((item) => normalizeImportedListen(item, {
      source: payload?.source || "spotify",
      fileName: payload?.fileName || ""
    }))
    .filter(Boolean);

  return SongTrackerStorage.bulkImport(normalized, {
    source: payload?.source || "spotify",
    fileName: payload?.fileName || ""
  });
}

async function updateClassificationOverride(payload) {
  return SongTrackerStorage.updateClassificationOverride({
    groupKey: payload?.groupKey,
    classification: payload?.classification
  });
}

async function isBackendHealthy(settings) {
  const backendBaseUrl = getBackendBaseUrl(settings.backendUrl);
  if (!backendBaseUrl) return false;

  const now = Date.now();
  const cacheTtlMs = backendHealthCache.isHealthy ? 30_000 : 8_000;
  if (
    backendHealthCache.backendBaseUrl === backendBaseUrl &&
    now - backendHealthCache.checkedAt < cacheTtlMs
  ) {
    return backendHealthCache.isHealthy;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`${backendBaseUrl}/health`, {
      method: "GET",
      headers: buildHeaders(settings),
      signal: controller.signal
    });

    backendHealthCache.checkedAt = now;
    backendHealthCache.backendBaseUrl = backendBaseUrl;
    backendHealthCache.isHealthy = response.ok;
    return response.ok;
  } catch (error) {
    backendHealthCache.checkedAt = now;
    backendHealthCache.backendBaseUrl = backendBaseUrl;
    backendHealthCache.isHealthy = false;
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildHeaders(settings) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  return headers;
}

function buildCandidateCollectionUrl(listensEndpoint) {
  const url = new URL(getBackendBaseUrl(listensEndpoint));
  url.pathname = "/api/classifier/candidates/collect";
  url.search = "";
  return url.toString();
}

function buildEnrichmentUrl(backendEndpoint) {
  const url = new URL(getBackendBaseUrl(backendEndpoint));
  url.pathname = "/api/enrich/listen";
  url.search = "";
  return url.toString();
}

function buildPrivateSyncUrl(syncEndpoint) {
  const url = new URL(getBackendBaseUrl(syncEndpoint));
  url.pathname = "/api/me/listens";
  url.search = "";
  return url.toString();
}

function getBackendBaseUrl(listensEndpoint) {
  try {
    const url = new URL(listensEndpoint);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    return "";
  }
}

async function enrichWithBackendLookup(settings, listenEvent) {
  if (!settings.backendUrl) {
    return null;
  }

  const backendHealthy = await isBackendHealthy(settings);
  if (!backendHealthy) {
    return null;
  }

  const lookupUrl = buildEnrichmentUrl(settings.backendUrl);

  try {
    const response = await fetch(lookupUrl, {
      method: "POST",
      headers: buildHeaders(settings),
      body: JSON.stringify(listenEvent)
    });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    return payload?.result || null;
  } catch (error) {
    logDebug(settings, "Listen enrichment failed", {
      videoId: listenEvent.videoId,
      message: error.message
    });
    return null;
  }
}

async function syncPrivateListenRecord(settings, record) {
  if (!settings.syncBackendUrl) {
    return { synced: false, reason: "sync_unconfigured" };
  }

  const backendHealthy = await isBackendHealthy({
    ...settings,
    backendUrl: settings.syncBackendUrl
  });
  if (!backendHealthy) {
    await appendToQueue({
      type: "private_listen_sync",
      syncBackendUrl: settings.syncBackendUrl,
      record
    });
    return { synced: false, reason: "backend_unavailable" };
  }

  try {
    const response = await fetch(buildPrivateSyncUrl(settings.syncBackendUrl), {
      method: "POST",
      headers: buildHeaders(settings),
      body: JSON.stringify(record)
    });

    if (!response.ok) {
      await appendToQueue({
        type: "private_listen_sync",
        syncBackendUrl: settings.syncBackendUrl,
        record,
        status: response.status
      });
      return { synced: false, reason: `http_${response.status}` };
    }

    return { synced: true };
  } catch (error) {
    await appendToQueue({
      type: "private_listen_sync",
      syncBackendUrl: settings.syncBackendUrl,
      record,
      error: error.message
    });
    return { synced: false, reason: "network_error" };
  }
}

function normalizeMonthKey(value) {
  const month = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(month) ? month : getCurrentLocalMonthKey();
}

function buildCanonicalKey(artist, title) {
  const normalizedArtist = slugify(artist);
  const normalizedTitle = slugify(title);
  if (!normalizedTitle) return "";
  return normalizedArtist ? `${normalizedArtist}::${normalizedTitle}` : normalizedTitle;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
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
  const capturedAt = normalizeImportedTimestamp(item);

  if (!title || !capturedAt || listenedMs <= 0) {
    return null;
  }

  const spotifyTrackUri = normalizeWhitespace(item.spotify_track_uri || item.spotifyTrackUri || "");
  const spotifyTrackId = spotifyTrackUri.startsWith("spotify:track:") ? spotifyTrackUri.slice("spotify:track:".length) : "";

  return {
    source: "spotify_import",
    sourceType: "spotify_import",
    rawTitle: title,
    rawChannelName: artist,
    rawDescription: "",
    parserTitle: title,
    parserArtist: artist,
    normalizedTitle: title,
    normalizedArtist: artist,
    confidence: 1,
    isLikelyMusic: true,
    parsingStrategy: "imported_json",
    variantType: "",
    listenedSeconds: Math.max(1, Math.round(listenedMs / 1000)),
    durationSeconds: 0,
    progressPercent: 0,
    thresholdSeconds: 0,
    capturedAt,
    canonicalKey: spotifyTrackUri || buildCanonicalKey(artist, title),
    matchStatus: spotifyTrackUri ? "spotify_imported" : "imported",
    spotifyVerificationStatus: "imported",
    spotifyCandidates: [],
    spotifyQueries: [],
    spotifyMatch: spotifyTrackUri
      ? {
          id: spotifyTrackId,
          uri: spotifyTrackUri,
          title,
          artist,
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
    importFileName: context.fileName
  };
}

function normalizeImportedTimestamp(item) {
  const timestamp = normalizeWhitespace(item.ts || item.endTime || item.playedAt || item.capturedAt || "");
  if (!timestamp) return "";

  if (item.endTime && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(item.endTime)) {
    return new Date(`${item.endTime}:00Z`).toISOString();
  }

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getCurrentLocalMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function appendToQueue(entry) {
  const { failedEvents = [] } = await chrome.storage.local.get({ failedEvents: [] });
  failedEvents.unshift({
    ...entry,
    storedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({
    failedEvents: failedEvents.slice(0, 100)
  });
}

function logDebug(settings, message, data) {
  if (!settings.debug) return;
  console.log(`[Ytb Song Tracker] ${message}`, data || "");
}
