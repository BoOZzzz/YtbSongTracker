"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_CANDIDATES_PATH,
  readCandidates,
  createLabelBatch,
  markCandidatesInBatch,
  writeCandidates
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
  const limit = clamp(Number(args.limit || 20), 1, 200);
  const batchId = args.batchId || `auto-label-batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputPath = path.resolve(args.out || path.join(__dirname, "..", "data", `${batchId}.json`));
  const candidates = readCandidates(DEFAULT_CANDIDATES_PATH);
  const batch = createLabelBatch(candidates, { limit, batchId });

  if (!batch.length) {
    console.log("[generate-label-batch] No pending candidates available");
    return;
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
  writeCandidates(markCandidatesInBatch(candidates, batch), DEFAULT_CANDIDATES_PATH);

  console.log("[generate-label-batch] Wrote labeling batch");
  console.log(`batchId: ${batchId}`);
  console.log(`count: ${batch.length}`);
  console.log(`path: ${outputPath}`);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

try {
  main();
} catch (error) {
  console.error("[generate-label-batch] Failed");
  console.error(error.message);
  process.exitCode = 1;
}
