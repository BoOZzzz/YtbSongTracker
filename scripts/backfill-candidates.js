"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_CANDIDATES_PATH, readCandidates, writeCandidates } = require("../classifier");

const eventsPath = path.join(__dirname, "..", "data", "listen-events.json");

function main() {
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Missing ${eventsPath}`);
  }

  const events = JSON.parse(fs.readFileSync(eventsPath, "utf8").replace(/^\uFEFF/, ""));
  const candidates = readCandidates(DEFAULT_CANDIDATES_PATH);
  const byKey = new Map(candidates.map((item) => [buildKey(item), item]));

  for (const event of events) {
    const candidate = {
      videoId: String(event.videoId || "").trim(),
      videoUrl: String(event.videoUrl || "").trim(),
      pageUrl: String(event.pageUrl || "").trim(),
      rawTitle: String(event.rawTitle || "").trim(),
      rawChannelName: String(event.rawChannelName || "").trim(),
      rawDescription: String(event.rawDescription || "").trim(),
      sourcePage: String(event.source || "").trim(),
      parserClassification: event.isLikelyMusic ? "song" : "video",
      parserConfidence: Number(event.confidence || 0),
      variantType: String(event.variantType || "").trim(),
      listenedSeconds: Number(event.listenedSeconds || 0),
      durationSeconds: Number(event.durationSeconds || 0),
      progressPercent: Number(event.progressPercent || 0),
      capturedAt: String(event.capturedAt || "").trim(),
      classifierPrediction: event.classifierPrediction || null,
      finalClassification: String(event.finalClassification || "").trim(),
      finalConfidence: Number(event.finalConfidence || 0),
      status: "pending_label",
      seenCount: 1,
      createdAt: String(event.storedAt || event.capturedAt || new Date().toISOString()),
      updatedAt: String(event.storedAt || event.capturedAt || new Date().toISOString())
    };

    const key = buildKey(candidate);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }

  const merged = Array.from(byKey.values()).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  writeCandidates(merged, DEFAULT_CANDIDATES_PATH);

  console.log("[backfill-candidates] Seeded candidate pool");
  console.log(`count: ${merged.length}`);
  console.log(`path: ${DEFAULT_CANDIDATES_PATH}`);
}

function buildKey(entry) {
  if (entry.videoId) return `video:${entry.videoId}`;
  const rawTitle = String(entry.rawTitle || "").trim();
  const rawChannelName = String(entry.rawChannelName || "").trim();
  if (!rawTitle) return "";
  return `meta:${rawTitle}::${rawChannelName}`.toLowerCase();
}

try {
  main();
} catch (error) {
  console.error("[backfill-candidates] Failed");
  console.error(error.message);
  process.exitCode = 1;
}
