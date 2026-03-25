"use strict";

const fs = require("fs");
const path = require("path");
const { extractClassifierFeatures } = require("./parser");

const DEFAULT_LABELS_PATH = path.join(__dirname, "data", "classifier-labels.json");
const DEFAULT_MODEL_PATH = path.join(__dirname, "data", "classifier-model.json");
const DEFAULT_CANDIDATES_PATH = path.join(__dirname, "data", "classifier-candidates.json");
const HASH_DIMENSION = 512;
const TEXT_TOKEN_LIMIT = 40;

function ensureClassifierStorage(paths = {}) {
  const labelsPath = paths.labelsPath || DEFAULT_LABELS_PATH;
  const modelPath = paths.modelPath || DEFAULT_MODEL_PATH;
  const candidatesPath = paths.candidatesPath || DEFAULT_CANDIDATES_PATH;

  fs.mkdirSync(path.dirname(labelsPath), { recursive: true });

  if (!fs.existsSync(labelsPath)) {
    fs.writeFileSync(labelsPath, "[]\n", "utf8");
  }

  if (!fs.existsSync(modelPath)) {
    fs.writeFileSync(modelPath, "{\n  \"version\": 1,\n  \"trainedAt\": null,\n  \"labels\": [],\n  \"weights\": {},\n  \"bias\": 0\n}\n", "utf8");
  }

  if (!fs.existsSync(candidatesPath)) {
    fs.writeFileSync(candidatesPath, "[]\n", "utf8");
  }
}

function readLabels(labelsPath = DEFAULT_LABELS_PATH) {
  ensureClassifierStorage({ labelsPath });
  return JSON.parse(fs.readFileSync(labelsPath, "utf8") || "[]");
}

function writeLabels(labels, labelsPath = DEFAULT_LABELS_PATH) {
  ensureClassifierStorage({ labelsPath });
  fs.writeFileSync(labelsPath, `${JSON.stringify(labels, null, 2)}\n`, "utf8");
}

