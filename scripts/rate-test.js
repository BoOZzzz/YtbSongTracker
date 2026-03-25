const fs = require("fs");
const path = require("path");

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl || "http://localhost:3000";
const endpointPath = "/api/spotify/search";
const requestsPerSecond = clamp(Number(args.rps || 1), 1, 20);
const durationSeconds = clamp(Number(args.duration || 30), 1, 600);
const queryFile = args.queries || path.join(__dirname, "sample-queries.json");

async function main() {
  const queries = loadQueries(queryFile);
  if (!queries.length) {
    throw new Error(`No queries found in ${queryFile}`);
  }

  console.log(`[rate-test] Base URL: ${baseUrl}`);
  console.log(`[rate-test] Requests/sec: ${requestsPerSecond}`);
  console.log(`[rate-test] Duration: ${durationSeconds}s`);
  console.log(`[rate-test] Queries loaded: ${queries.length}`);

  const startedAt = Date.now();
  const results = [];
  let sent = 0;
  let nextIndex = 0;

  while ((Date.now() - startedAt) / 1000 < durationSeconds) {
    const batchStartedAt = Date.now();
    const batch = [];

    for (let i = 0; i < requestsPerSecond; i += 1) {
      const query = queries[nextIndex % queries.length];
      nextIndex += 1;
      sent += 1;
      batch.push(runRequest(baseUrl, endpointPath, query, sent));
    }

    const batchResults = await Promise.all(batch);
    results.push(...batchResults);

    const elapsed = Date.now() - batchStartedAt;
    const delay = Math.max(0, 1000 - elapsed);
    if (delay > 0) {
      await sleep(delay);
    }
  }

  printSummary(results);
}

async function runRequest(baseUrl, endpointPath, query, requestNumber) {
  const url = new URL(endpointPath, baseUrl);
  if (query.title) url.searchParams.set("title", query.title);
  if (query.artist) url.searchParams.set("artist", query.artist);
  if (query.rawTitle) url.searchParams.set("rawTitle", query.rawTitle);

  const startedAt = Date.now();

  try {
    const response = await fetch(url);
    const durationMs = Date.now() - startedAt;
    const retryAfter = response.headers.get("retry-after");
    let payload = null;

    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    const result = {
      requestNumber,
      ok: response.ok,
      status: response.status,
      durationMs,
      retryAfter: retryAfter ? Number(retryAfter) : null,
      query,
      verificationStatus: payload?.result?.status || payload?.spotifyVerificationStatus || "",
      finalClassification: payload?.finalClassification || "",
      matchStatus: payload?.matchStatus || ""
    };

    if (response.status === 429) {
      console.log(`[rate-test] 429 on request #${requestNumber} retryAfter=${result.retryAfter ?? "n/a"}s query=${formatQuery(query)}`);
    }

    return result;
  } catch (error) {
    return {
      requestNumber,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      retryAfter: null,
      query,
      verificationStatus: "",
      finalClassification: "",
      matchStatus: "",
      error: error.message
    };
  }
}

function printSummary(results) {
  const total = results.length;
  const ok = results.filter((result) => result.ok).length;
  const status429 = results.filter((result) => result.status === 429);
  const failures = results.filter((result) => !result.ok && result.status !== 429);
  const avgDuration = total ? Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / total) : 0;

  console.log("");
  console.log("[rate-test] Summary");
  console.log(`  Total requests: ${total}`);
  console.log(`  Successful responses: ${ok}`);
  console.log(`  429 responses: ${status429.length}`);
  console.log(`  Other failures: ${failures.length}`);
  console.log(`  Average duration: ${avgDuration}ms`);

  if (status429.length) {
    const retryValues = status429.map((result) => result.retryAfter).filter((value) => Number.isFinite(value));
    if (retryValues.length) {
      console.log(`  Retry-After values: ${retryValues.join(", ")}`);
    }
  }

  if (failures.length) {
    console.log("");
    console.log("[rate-test] Failure samples");
    for (const failure of failures.slice(0, 5)) {
      console.log(`  #${failure.requestNumber} status=${failure.status} error=${failure.error || "n/a"} query=${formatQuery(failure.query)}`);
    }
  }
}

function loadQueries(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array in ${absolutePath}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatQuery(query) {
  return JSON.stringify(query);
}

main().catch((error) => {
  console.error("[rate-test] Failed", error.message);
  process.exitCode = 1;
});

