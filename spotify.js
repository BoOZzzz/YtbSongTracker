const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const SPOTIFY_MARKET = process.env.SPOTIFY_MARKET || "US";

const tokenCache = {
  accessToken: "",
  expiresAt: 0
};

async function verifyTrackCandidate(candidate) {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return {
      status: "unconfigured",
      match: null,
      candidates: []
    };
  }

  const queries = buildTrackQueries(candidate);
  if (!queries.length) {
    return {
      status: "skipped",
      match: null,
      candidates: []
    };
  }

  const token = await getAccessToken();
  const seenIds = new Set();
  const scored = [];

  for (const query of queries) {
    const items = await searchTracks(token, query);
    for (const item of items) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      scored.push({
        item,
        score: scoreTrackMatch(candidate, item),
        query
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0.68 || !isReliableMatch(candidate, best)) {
    return {
      status: "no_match",
      match: null,
      candidates: scored.slice(0, 5).map(formatCandidate),
      queries
    };
  }

  return {
    status: "matched",
    match: formatCandidate(best),
    candidates: scored.slice(0, 5).map(formatCandidate),
    queries
  };
}

function isReliableMatch(candidate, best) {
  const candidateArtist = normalizeForCompare(candidate.artist);
  const trackArtists = best.item.artists.map((artist) => normalizeForCompare(artist.name));
  const exactArtistMatch = candidateArtist && trackArtists.some((artist) => artist === candidateArtist);
  const inclusiveArtistMatch =
    candidateArtist &&
    trackArtists.some((artist) => artist.includes(candidateArtist) || candidateArtist.includes(artist));
  const artistOverlap = candidateArtist
    ? Math.max(0, ...trackArtists.map((artist) => tokenOverlap(candidateArtist, artist)))
    : 0;
  const artistSimilarity = candidateArtist
    ? Math.max(0, ...trackArtists.map((artist) => charSimilarity(compactString(candidateArtist), compactString(artist))))
    : 0;

  if (!candidateArtist) {
    return best.score >= 0.86;
  }

  if (exactArtistMatch || inclusiveArtistMatch || artistOverlap >= 0.6) {
    return best.score >= 0.68;
  }

  return best.score >= 0.9 && artistSimilarity >= 0.72;
}

function formatCandidate(entry) {
  return {
    score: Number(entry.score.toFixed(3)),
    id: entry.item.id,
    uri: entry.item.uri,
    title: entry.item.name,
    artist: entry.item.artists.map((artist) => artist.name).join(", "),
    album: entry.item.album?.name || "",
    externalUrl: entry.item.external_urls?.spotify || ""
  };
}

function buildTrackQueries(candidate) {
  const title = normalizeForSearch(candidate.title);
  const artist = normalizeForSearch(candidate.artist);
  const artistVariants = buildArtistVariants(artist);
  const queries = [];

  if (!title && !artist) return [];

  if (title && artist) {
    for (const variant of artistVariants) {
      pushUnique(queries, `track:${title} artist:${variant}`);
      pushUnique(queries, `${title} ${variant}`);
    }
  }

  if (title) {
    pushUnique(queries, title);
  }

  if (artist) {
    for (const variant of artistVariants) {
      pushUnique(queries, variant);
    }
  }

  return queries;
}

async function searchTracks(token, query) {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "5");
  url.searchParams.set("market", SPOTIFY_MARKET);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Spotify search failed with ${response.status}`);
  }

  const payload = await response.json();
  return payload?.tracks?.items || [];
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 15_000) {
    return tokenCache.accessToken;
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials"
    })
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed with ${response.status}`);
  }

  const payload = await response.json();
  tokenCache.accessToken = payload.access_token;
  tokenCache.expiresAt = now + Number(payload.expires_in || 3600) * 1000;
  return tokenCache.accessToken;
}

function scoreTrackMatch(candidate, track) {
  const candidateTitle = normalizeForCompare(candidate.title);
  const candidateArtist = normalizeForCompare(candidate.artist);
  const trackTitle = normalizeForCompare(track.name);
  const trackArtists = track.artists.map((artist) => normalizeForCompare(artist.name));

  let score = 0;

  if (candidateTitle && candidateTitle === trackTitle) {
    score += 0.62;
  } else if (candidateTitle && (trackTitle.includes(candidateTitle) || candidateTitle.includes(trackTitle))) {
    score += 0.44;
  } else {
    score += tokenOverlap(candidateTitle, trackTitle) * 0.4;
  }

  if (candidateArtist && trackArtists.some((artist) => artist === candidateArtist)) {
    score += 0.28;
  } else if (candidateArtist && trackArtists.some((artist) => artist.includes(candidateArtist) || candidateArtist.includes(artist))) {
    score += 0.2;
  } else if (candidateArtist) {
    const bestArtistOverlap = Math.max(0, ...trackArtists.map((artist) => tokenOverlap(candidateArtist, artist)));
    score += bestArtistOverlap * 0.18;
  }

  if (candidateTitle && trackTitle === candidateTitle) {
    score += 0.08;
  }

  if (candidateArtist && trackArtists.some((artist) => compactString(artist) === compactString(candidateArtist))) {
    score += 0.12;
  }

  if (candidateArtist) {
    const bestArtistCharSimilarity = Math.max(0, ...trackArtists.map((artist) => charSimilarity(compactString(candidateArtist), compactString(artist))));
    score += bestArtistCharSimilarity * 0.12;
  }

  if (candidate.rawTitle && /\blyric\s+video\b|\bofficial\s+audio\b|\bofficial\s+video\b/i.test(candidate.rawTitle)) {
    score += 0.03;
  }

  return Math.max(0, Math.min(1, score));
}

function tokenOverlap(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (!leftTokens.length || !rightTokens.length) return 0;

  const rightSet = new Set(rightTokens);
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) overlap += 1;
  }

  return overlap / Math.max(leftTokens.length, rightTokens.length);
}

function tokenize(value) {
  return normalizeForCompare(value)
    .split(" ")
    .filter(Boolean);
}

function normalizeForSearch(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildArtistVariants(artist) {
  const variants = [];
  if (!artist) return variants;

  pushUnique(variants, artist);
  pushUnique(variants, artist.replace(/([A-Za-z])([A-Z][a-z])/g, "$1 $2"));
  pushUnique(variants, artist.replace(/([^\s])([A-Z][a-z]+)/g, "$1 $2"));
  pushUnique(variants, artist.replace(/([A-Za-z])(\d)/g, "$1 $2"));
  pushUnique(variants, artist.replace(/(\d)([A-Za-z])/g, "$1 $2"));

  return variants;
}

function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(([^)]*)\)/g, " ")
    .replace(/\[([^\]]*)\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactString(value) {
  return normalizeForCompare(value).replace(/\s+/g, "");
}

function charSimilarity(left, right) {
  if (!left || !right) return 0;
  const rightChars = new Set(right.split(""));
  let overlap = 0;

  for (const char of left.split("")) {
    if (rightChars.has(char)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(left.length, right.length);
}

function pushUnique(list, value) {
  if (!value) return;
  if (!list.includes(value)) {
    list.push(value);
  }
}

module.exports = {
  verifyTrackCandidate
};