function upsertLabel(entry, labelsPath = DEFAULT_LABELS_PATH) {
  const labels = readLabels(labelsPath);
  const normalized = normalizeLabelEntry(entry);
  const key = buildLabelKey(normalized);
  const index = labels.findIndex((item) => buildLabelKey(item) === key);

  if (index >= 0) {
    labels[index] = {
      ...labels[index],
      ...normalized,
      updatedAt: new Date().toISOString()
    };
  } else {
    labels.unshift({
      ...normalized,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  writeLabels(labels, labelsPath);
  return labels[0];
}

function normalizeLabelEntry(entry) {
  return {
    videoId: String(entry.videoId || "").trim(),
    rawTitle: String(entry.rawTitle || "").trim(),
    rawChannelName: String(entry.rawChannelName || "").trim(),
    rawDescription: String(entry.rawDescription || "").trim(),
    sourcePage: String(entry.sourcePage || "").trim(),
    label: normalizeLabel(entry.label)
  };
}

function normalizeLabel(label) {
  const normalized = String(label || "").trim().toLowerCase();
  if (normalized === "song" || normalized === "video" || normalized === "uncertain") return normalized;
  throw new Error("label must be 'song', 'video', or 'uncertain'");
}

function buildLabelKey(entry) {
  if (entry.videoId) return `video:${entry.videoId}`;
  return `meta:${entry.rawTitle}::${entry.rawChannelName}`.toLowerCase();
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, TEXT_TOKEN_LIMIT);
}

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % HASH_DIMENSION;
}

function buildFeatureVector(raw) {
  const features = extractClassifierFeatures({
    title: raw.rawTitle || raw.title || "",
    channelName: raw.rawChannelName || raw.channelName || "",
    description: raw.rawDescription || raw.description || "",
    sourcePage: raw.sourcePage || raw.source || ""
  });
  const vector = Object.create(null);

  addNumericFeature(vector, "bias", 1);
  addNumericFeature(vector, "parser_confidence", features.parserConfidence);
  addNumericFeature(vector, "title_length", cap(features.stats.titleLength, 160) / 160);
  addNumericFeature(vector, "channel_length", cap(features.stats.channelLength, 120) / 120);
  addNumericFeature(vector, "description_length", cap(features.stats.descriptionLength, 500) / 500);
  addNumericFeature(vector, "title_token_count", cap(features.stats.titleTokenCount, 25) / 25);
  addNumericFeature(vector, "channel_token_count", cap(features.stats.channelTokenCount, 12) / 12);
  addNumericFeature(vector, "description_token_count", cap(features.stats.descriptionTokenCount, 80) / 80);
  addNumericFeature(vector, "separator_count", cap(features.stats.separatorCount, 3) / 3);
  addNumericFeature(vector, "exclamation_count", cap(features.stats.exclamationCount, 4) / 4);
  addNumericFeature(vector, "bracket_count", cap(features.stats.bracketCount, 10) / 10);

  for (const [key, value] of Object.entries(features.flags)) {
    if (value) {
      addNumericFeature(vector, `flag:${key}`, 1);
    }
  }

  if (features.text.parsingStrategy) {
    addNumericFeature(vector, `strategy:${features.text.parsingStrategy}`, 1);
  }

  if (features.variantType) {
    addNumericFeature(vector, `variant:${features.variantType}`, 1);
  }

  const textGroups = [
    { prefix: "title", tokens: tokenize(features.title) },
    { prefix: "channel", tokens: tokenize(features.channelName) },
    { prefix: "description", tokens: tokenize(features.description) },
    { prefix: "artist", tokens: tokenize(features.text.normalizedArtist) },
    { prefix: "song", tokens: tokenize(features.text.normalizedTitle) }
  ];

  for (const group of textGroups) {
    for (const token of group.tokens) {
      addNumericFeature(vector, `hash:${group.prefix}:${hashToken(token)}`, 1);
    }
  }

  return {
    vector,
    parserConfidence: features.parserConfidence,
    parserDecision: features.parserConfidence >= 0.55 ? "song" : "video",
    features
  };
}

function addNumericFeature(vector, key, value) {
  vector[key] = (vector[key] || 0) + value;
}

function cap(value, max) {
  return Math.min(max, Math.max(0, Number(value || 0)));
}

function sigmoid(value) {
  if (value > 35) return 1;
  if (value < -35) return 0;
  return 1 / (1 + Math.exp(-value));
}

function trainClassifier(labels, options = {}) {
  const learningRate = Number(options.learningRate || 0.35);
  const epochs = Number(options.epochs || 140);
  const l2 = Number(options.l2 || 0.0005);
  const minSamples = Number(options.minSamples || 20);
  const normalizedLabels = labels
    .map((entry) => normalizeLabelEntry(entry))
    .filter((entry) => entry.label !== "uncertain")
    .filter((entry) => entry.rawTitle || entry.rawChannelName || entry.rawDescription);

  if (normalizedLabels.length < minSamples) {
    throw new Error(`Need at least ${minSamples} labeled examples before training`);
  }

  const dataset = normalizedLabels.map((entry) => {
    const built = buildFeatureVector(entry);
    return {
      ...built,
      label: entry.label === "song" ? 1 : 0
    };
  });

  const weights = Object.create(null);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const sample of dataset) {
      let score = bias;
      for (const [key, value] of Object.entries(sample.vector)) {
        if (key === "bias") continue;
        score += (weights[key] || 0) * value;
      }

      const prediction = sigmoid(score);
      const error = prediction - sample.label;

      bias -= learningRate * error;

      for (const [key, value] of Object.entries(sample.vector)) {
        if (key === "bias") continue;
        const currentWeight = weights[key] || 0;
        weights[key] = currentWeight - learningRate * ((error * value) + l2 * currentWeight);
      }
    }
  }

  let correct = 0;
  for (const sample of dataset) {
    const probability = scoreVector(sample.vector, weights, bias);
    const predictedLabel = probability >= 0.5 ? 1 : 0;
    if (predictedLabel === sample.label) correct += 1;
  }

  return {
    version: 1,
    trainedAt: new Date().toISOString(),
    sampleCount: dataset.length,
    labels: ["video", "song"],
    hashDimension: HASH_DIMENSION,
    weights,
    bias: Number(bias.toFixed(6)),
    metrics: {
      trainingAccuracy: Number((correct / dataset.length).toFixed(4))
    }
  };
}

