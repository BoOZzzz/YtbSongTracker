(function () {
  const state = {
    currentVideoId: null,
    currentSessionId: "",
    currentVideoChangedAt: 0,
    milestoneSent: false,
    candidateSent: false,
    candidateTimerId: 0,
    thresholdSec: 30,
    minProgressPercent: 0.5,
    debug: false,
    lastSkipReason: "",
    observedVideoElement: null,
    thresholdSkipLogged: false,
    lastMetadataSnapshotKey: "",
    stableMetadataReads: 0,
    lastReportedSeconds: 0,
    accumulatedListenSeconds: 0,
    lastObservedPlayerTimeSec: null,
    lastObservedWallTimeMs: 0,
    lastReadyMetadata: null
  };

  init().catch((error) => {
    console.error("[Ytb Song Tracker] Failed to initialize", error);
  });

  async function init() {
    const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    state.thresholdSec = settings.listenThresholdSec ?? 30;
    state.minProgressPercent = settings.minProgressPercent ?? 0.5;
    state.debug = Boolean(settings.debug);

    watchLocationChanges();
    attachLifecycleListeners();
    window.setInterval(checkPlaybackProgress, 1000);
    resetForCurrentVideo();
    attachPlayerListeners();
  }

  function watchLocationChanges() {
    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        flushListenProgress("location_change");
        resetForCurrentVideo();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("yt-navigate-finish", () => {
      flushListenProgress("yt_navigate_finish");
      resetForCurrentVideo();
    }, true);
    window.addEventListener("popstate", () => {
      flushListenProgress("popstate");
      resetForCurrentVideo();
    }, true);
  }

  function attachLifecycleListeners() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushListenProgress("visibility_hidden");
      }
    }, true);

    window.addEventListener("pagehide", () => {
      flushListenProgress("pagehide");
    }, true);

    window.addEventListener("beforeunload", () => {
      flushListenProgress("beforeunload");
    }, true);
  }

  function resetForCurrentVideo() {
    const videoId = getVideoId();

    if (videoId !== state.currentVideoId) {
      log("Tracking new video", { videoId, url: location.href });
      state.currentVideoId = videoId;
      state.currentSessionId = videoId ? `${videoId}:${Date.now()}` : "";
      state.currentVideoChangedAt = Date.now();
      state.milestoneSent = false;
      state.candidateSent = false;
      clearCandidateTimer();
      state.lastSkipReason = "";
      state.thresholdSkipLogged = false;
      state.lastMetadataSnapshotKey = "";
      state.stableMetadataReads = 0;
      state.lastReportedSeconds = 0;
      state.accumulatedListenSeconds = 0;
      state.lastObservedPlayerTimeSec = null;
      state.lastObservedWallTimeMs = 0;
      state.lastReadyMetadata = null;
    }

    attachPlayerListeners();
    scheduleClassifierCandidateCollection();
  }

  function checkPlaybackProgress() {
    const player = document.querySelector("video");
    if (!player) {
      logSkip("No video element found");
      return;
    }

    if (!state.currentVideoId) {
      resetForCurrentVideo();
      if (!state.currentVideoId) {
        logSkip("No videoId detected for current page");
        return;
      }
    }

    if (player.ended) {
      if (state.milestoneSent) {
        void reportListenProgress(player, "ended");
      } else {
        logSkip("Player already ended");
      }
      return;
    }

    if (!Number.isFinite(player.duration) || player.duration <= 0) {
      logSkip("Player duration is not ready");
      return;
    }

    updateAccumulatedListenSeconds(player);

    const listenedSeconds = getSessionListenedSeconds();
    const progressPercent = player.currentTime / player.duration;
    const requiredListenedSeconds = Math.min(
      state.thresholdSec,
      player.duration * state.minProgressPercent
    );
    const passedSessionThreshold = listenedSeconds >= requiredListenedSeconds;

    if (player.paused && !passedSessionThreshold) {
      logSkip("Player is paused before threshold", {
        currentTime: Number(player.currentTime.toFixed(2)),
        listenedSeconds,
        requiredListenedSeconds: Number(requiredListenedSeconds.toFixed(2))
      });
      return;
    }

    if (!passedSessionThreshold) {
      if (!state.thresholdSkipLogged) {
        state.thresholdSkipLogged = true;
        logSkip("Threshold not reached yet", {
          currentTime: Number(player.currentTime.toFixed(2)),
          listenedSeconds,
          requiredListenedSeconds: Number(requiredListenedSeconds.toFixed(2)),
          progressPercent: Number(progressPercent.toFixed(3)),
          minProgressPercent: state.minProgressPercent
        });
      }
      return;
    }

    state.thresholdSkipLogged = false;

    if (state.milestoneSent && state.lastReadyMetadata) {
      void reportListenProgress(player, "progress", state.lastReadyMetadata, {
        allowUnstableMetadata: true,
        allowCachedMetadata: true
      });
      return;
    }

    const metadata = getMetadata();
    if (!isMetadataReady(metadata)) {
      logSkip("Metadata not ready for listen event");
      return;
    }

    if (!isMetadataStable(metadata)) {
      logSkip("Metadata not stable yet for listen event");
      return;
    }

    state.lastReadyMetadata = metadata;

    void reportListenProgress(player, state.milestoneSent ? "progress" : "threshold", metadata);
  }

  function scheduleClassifierCandidateCollection(delayMs = 1200) {
    clearCandidateTimer();
    if (!state.currentVideoId || state.candidateSent) return;
    state.candidateTimerId = window.setTimeout(maybeCollectClassifierCandidate, delayMs);
  }

  function clearCandidateTimer() {
    if (!state.candidateTimerId) return;
    window.clearTimeout(state.candidateTimerId);
    state.candidateTimerId = 0;
  }

  function maybeCollectClassifierCandidate() {
    clearCandidateTimer();
    if (state.candidateSent) return;
    if (!state.currentVideoId) return;
    if (getVideoId() !== state.currentVideoId) return;

    const metadata = getMetadata();
    if (!isMetadataReady(metadata)) {
      scheduleClassifierCandidateCollection(800);
      return;
    }

    if (!isMetadataStable(metadata)) {
      scheduleClassifierCandidateCollection(700);
      return;
    }

    state.candidateSent = true;

    chrome.runtime.sendMessage({
      type: "COLLECT_CLASSIFIER_CANDIDATE",
      payload: {
        ...metadata,
        sourcePage: location.hostname,
        videoId: state.currentVideoId,
        videoUrl: location.href
      }
    });

    log("Collected classifier candidate", {
      videoId: state.currentVideoId,
      title: metadata.title
    });
  }

  function isMetadataReady(metadata) {
    if (Date.now() - state.currentVideoChangedAt < 2500) return false;

    const title = (metadata.title || "").trim();
    const channelName = (metadata.channelName || "").trim();
    if (!title) return false;
    if (/^(youtube|youtube music)$/i.test(title)) return false;
    if (!channelName && location.hostname === "www.youtube.com") return false;
    return true;
  }

  function isMetadataStable(metadata) {
    const snapshotKey = buildMetadataSnapshotKey(metadata);
    if (!snapshotKey) return false;

    if (snapshotKey === state.lastMetadataSnapshotKey) {
      state.stableMetadataReads += 1;
    } else {
      state.lastMetadataSnapshotKey = snapshotKey;
      state.stableMetadataReads = 1;
    }

    return state.stableMetadataReads >= 2;
  }

  function buildMetadataSnapshotKey(metadata) {
    const title = String(metadata.title || "").trim();
    const channelName = String(metadata.channelName || "").trim();
    const description = String(metadata.description || "")
      .trim()
      .slice(0, 280);

    if (!title) return "";
    return [title, channelName, description].join(" || ");
  }

  function attachPlayerListeners() {
    const player = document.querySelector("video");
    if (!player || player === state.observedVideoElement) return;

    state.observedVideoElement = player;
    player.addEventListener("loadedmetadata", () => {
      flushListenProgress("loadedmetadata");
      resetForCurrentVideo();
    });
    player.addEventListener("durationchange", () => {
      flushListenProgress("durationchange");
      resetForCurrentVideo();
    });
    player.addEventListener("loadeddata", () => scheduleClassifierCandidateCollection(500));
    player.addEventListener("playing", () => {
      updateAccumulatedListenSeconds(player, { forceAnchorReset: true });
      checkPlaybackProgress();
    });
    player.addEventListener("pause", () => {
      updateAccumulatedListenSeconds(player);
      checkPlaybackProgress();
      void reportListenProgress(player, "pause", null, { allowUnstableMetadata: true });
    });
    player.addEventListener("timeupdate", checkPlaybackProgress);
    player.addEventListener("ended", () => {
      updateAccumulatedListenSeconds(player);
      void reportListenProgress(player, "ended", null, { allowUnstableMetadata: true });
    });
    log("Attached player listeners");
  }

  function updateAccumulatedListenSeconds(player, options = {}) {
    if (!player || !Number.isFinite(player.currentTime)) return;

    const currentPlayerTimeSec = Math.max(0, Number(player.currentTime || 0));
    const nowMs = Date.now();

    if (options.forceAnchorReset || state.lastObservedPlayerTimeSec == null) {
      state.lastObservedPlayerTimeSec = currentPlayerTimeSec;
      state.lastObservedWallTimeMs = nowMs;
      return;
    }

    const previousPlayerTimeSec = state.lastObservedPlayerTimeSec;
    const previousWallTimeMs = state.lastObservedWallTimeMs || nowMs;
    const playerDeltaSec = currentPlayerTimeSec - previousPlayerTimeSec;
    const wallDeltaSec = Math.max(0, (nowMs - previousWallTimeMs) / 1000);
    const maxCredibleDeltaSec = wallDeltaSec + 1.25;

    if (playerDeltaSec > 0) {
      state.accumulatedListenSeconds += Math.min(playerDeltaSec, maxCredibleDeltaSec);
    }

    state.lastObservedPlayerTimeSec = currentPlayerTimeSec;
    state.lastObservedWallTimeMs = nowMs;
  }

  function getSessionListenedSeconds() {
    return Math.max(0, Math.floor(state.accumulatedListenSeconds));
  }

  function flushListenProgress(reason) {
    const player = document.querySelector("video");
    if (!player || !state.currentVideoId) return;
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;

    updateAccumulatedListenSeconds(player);
    const listenedSeconds = getSessionListenedSeconds();
    const requiredListenedSeconds = Math.min(
      state.thresholdSec,
      player.duration * state.minProgressPercent
    );
    const passedSessionThreshold = listenedSeconds >= requiredListenedSeconds;

    if (!state.milestoneSent && !passedSessionThreshold) {
      return;
    }

    void reportListenProgress(player, reason, state.lastReadyMetadata, {
      allowUnstableMetadata: true,
      allowCachedMetadata: true
    });
  }

  async function reportListenProgress(player, reason, metadataOverride, options = {}) {
    if (!player || !state.currentVideoId || !state.currentSessionId) return;
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;

    updateAccumulatedListenSeconds(player);
    const listenedSeconds = getSessionListenedSeconds();
    if (reason === "progress" && listenedSeconds <= state.lastReportedSeconds + 9) {
      return;
    }

    const metadata = metadataOverride || state.lastReadyMetadata || getMetadata();
    if (!options.allowCachedMetadata && !isMetadataReady(metadata)) return;
    if (options.allowCachedMetadata && !metadata) return;
    const needsStableMetadata = !state.milestoneSent && !options.allowUnstableMetadata;
    if (needsStableMetadata && !isMetadataStable(metadata)) return;
    if (metadata) {
      state.lastReadyMetadata = metadata;
    }

    state.milestoneSent = true;
    state.lastReportedSeconds = Math.max(state.lastReportedSeconds, listenedSeconds);

    chrome.runtime.sendMessage({
      type: "TRACK_LISTEN_EVENT",
      payload: {
        ...metadata,
        sessionId: state.currentSessionId,
        sourcePage: location.hostname,
        videoId: state.currentVideoId,
        videoUrl: location.href,
        listenedSeconds: state.lastReportedSeconds,
        durationSeconds: Math.round(player.duration),
        progressPercent: Number((player.currentTime / player.duration).toFixed(3))
      }
    });

    log("Dispatching TRACK_LISTEN_EVENT", {
      videoId: state.currentVideoId,
      sessionId: state.currentSessionId,
      reason,
      currentTime: Number(player.currentTime.toFixed(3)),
      accumulatedListenSeconds: Number(state.accumulatedListenSeconds.toFixed(3)),
      lastObservedPlayerTimeSec: state.lastObservedPlayerTimeSec,
      listenedSeconds,
      previousReportedSeconds: state.lastReportedSeconds,
      durationSeconds: Math.round(player.duration),
      progressPercent: Number((player.currentTime / player.duration).toFixed(3)),
      usedCachedMetadata: Boolean(metadataOverride || options.allowCachedMetadata)
    });

    log("Sent listen event", {
      videoId: state.currentVideoId,
      sessionId: state.currentSessionId,
      listenedSeconds: state.lastReportedSeconds,
      reason
    });
  }

  function getMetadata() {
    return {
      title: getTitle(),
      channelName: getChannelName(),
      description: getDescription()
    };
  }

  function getTitle() {
    const selectors = [
      "ytmusic-player-bar .title",
      "h1.title yt-formatted-string",
      "h1.ytd-watch-metadata yt-formatted-string",
      "meta[property='og:title']"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      if (element instanceof HTMLMetaElement) {
        return element.content.trim();
      }

      const text = element.textContent?.trim();
      if (text) return text;
    }

    return document.title.replace(/\s*-\s*YouTube.*$/, "").trim();
  }

  function getChannelName() {
    const selectors = [
      "ytmusic-player-bar .byline",
      "#channel-name a",
      "ytd-watch-metadata #channel-name a",
      "link[itemprop='name']",
      "meta[itemprop='author']"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      if (element instanceof HTMLLinkElement || element instanceof HTMLMetaElement) {
        const value = element.getAttribute("content") || element.getAttribute("title");
        if (value) return value.trim();
      }

      const text = element.textContent?.trim();
      if (text) return text;
    }

    return "";
  }

  function getDescription() {
    const selectors = location.hostname === "music.youtube.com"
      ? [
          "ytmusic-description-shelf-renderer .description",
          "meta[property='og:description']",
          "meta[name='description']"
        ]
      : [
          "ytd-watch-metadata #description-inline-expander",
          "ytd-watch-metadata #description yt-formatted-string",
          "ytd-text-inline-expander #plain-snippet-text",
          "meta[property='og:description']",
          "meta[name='description']"
        ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      if (element instanceof HTMLMetaElement) {
        return element.content.trim();
      }

      const text = sanitizeDescription(element.textContent || "");
      if (text) return text;
    }

    return "";
  }

  function sanitizeDescription(value) {
    const text = String(value || "")
      .replace(/\.\.\.(more|less)\b/gi, " ")
      .replace(/\b(show more|show less)\b/gi, " ")
      .replace(/\b(transcript|follow along using the transcript)\b/gi, " ")
      .replace(/\b(ai-generated video summary|quality and accuracy may vary)\b/gi, " ")
      .replace(/\bask questions\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 1200);
  }

  function getVideoId() {
    const url = new URL(location.href);

    if (url.hostname === "music.youtube.com" && url.searchParams.get("v")) {
      return url.searchParams.get("v");
    }

    if (url.hostname === "www.youtube.com" && url.pathname === "/watch") {
      return url.searchParams.get("v");
    }

    const shortMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortMatch) return shortMatch[1];

    return null;
  }

  function log(message, data) {
    if (!state.debug) return;
    console.log(`[Ytb Song Tracker] ${message}`, data || "");
  }

  function logSkip(reason, data) {
    if (!state.debug) return;
    const key = reason;
    if (state.lastSkipReason === key) return;
    state.lastSkipReason = key;
    console.log(`[Ytb Song Tracker] Skip: ${reason}`, data || "");
  }
})();
