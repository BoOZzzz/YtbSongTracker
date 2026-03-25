"use strict";

const {
  DEFAULT_LABELS_PATH,
  DEFAULT_MODEL_PATH,
  ensureClassifierStorage,
  readLabels,
  trainClassifier,
  writeModel
} = require("../classifier");

function main() {
  ensureClassifierStorage();

  const labels = readLabels(DEFAULT_LABELS_PATH);
  const model = trainClassifier(labels);
  writeModel(model, DEFAULT_MODEL_PATH);

  console.log("[Ytb Song Tracker] Classifier trained");
  console.log(`labels: ${model.sampleCount}`);
  console.log(`trainingAccuracy: ${model.metrics.trainingAccuracy}`);
  console.log(`modelPath: ${DEFAULT_MODEL_PATH}`);
}

try {
  main();
} catch (error) {
  console.error("[Ytb Song Tracker] Classifier training failed");
  console.error(error.message);
  process.exitCode = 1;
}