function scoreVector(vector, weights, bias) {
  let score = Number(bias || 0);
  for (const [key, value] of Object.entries(vector)) {
    if (key === "bias") continue;
    score += (weights[key] || 0) * value;
  }
  return sigmoid(score);
}

function predictClassification(raw, model) {
  if (!model || !model.weights || !model.trainedAt) {
    return null;
  }

  const built = buildFeatureVector(raw);
  const probabilitySong = scoreVector(built.vector, model.weights, model.bias);
  const label = probabilitySong >= 0.5 ? "song" : "video";

  return {
    label,
    confidence: Number((label === "song" ? probabilitySong : 1 - probabilitySong).toFixed(3)),
    probabilitySong: Number(probabilitySong.toFixed(3)),
    parserDecision: built.parserDecision,
    parserConfidence: Number(built.parserConfidence.toFixed(3)),
    features: {
      parsingStrategy: built.features.text.parsingStrategy,
      variantType: built.features.variantType,
      normalizedArtist: built.features.text.normalizedArtist,
      normalizedTitle: built.features.text.normalizedTitle
    }
  };
}

function readModel(modelPath = DEFAULT_MODEL_PATH) {
  ensureClassifierStorage({ modelPath });
  return JSON.parse(fs.readFileSync(modelPath, "utf8") || "{}");
}

