"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_LABELS_PATH,
  DEFAULT_MODEL_PATH,
  applyLabeledBatch,
  readLabels,
  trainClassifier,
  writeModel
} = require("../classifier");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    parsed[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    throw new Error("Missing required --file path to the labeled batch JSON");
  }

  const batchPath = path.resolve(args.file);
  const batch = JSON.parse(fs.readFileSync(batchPath, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(batch)) {
    throw new Error("Expected the batch file to contain a JSON array");
  }

  const importSummary = applyLabeledBatch(batch);
  console.log("[import-labeled-batch] Imported labels");
  console.log(`count: ${importSummary.labelsImported}`);
  console.log(`trainableLabels: ${importSummary.trainableLabels}`);
  console.log(`uncertainLabels: ${importSummary.uncertainLabels}`);

  if (String(args.train || "true").toLowerCase() === "false") {
    return;
  }

  const labels = readLabels(DEFAULT_LABELS_PATH);
  const model = trainClassifier(labels);
  writeModel(model, DEFAULT_MODEL_PATH);

  console.log("[import-labeled-batch] Trained classifier");
  console.log(`sampleCount: ${model.sampleCount}`);
  console.log(`trainingAccuracy: ${model.metrics.trainingAccuracy}`);
}

try {
  main();
} catch (error) {
  console.error("[import-labeled-batch] Failed");
  console.error(error.message);
  process.exitCode = 1;
}
