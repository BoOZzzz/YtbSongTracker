(function (factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
    return;
  }

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  root.SongTrackerStorage = factory();
})(function () {
  const DB_NAME = "ytb-song-tracker";
  const DB_VERSION = 1;
  const LISTENS_STORE = "listens";
  const IMPORTS_STORE = "imports";

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(LISTENS_STORE)) {
          const listens = db.createObjectStore(LISTENS_STORE, { keyPath: "id" });
          listens.createIndex("byCapturedAt", "capturedAt", { unique: false });
          listens.createIndex("byMonthKey", "monthKey", { unique: false });
          listens.createIndex("byCanonicalKey", "canonicalKey", { unique: false });
          listens.createIndex("byFingerprint", "eventFingerprint", { unique: true });
          listens.createIndex("bySourceType", "sourceType", { unique: false });
        }

        if (!db.objectStoreNames.contains(IMPORTS_STORE)) {
          const imports = db.createObjectStore(IMPORTS_STORE, { keyPath: "id" });
          imports.createIndex("byImportedAt", "importedAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function withStore(storeName, mode, handler) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let settled = false;

      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
        db.close();
      };
      transaction.onerror = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error || new Error("IndexedDB transaction failed"));
        }
        db.close();
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error || new Error("IndexedDB transaction aborted"));
        }
        db.close();
      };

      Promise.resolve(handler(store, transaction))
        .then((value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
          transaction.abort();
        });
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function slugify(value) {
    return normalizeWhitespace((value || "").toLowerCase())
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildCanonicalKey(artist, title) {
    const normalizedArtist = slugify(artist);
    const normalizedTitle = slugify(title);
    if (!normalizedTitle) return "";
    return normalizedArtist ? normalizedArtist + "::" + normalizedTitle : normalizedTitle;
  }

  function normalizeIsoDate(value, fallback) {
    const parsed = new Date(String(value || "").trim() || fallback || Date.now());
    if (Number.isNaN(parsed.getTime())) {
      return new Date(fallback || Date.now()).toISOString();
    }
    return parsed.toISOString();
  }

  function getLocalMonthKey(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) {
      return getLocalMonthKey(Date.now());
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  function buildEventFingerprint(record) {
    if (record.sessionId) {
      return ["session", record.sourceType || "", record.videoId || "", record.sessionId].join("||");
    }

    const fields = [
      record.sourceType || "",
      record.videoId || "",
      record.spotifyTrackUri || "",
      record.normalizedArtist || record.rawChannelName || "",
      record.normalizedTitle || record.rawTitle || "",
      record.capturedAt || "",
      String(record.listenedSeconds || 0)
    ];
    return fields.join("||");
  }

  function decideClassification(record) {
    return record.finalClassification || (record.isLikelyMusic ? "song" : "video");
  }

  function decideConfidence(record) {
    return Number(record.finalConfidence ?? record.confidence ?? 0);
  }

  function createListenRecord(input) {
    const capturedAt = normalizeIsoDate(input.capturedAt);
    const normalizedArtist = normalizeWhitespace(input.normalizedArtist || "");
    const normalizedTitle = normalizeWhitespace(input.normalizedTitle || input.rawTitle || "");
    const canonicalKey = input.canonicalKey || (input.spotifyTrackUri || buildCanonicalKey(normalizedArtist, normalizedTitle));

    const record = {
      id: input.id || crypto.randomUUID(),
      source: normalizeWhitespace(input.source || input.sourceType || "unknown"),
      sourceType: normalizeWhitespace(input.sourceType || "unknown"),
      videoId: normalizeWhitespace(input.videoId || ""),
      videoUrl: normalizeWhitespace(input.videoUrl || ""),
      pageUrl: normalizeWhitespace(input.pageUrl || ""),
      rawTitle: normalizeWhitespace(input.rawTitle || input.title || ""),
      rawChannelName: normalizeWhitespace(input.rawChannelName || input.channelName || ""),
      rawDescription: String(input.rawDescription || input.description || ""),
      parserTitle: normalizeWhitespace(input.parserTitle || normalizedTitle),
      parserArtist: normalizeWhitespace(input.parserArtist || normalizedArtist),
      normalizedTitle,
      normalizedArtist,
      confidence: Number(input.confidence || 0),
      isLikelyMusic: Boolean(input.isLikelyMusic),
      parsingStrategy: normalizeWhitespace(input.parsingStrategy || ""),
      variantType: normalizeWhitespace(input.variantType || ""),
      listenedSeconds: Math.max(0, Number(input.listenedSeconds || 0)),
      durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
      progressPercent: Math.max(0, Number(input.progressPercent || 0)),
      thresholdSeconds: Math.max(0, Number(input.thresholdSeconds || 0)),
      sessionId: normalizeWhitespace(input.sessionId || ""),
      capturedAt,
      storedAt: normalizeIsoDate(input.storedAt, Date.now()),
      canonicalKey,
      matchStatus: normalizeWhitespace(input.matchStatus || ""),
      spotifyVerificationStatus: normalizeWhitespace(input.spotifyVerificationStatus || ""),
      spotifyCandidates: Array.isArray(input.spotifyCandidates) ? input.spotifyCandidates : [],
      spotifyQueries: Array.isArray(input.spotifyQueries) ? input.spotifyQueries : [],
      spotifyMatch: input.spotifyMatch || null,
      spotifyTrackId: normalizeWhitespace(input.spotifyTrackId || input.spotifyMatch?.id || ""),
      spotifyTrackUri: normalizeWhitespace(input.spotifyTrackUri || input.spotifyMatch?.uri || ""),
      spotifyExternalUrl: normalizeWhitespace(input.spotifyExternalUrl || input.spotifyMatch?.externalUrl || ""),
      classifierPrediction: input.classifierPrediction || null,
      finalClassification: normalizeWhitespace(input.finalClassification || ""),
      finalConfidence: Number(input.finalConfidence ?? input.confidence ?? 0),
      isImported: Boolean(input.isImported),
      importSource: normalizeWhitespace(input.importSource || ""),
      importFileName: normalizeWhitespace(input.importFileName || ""),
      monthKey: getLocalMonthKey(capturedAt)
    };

    record.eventFingerprint = input.eventFingerprint || buildEventFingerprint(record);
    return record;
  }

  async function putListen(record) {
    const normalized = createListenRecord(record);

    return withStore(LISTENS_STORE, "readwrite", async (store) => {
      const index = store.index("byFingerprint");
      const existing = await requestToPromise(index.get(normalized.eventFingerprint));
      if (existing) {
        const merged = createListenRecord({
          ...existing,
          ...normalized,
          listenedSeconds: Math.max(Number(existing.listenedSeconds || 0), Number(normalized.listenedSeconds || 0)),
          durationSeconds: Math.max(Number(existing.durationSeconds || 0), Number(normalized.durationSeconds || 0)),
          progressPercent: Math.max(Number(existing.progressPercent || 0), Number(normalized.progressPercent || 0)),
          spotifyCandidates: normalized.spotifyCandidates?.length ? normalized.spotifyCandidates : existing.spotifyCandidates,
          spotifyQueries: normalized.spotifyQueries?.length ? normalized.spotifyQueries : existing.spotifyQueries,
          spotifyMatch: normalized.spotifyMatch || existing.spotifyMatch,
          spotifyTrackId: normalized.spotifyTrackId || existing.spotifyTrackId,
          spotifyTrackUri: normalized.spotifyTrackUri || existing.spotifyTrackUri,
          spotifyExternalUrl: normalized.spotifyExternalUrl || existing.spotifyExternalUrl,
          normalizedTitle: normalized.normalizedTitle || existing.normalizedTitle,
          normalizedArtist: normalized.normalizedArtist || existing.normalizedArtist,
          matchStatus: normalized.matchStatus || existing.matchStatus,
          spotifyVerificationStatus: normalized.spotifyVerificationStatus || existing.spotifyVerificationStatus,
          finalClassification: normalized.finalClassification || existing.finalClassification,
          finalConfidence: Math.max(Number(existing.finalConfidence || 0), Number(normalized.finalConfidence || 0)),
          storedAt: new Date().toISOString()
        });

        store.put(merged);
        return { inserted: false, record: merged };
      }

      store.put(normalized);
      return { inserted: true, record: normalized };
    });
  }

  async function bulkImport(items, metadata) {
    const normalizedItems = items
      .map((item) => createListenRecord({
        ...item,
        isImported: true,
        importSource: metadata.source || "import",
        importFileName: metadata.fileName || ""
      }))
      .filter((item) => item.rawTitle && item.capturedAt);

    return withStore(LISTENS_STORE, "readwrite", async (store) => {
      const index = store.index("byFingerprint");
      let importedCount = 0;
      let skippedDuplicates = 0;

      for (const item of normalizedItems) {
        const existing = await requestToPromise(index.get(item.eventFingerprint));
        if (existing) {
          skippedDuplicates += 1;
          continue;
        }
        store.put(item);
        importedCount += 1;
      }

      return withStore(IMPORTS_STORE, "readwrite", async (importsStore) => {
        importsStore.put({
          id: crypto.randomUUID(),
          source: metadata.source || "import",
          fileName: metadata.fileName || "",
          importedAt: new Date().toISOString(),
          importedCount,
          skippedDuplicates
        });

        return {
          importedCount,
          skippedDuplicates,
          rejectedCount: items.length - normalizedItems.length
        };
      });
    });
  }

  async function getAllListens() {
    return withStore(LISTENS_STORE, "readonly", async (store) => {
      return requestToPromise(store.getAll());
    });
  }

  async function getListenHistory(options) {
    const events = await getAllListens();
    const monthKey = normalizeWhitespace(options?.monthKey || "");
    const filtered = monthKey ? filterEventsByMonth(events, monthKey) : events;

    return filtered
      .slice()
      .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));
  }

  function aggregateByClassification(events, options) {
    const byItem = new Map();
    const classificationFilter = normalizeWhitespace(options.classification || "");
    const excludeClassification = normalizeWhitespace(options.excludeClassification || "");
    const filtered = filterEventsByMonth(events, options.monthKey);

    for (const event of filtered) {
      const classification = decideClassification(event);
      const confidence = decideConfidence(event);
      if (classificationFilter && classification !== classificationFilter) continue;
      if (excludeClassification && classification === excludeClassification) continue;
      if (!excludeClassification && confidence < Number(options.minConfidence ?? 0.55)) continue;

      const key = classification === "song"
        ? (event.canonicalKey || buildCanonicalKey(event.normalizedArtist, event.normalizedTitle))
        : (event.videoId || event.canonicalKey || buildCanonicalKey("", event.rawTitle || event.normalizedTitle));
      if (!key) continue;

      const existing = byItem.get(key) || {
        key,
        groupKey: key,
        title: event.normalizedTitle || event.rawTitle || "Unknown title",
        artist: event.normalizedArtist || "",
        sourceType: event.sourceType || "unknown",
        videoId: event.videoId || "",
        canonicalKey: event.canonicalKey || "",
        sampleVideoUrl: event.videoUrl || event.pageUrl || "",
        samplePageUrl: event.pageUrl || event.videoUrl || "",
        spotifyExternalUrl: event.spotifyExternalUrl || "",
        playCount: 0,
        totalListenedSeconds: 0,
        lastPlayedAt: event.capturedAt
      };

      existing.playCount += 1;
      existing.totalListenedSeconds += Number(event.listenedSeconds || 0);
      existing.lastPlayedAt = existing.lastPlayedAt > event.capturedAt ? existing.lastPlayedAt : event.capturedAt;
      byItem.set(key, existing);
    }

    return Array.from(byItem.values()).sort((left, right) => {
      if (right.playCount !== left.playCount) return right.playCount - left.playCount;
      return String(right.lastPlayedAt || "").localeCompare(String(left.lastPlayedAt || ""));
    });
  }

  function filterEventsByMonth(events, monthKey) {
    if (!monthKey) return events;
    return events.filter((event) => String(event.monthKey || "").slice(0, 7) === monthKey);
  }

  function computeTopSongs(events, options) {
    const bySong = new Map();
    const minConfidence = Number(options.minConfidence ?? 0.55);
    const filtered = filterEventsByMonth(events, options.monthKey);
    const summary = {
      trackedSongs: 0,
      totalTrackedEvents: 0,
      totalListenedSeconds: 0,
      sources: {}
    };

    for (const event of filtered) {
      const classification = decideClassification(event);
      const confidence = decideConfidence(event);
      if (classification !== "song" || confidence < minConfidence) continue;

      const key = event.canonicalKey || buildCanonicalKey(event.normalizedArtist, event.normalizedTitle);
      if (!key) continue;

      summary.totalTrackedEvents += 1;
      summary.totalListenedSeconds += Number(event.listenedSeconds || 0);
      summary.sources[event.sourceType || "unknown"] = (summary.sources[event.sourceType || "unknown"] || 0) + 1;

      const existing = bySong.get(key) || {
        canonicalKey: key,
        title: event.normalizedTitle || event.rawTitle,
        artist: event.normalizedArtist || "",
        spotifyTrackId: event.spotifyTrackId || "",
        spotifyTrackUri: event.spotifyTrackUri || "",
        spotifyExternalUrl: event.spotifyExternalUrl || "",
        sampleVideoUrl: event.videoUrl || event.pageUrl || "",
        samplePageUrl: event.pageUrl || event.videoUrl || "",
        lastPlayedAt: event.capturedAt,
        lastPlayedLabel: event.capturedAt,
        playCount: 0,
        totalListenedSeconds: 0,
        sourceTypes: {}
      };

      existing.playCount += 1;
      existing.totalListenedSeconds += Number(event.listenedSeconds || 0);
      existing.lastPlayedAt = existing.lastPlayedAt > event.capturedAt ? existing.lastPlayedAt : event.capturedAt;
      existing.lastPlayedLabel = existing.lastPlayedAt;
      if (!existing.sampleVideoUrl && (event.videoUrl || event.pageUrl)) {
        existing.sampleVideoUrl = event.videoUrl || event.pageUrl || "";
        existing.samplePageUrl = event.pageUrl || event.videoUrl || "";
      }
      existing.sourceTypes[event.sourceType || "unknown"] = (existing.sourceTypes[event.sourceType || "unknown"] || 0) + 1;
      bySong.set(key, existing);
    }

    const items = Array.from(bySong.values())
      .sort((left, right) => {
        if (right.playCount !== left.playCount) return right.playCount - left.playCount;
        return String(right.lastPlayedAt).localeCompare(String(left.lastPlayedAt));
      })
      .slice(0, Number(options.limit || 30));

    summary.trackedSongs = items.length;

    return {
      period: {
        month: options.monthKey || null,
        label: options.monthKey || "all-time"
      },
      summary,
      items
    };
  }

  async function getTopSongs(options) {
    const events = await getAllListens();
    return computeTopSongs(events, options || {});
  }

  async function getTopVideos(options) {
    const events = await getAllListens();
    const items = aggregateByClassification(events, {
      excludeClassification: "song",
      monthKey: options?.monthKey || "",
      minConfidence: options?.minConfidence ?? 0.55
    });

    return {
      items
    };
  }

  async function updateClassificationOverride(options) {
    const groupKey = normalizeWhitespace(options?.groupKey || "");
    const targetClassification = normalizeWhitespace(options?.classification || "");
    if (!groupKey || !targetClassification) {
      throw new Error("groupKey and classification are required");
    }

    return withStore(LISTENS_STORE, "readwrite", async (store) => {
      const items = await requestToPromise(store.getAll());
      let updatedCount = 0;

      for (const item of items) {
        const itemClassification = decideClassification(item);
        const itemGroupKey = itemClassification === "song"
          ? (item.canonicalKey || buildCanonicalKey(item.normalizedArtist, item.normalizedTitle))
          : (item.videoId || item.canonicalKey || buildCanonicalKey("", item.rawTitle || item.normalizedTitle));

        if (itemGroupKey !== groupKey) continue;

        const updated = createListenRecord({
          ...item,
          finalClassification: targetClassification,
          finalConfidence: Math.max(Number(item.finalConfidence || 0), 1),
          manualClassification: targetClassification,
          manualClassificationAt: new Date().toISOString(),
          storedAt: new Date().toISOString()
        });

        store.put(updated);
        updatedCount += 1;
      }

      return { updatedCount };
    });
  }

  return {
    createListenRecord,
    putListen,
    bulkImport,
    getTopSongs,
    getTopVideos,
    getListenHistory,
    updateClassificationOverride,
    getAllListens,
    computeTopSongs
  };
});