function writeModel(model, modelPath = DEFAULT_MODEL_PATH) {
  ensureClassifierStorage({ modelPath });
  fs.writeFileSync(modelPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
}

function readCandidates(candidatesPath = DEFAULT_CANDIDATES_PATH) {
  ensureClassifierStorage({ candidatesPath });
  return JSON.parse(fs.readFileSync(candidatesPath, "utf8") || "[]");
}

function writeCandidates(candidates, candidatesPath = DEFAULT_CANDIDATES_PATH) {
  ensureClassifierStorage({ candidatesPath });
  fs.writeFileSync(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8");
}

function buildCandidateKey(entry) {
  if (entry.videoId) return `video:${entry.videoId}`;
  return `meta:${String(entry.rawTitle || "").trim()}::${String(entry.rawChannelName || "").trim()}`.toLowerCase();
}

function upsertCandidate(entry, candidatesPath = DEFAULT_CANDIDATES_PATH) {
  const candidates = readCandidates(candidatesPath);
  const normalized = normalizeCandidateEntry(entry);
  const key = buildCandidateKey(normalized);
  const existingIndex = candidates.findIndex((item) => buildCandidateKey(item) === key);

  if (existingIndex >= 0) {
    const existing = candidates[existingIndex];
    candidates[existingIndex] = {
      ...existing,
      ...normalized,
      seenCount: Number(existing.seenCount || 1) + 1,
      updatedAt: new Date().toISOString()
    };
    writeCandidates(candidates, candidatesPath);
    return candidates[existingIndex];
  }

  const created = {
    ...normalized,
    status: "pending_label",
    seenCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  candidates.unshift(created);
  writeCandidates(candidates, candidatesPath);
  return created;
}

function normalizeCandidateEntry(entry) {
  return {
    videoId: String(entry.videoId || "").trim(),
    videoUrl: String(entry.videoUrl || "").trim(),
    pageUrl: String(entry.pageUrl || "").trim(),
    rawTitle: String(entry.rawTitle || "").trim(),
    rawChannelName: String(entry.rawChannelName || "").trim(),
    rawDescription: String(entry.rawDescription || "").trim(),
    sourcePage: String(entry.sourcePage || entry.source || "").trim(),
    parserClassification: String(entry.parserClassification || "").trim(),
    parserConfidence: Number(entry.parserConfidence ?? entry.confidence ?? 0),
    variantType: String(entry.variantType || "").trim(),
    listenedSeconds: Number(entry.listenedSeconds || 0),
    durationSeconds: Number(entry.durationSeconds || 0),
    progressPercent: Number(entry.progressPercent || 0),
    capturedAt: String(entry.capturedAt || "").trim(),
    classifierPrediction: entry.classifierPrediction || null,
    finalClassification: String(entry.finalClassification || "").trim(),
    finalConfidence: Number(entry.finalConfidence ?? 0)
  };
}

function createLabelBatch(candidates, options = {}) {
  const limit = Number(options.limit || 20);
  const batchId = options.batchId || `auto-label-batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const pending = candidates
    .filter((item) => (item.status || "pending_label") === "pending_label")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, limit);

  return pending.map((item, index) => ({
    batchId,
    id: index + 1,
    videoId: item.videoId,
    title: item.rawTitle,
    url: item.videoUrl || item.pageUrl,
    rawChannelName: item.rawChannelName,
    rawDescription: item.rawDescription,
    sourcePage: item.sourcePage,
    parserClassification: item.parserClassification,
    parserConfidence: item.parserConfidence,
    finalClassification: item.finalClassification,
    finalConfidence: item.finalConfidence,
    variantType: item.variantType,
    label: ""
  }));
}

function markCandidatesInBatch(candidates, batchItems) {
  const keys = new Set(batchItems.map((item) => buildCandidateKey({
    videoId: item.videoId,
    rawTitle: item.title,
    rawChannelName: item.rawChannelName
  })));

  return candidates.map((item) => {
    if (!keys.has(buildCandidateKey(item))) return item;
    return {
      ...item,
      status: "batched",
      updatedAt: new Date().toISOString()
    };
  });
}

function applyLabeledBatch(batchItems, paths = {}) {
  const labelsPath = paths.labelsPath || DEFAULT_LABELS_PATH;
  const candidatesPath = paths.candidatesPath || DEFAULT_CANDIDATES_PATH;
  const labels = readLabels(labelsPath);
  const candidates = readCandidates(candidatesPath);
  const now = new Date().toISOString();

  for (const item of batchItems) {
    const normalizedLabel = normalizeLabel(item.label);
    const labelEntry = {
      videoId: String(item.videoId || "").trim(),
      rawTitle: String(item.title || item.rawTitle || "").trim(),
      rawChannelName: String(item.rawChannelName || "").trim(),
      rawDescription: String(item.rawDescription || "").trim(),
      sourcePage: String(item.sourcePage || "").trim(),
      label: normalizedLabel
    };
    const labelKey = buildLabelKey(labelEntry);
    const existingLabelIndex = labels.findIndex((entry) => buildLabelKey(entry) === labelKey);

    if (existingLabelIndex >= 0) {
      labels[existingLabelIndex] = {
        ...labels[existingLabelIndex],
        ...labelEntry,
        updatedAt: now
      };
    } else {
      labels.unshift({
        ...labelEntry,
        importedFromBatch: String(item.batchId || "").trim(),
        importedBatchItemId: Number(item.id || 0),
        createdAt: now,
        updatedAt: now
      });
    }

    const candidateKey = buildCandidateKey(labelEntry);
    const existingCandidateIndex = candidates.findIndex((entry) => buildCandidateKey(entry) === candidateKey);
    if (existingCandidateIndex >= 0) {
      candidates[existingCandidateIndex] = {
        ...candidates[existingCandidateIndex],
        status: normalizedLabel === "uncertain" ? "uncertain" : "labeled",
        assignedLabel: normalizedLabel,
        updatedAt: now
      };
    }
  }

  writeLabels(labels, labelsPath);
  writeCandidates(candidates, candidatesPath);

  return {
    labelsImported: batchItems.length,
    trainableLabels: labels.filter((entry) => entry.label !== "uncertain").length,
    uncertainLabels: labels.filter((entry) => entry.label === "uncertain").length
  };
}

module.exports = {
  DEFAULT_LABELS_PATH,
  DEFAULT_MODEL_PATH,
  DEFAULT_CANDIDATES_PATH,
  ensureClassifierStorage,
  readLabels,
  writeLabels,
  upsertLabel,
  readModel,
  writeModel,
  readCandidates,
  writeCandidates,
  upsertCandidate,
  createLabelBatch,
  markCandidatesInBatch,
  applyLabeledBatch,
  trainClassifier,
  predictClassification,
  buildFeatureVector
};
