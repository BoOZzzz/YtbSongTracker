"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_CANDIDATES_PATH,
  readCandidates,
  writeCandidates,
  createLabelBatch,
  markCandidatesInBatch
} = require("../classifier");

const DEFAULT_EVENTS_PATH = path.join(__dirname, "..", "data", "listen-events.json");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventsPath = path.resolve(args.events || DEFAULT_EVENTS_PATH);
  const limit = clamp(Number(args.limit || 50), 1, 500);
  const batchId = args.batchId || `history-label-batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputPath = path.resolve(args.out || path.join(__dirname, "..", "data", `${batchId}.json`));

  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Missing ${eventsPath}`);
  }

  const events = JSON.parse(fs.readFileSync(eventsPath, "utf8").replace(/^\uFEFF/, "") || "[]");
  const existingCandidates = readCandidates(DEFAULT_CANDIDATES_PATH);
  const mergedCandidates = seedCandidatesFromHistory(events, existingCandidates);
  writeCandidates(mergedCandidates, DEFAULT_CANDIDATES_PATH);

  const batch = createLabelBatch(mergedCandidates, { limit, batchId });
  if (!batch.length) {
    console.log("[create-history-label-batch] No pending candidates available");
    console.log(`candidateCount: ${mergedCandidates.length}`);
    console.log(`seededFromHistory: ${events.length}`);
    return;
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
  writeCandidates(markCandidatesInBatch(mergedCandidates, batch), DEFAULT_CANDIDATES_PATH);

  console.log("[create-history-label-batch] Wrote labeling batch from listen history");
  console.log(`eventsPath: ${eventsPath}`);
  console.log(`candidateCount: ${mergedCandidates.length}`);
  console.log(`batchId: ${batchId}`);
  console.log(`count: ${batch.length}`);
  console.log(`path: ${outputPath}`);
}

function seedCandidatesFromHistory(events, candidates) {
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

    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        ...candidate,
        seenCount: Number(existing.seenCount || 1) + 1,
        status: existing.status || "pending_label",
        assignedLabel: existing.assignedLabel || "",
        updatedAt: newerTimestamp(existing.updatedAt, candidate.updatedAt)
      });
      continue;
    }

    byKey.set(key, candidate);
  }

  return Array.from(byKey.values()).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function newerTimestamp(left, right) {
  const leftValue = String(left || "");
  const rightValue = String(right || "");
  return leftValue > rightValue ? leftValue : rightValue;
}

function buildKey(entry) {
  if (entry.videoId) return `video:${entry.videoId}`;
  const rawTitle = String(entry.rawTitle || "").trim();
  const rawChannelName = String(entry.rawChannelName || "").trim();
  if (!rawTitle) return "";
  return `meta:${rawTitle}::${rawChannelName}`.toLowerCase();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

try {
  main();
} catch (error) {
  console.error("[create-history-label-batch] Failed");
  console.error(error.message);
  process.exitCode = 1;
}
