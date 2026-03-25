importScripts("parser.js");

const DEFAULT_SETTINGS = {
  backendUrl: "",
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

  return false;
});

async function handleListenEvent(payload, sender) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const parsed = SongTrackerParser.parseVideoMetadata(payload);
  const listenEvent = {
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

  if (!settings.backendUrl) {
    await appendToQueue({
      status: "pending_config",
      listenEvent
    });
    logDebug(settings, "Queued event because backend URL is missing", {
      videoId: listenEvent.videoId,
      status: "pending_config"
    });
    return { queued: true, reason: "Missing backendUrl" };
  }

  const response = await fetch(settings.backendUrl, {
    method: "POST",
    headers: buildHeaders(settings),
    body: JSON.stringify(listenEvent)
  });

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch (error) {
    responseBody = null;
  }

  if (!response.ok) {
    await appendToQueue({
      status: "delivery_failed",
      listenEvent,
      responseStatus: response.status
    });
    logDebug(settings, "Backend rejected listen event", {
      videoId: listenEvent.videoId,
      responseStatus: response.status
    });
    throw new Error(`Backend responded with ${response.status}`);
  }

  logDebug(settings, "Delivered listen event", {
    videoId: listenEvent.videoId,
    backendUrl: settings.backendUrl,
    parserClassification: listenEvent.isLikelyMusic ? "song" : "video",
    parserConfidence: listenEvent.confidence,
    variantType: responseBody?.variantType || listenEvent.variantType || "",
    finalClassification: responseBody?.finalClassification || (listenEvent.isLikelyMusic ? "song" : "video"),
    finalConfidence: responseBody?.finalConfidence ?? listenEvent.confidence,
    matchStatus: responseBody?.matchStatus || "unknown",
    spotifyVerificationStatus: responseBody?.spotifyVerificationStatus || "unknown",
    spotifyQueries: responseBody?.spotifyQueries || [],
    spotifyMatch: responseBody?.spotifyMatch || null
  });

  return {
    delivered: true,
    confidence: parsed.confidence,
    finalClassification: responseBody?.finalClassification || (listenEvent.isLikelyMusic ? "song" : "video"),
    finalConfidence: responseBody?.finalConfidence ?? parsed.confidence
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
  const url = new URL(listensEndpoint);
  url.pathname = "/api/classifier/candidates/collect";
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
