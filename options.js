const DEFAULT_SETTINGS = {
  backendUrl: "",
  syncBackendUrl: "",
  apiKey: "",
  listenThresholdSec: 30,
  minProgressPercent: 0.5,
  debug: false
};

const form = document.getElementById("settings-form");
const importForm = document.getElementById("import-form");
const status = document.getElementById("status");
const statsStatus = document.getElementById("statsStatus");
const topSongsList = document.getElementById("topSongsList");
const refreshStatsButton = document.getElementById("refreshStats");
const trackedSongsValue = document.getElementById("trackedSongsValue");
const totalPlaysValue = document.getElementById("totalPlaysValue");
const listeningTimeValue = document.getElementById("listeningTimeValue");
const statsMonthInput = document.getElementById("statsMonth");
const sourceBreakdown = document.getElementById("sourceBreakdown");
const toggleCorrectionModeButton = document.getElementById("toggleCorrectionMode");
const importFileInput = document.getElementById("importFile");
const importStatus = document.getElementById("importStatus");
const toggleMoreSongsButton = document.getElementById("toggleMoreSongs");
const moreSongsSection = document.getElementById("moreSongsSection");
const moreSongsList = document.getElementById("moreSongsList");
const toggleHistoryButton = document.getElementById("toggleHistory");
const historySection = document.getElementById("historySection");
const historyStatus = document.getElementById("historyStatus");
const historyList = document.getElementById("historyList");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const panels = {
  dashboard: document.getElementById("dashboardPanel"),
  about: document.getElementById("aboutPanel"),
  import: document.getElementById("importPanel"),
  settings: document.getElementById("settingsPanel")
};

const state = {
  historyExpanded: false,
  moreSongsExpanded: false,
  topSongs: [],
  correctionMode: false,
  summary: null,
  activeTab: "dashboard"
};

document.addEventListener("DOMContentLoaded", restoreSettings);
form.addEventListener("submit", saveSettings);
importForm.addEventListener("submit", importListenHistory);
refreshStatsButton.addEventListener("click", () => {
  void loadStats();
});
statsMonthInput.addEventListener("change", () => {
  void loadStats();
  if (state.historyExpanded) {
    void loadHistory();
  }
});
toggleMoreSongsButton.addEventListener("click", () => {
  toggleMoreSongs();
});
toggleCorrectionModeButton.addEventListener("click", () => {
  toggleCorrectionMode();
});
toggleHistoryButton.addEventListener("click", () => {
  void toggleHistory();
});

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    setActiveTab(button.getAttribute("data-tab") || "dashboard");
  });
}

async function restoreSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  document.getElementById("backendUrl").value = settings.backendUrl;
  document.getElementById("syncBackendUrl").value = settings.syncBackendUrl;
  document.getElementById("apiKey").value = settings.apiKey;
  document.getElementById("listenThresholdSec").value = settings.listenThresholdSec;
  document.getElementById("minProgressPercent").value = settings.minProgressPercent;
  document.getElementById("debug").checked = settings.debug;
  statsMonthInput.value = getCurrentMonthValue();

  setActiveTab("dashboard");
  await loadStats();
}

async function saveSettings(event) {
  event.preventDefault();

  const settings = {
    backendUrl: document.getElementById("backendUrl").value.trim(),
    syncBackendUrl: document.getElementById("syncBackendUrl").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim(),
    listenThresholdSec: Number(document.getElementById("listenThresholdSec").value || DEFAULT_SETTINGS.listenThresholdSec),
    minProgressPercent: Number(document.getElementById("minProgressPercent").value || DEFAULT_SETTINGS.minProgressPercent),
    debug: document.getElementById("debug").checked
  };

  await chrome.storage.sync.set(settings);
  status.textContent = "Settings saved.";
  await loadStats();

  window.setTimeout(() => {
    status.textContent = "";
  }, 2500);
}

async function loadStats() {
  resetStatsStatus("Loading top songs...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TOP_SONGS",
      payload: {
        month: statsMonthInput.value,
        limit: 1000,
        minConfidence: 0.55
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load top songs");
    }

    const payload = response.result || {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    state.topSongs = items;
    state.summary = payload.summary || null;
    renderTopSongs(items, payload.summary);
    renderMoreSongs(items);
    statsStatus.textContent = items.length
      ? `Updated ${formatRelativeTimestamp(new Date())} for ${payload?.period?.label || statsMonthInput.value}.`
      : `No tracked songs found for ${payload?.period?.label || statsMonthInput.value}.`;
  } catch (error) {
    renderEmptyState("Could not load local listening stats.");
    statsStatus.textContent = error.message;
  }
}

function renderTopSongs(items, summary) {
  trackedSongsValue.textContent = String(Math.min(items.length, 30));
  totalPlaysValue.textContent = String(Number(summary?.totalTrackedEvents || 0));
  listeningTimeValue.textContent = formatDuration(Number(summary?.totalListenedSeconds || 0));
  renderSourceBreakdown(summary?.sources || {});

  if (!items.length) {
    renderEmptyState("No top songs yet. Once listens are recorded, they will show up here.");
    return;
  }

  topSongsList.innerHTML = renderSongRows(items.slice(0, 30), 0, true);
  updateSongsTableMode();
  attachSongActions(topSongsList);
}

function renderMoreSongs(items) {
  const extraSongs = Array.isArray(items) ? items.slice(30) : [];

  if (!state.moreSongsExpanded) {
    moreSongsSection.hidden = true;
    moreSongsList.innerHTML = "";
    toggleMoreSongsButton.disabled = extraSongs.length === 0;
    toggleMoreSongsButton.textContent = extraSongs.length ? "Show more songs" : "No more songs";
    return;
  }

  moreSongsSection.hidden = false;
  toggleMoreSongsButton.disabled = extraSongs.length === 0;
  toggleMoreSongsButton.textContent = extraSongs.length ? "Hide more songs" : "No more songs";
  moreSongsList.innerHTML = extraSongs.length
    ? renderSongRows(extraSongs, 30, true)
    : `<div class="empty-state">No songs beyond the top 30 yet.</div>`;

  updateSongsTableMode();
  if (extraSongs.length) {
    attachSongActions(moreSongsList);
  }
}

function renderSongRows(items, startIndex, showRank) {
  return items
    .map((item, index) => {
      const title = escapeHtml(item.title || "Unknown title");
      const playCount = Number(item.playCount || 0);
      const listened = formatDuration(Number(item.totalListenedSeconds || 0));
      const titleMarkup = buildSongTitleMarkup(item, title);
      const artist = escapeHtml(item.artist || "Unknown artist");
      const rankCell = showRank ? `<span class="song-rank">${startIndex + index + 1}</span>` : `<span class="song-rank">-</span>`;

      return `
        <div class="song-row">
          ${rankCell}
          <div class="song-cell">${titleMarkup}</div>
          <div class="song-cell"><span class="song-artist">${artist}</span></div>
          <div class="song-cell"><span class="song-metric">${playCount}</span></div>
          <div class="song-cell"><span class="song-metric">${escapeHtml(listened)}</span></div>
          <div class="song-cell"><span class="song-metric">${escapeHtml(formatLocalDateTime(item.lastPlayedAt))}</span></div>
          <div class="song-cell song-action" ${state.correctionMode ? "" : "hidden"}>
            <button type="button" class="tiny-button" data-action="mark-video" data-group-key="${escapeAttribute(item.canonicalKey || "")}">Mark as video</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderEmptyState(message) {
  trackedSongsValue.textContent = "-";
  totalPlaysValue.textContent = "-";
  listeningTimeValue.textContent = "-";
  renderSourceBreakdown({});
  topSongsList.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  moreSongsSection.hidden = true;
  moreSongsList.innerHTML = "";
  state.moreSongsExpanded = false;
  toggleMoreSongsButton.disabled = true;
  toggleMoreSongsButton.textContent = "No more songs";
}

function renderSourceBreakdown(sources) {
  const entries = Object.entries(sources || {});

  if (!entries.length) {
    sourceBreakdown.innerHTML = "";
    return;
  }

  sourceBreakdown.innerHTML = entries
    .sort((left, right) => right[1] - left[1])
    .map(([sourceType, count]) => `<span class="source-chip">${escapeHtml(formatSourceType(sourceType))}: ${count}</span>`)
    .join("");
}

function resetStatsStatus(message) {
  statsStatus.textContent = message;
}

function toggleMoreSongs() {
  state.moreSongsExpanded = !state.moreSongsExpanded;
  moreSongsSection.hidden = !state.moreSongsExpanded;
  renderMoreSongs(state.topSongs);
}

function toggleCorrectionMode() {
  state.correctionMode = !state.correctionMode;
  toggleCorrectionModeButton.textContent = state.correctionMode ? "Disable correction mode" : "Enable correction mode";
  renderTopSongs(state.topSongs, state.summary);
  renderMoreSongs(state.topSongs);
}

async function toggleHistory() {
  state.historyExpanded = !state.historyExpanded;
  historySection.hidden = !state.historyExpanded;
  toggleHistoryButton.textContent = state.historyExpanded ? "Hide full history" : "Show full history";

  if (state.historyExpanded) {
    await loadHistory();
  }
}

async function loadHistory() {
  historyStatus.textContent = "Loading classified videos...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TOP_VIDEOS",
      payload: {
        month: statsMonthInput.value,
        minConfidence: 0.55
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load classified videos");
    }

    const items = Array.isArray(response.result?.items) ? response.result.items : [];
    renderHistory(items);
    historyStatus.textContent = items.length
      ? `${items.length} classified videos found for this month.`
      : "No classified videos found for this month.";
  } catch (error) {
    historyList.innerHTML = `<li class="empty-state">${escapeHtml(error.message)}</li>`;
    historyStatus.textContent = error.message;
  }
}

function renderHistory(items) {
  if (!items.length) {
    historyList.innerHTML = `<li class="empty-state">No classified videos yet.</li>`;
    return;
  }

  historyList.innerHTML = items
    .map((item) => {
      const title = escapeHtml(item.title || "Unknown title");
      const timestamp = escapeHtml(formatLocalDateTime(item.lastPlayedAt));
      const listened = escapeHtml(formatDuration(item.totalListenedSeconds || 0));
      const sourceLink = item.sampleVideoUrl || item.samplePageUrl || "";
      const sourceLabel = item.sourceType === "youtube_music" ? "Open YouTube Music" : "Open YouTube";
      const playCount = Number(item.playCount || 0);

      return `
        <li class="history-row">
          <div class="history-row-top">
            <span class="history-title">${title}</span>
            <span class="history-meta">${timestamp}</span>
          </div>
          <div class="history-actions-row">
            ${sourceLink ? `<a class="history-source" href="${escapeAttribute(sourceLink)}" target="_blank" rel="noreferrer">${escapeHtml(sourceLabel)}</a>` : escapeHtml(sourceLabel)}
            · ${playCount} ${playCount === 1 ? "play" : "plays"} · ${listened} listened
            <button type="button" class="tiny-button" data-action="mark-song" data-group-key="${escapeAttribute(item.groupKey || "")}">Mark as song</button>
          </div>
        </li>
      `;
    })
    .join("");

  attachHistoryActions();
}

async function importListenHistory(event) {
  event.preventDefault();

  const file = importFileInput.files?.[0];
  if (!file) {
    importStatus.textContent = "Choose a JSON file first.";
    return;
  }

  importStatus.textContent = "Reading file...";

  try {
    const rawText = await file.text();
    const parsed = JSON.parse(rawText);
    const response = await chrome.runtime.sendMessage({
      type: "IMPORT_LISTEN_HISTORY",
      payload: {
        source: "spotify",
        fileName: file.name,
        items: Array.isArray(parsed) ? parsed : parsed.items || parsed.data || []
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Import failed");
    }

    const payload = response.result || {};
    importStatus.textContent = `Imported ${payload.importedCount} listens, skipped ${payload.skippedDuplicates} duplicates, rejected ${payload.rejectedCount}.`;
    importFileInput.value = "";
    await loadStats();
    if (state.historyExpanded) {
      await loadHistory();
    }
  } catch (error) {
    importStatus.textContent = error.message;
  }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

function formatRelativeTimestamp(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function getCurrentMonthValue() {
  return getLocalMonthKey(new Date());
}

function formatSourceType(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatLocalDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "unknown time";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function getLocalMonthKey(date) {
  const value = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(value.getTime())) return getLocalMonthKey(new Date());
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function attachHistoryActions() {
  const buttons = historyList.querySelectorAll("[data-action='mark-song']");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      void markHistoryItemAsSong(button.getAttribute("data-group-key") || "");
    });
  }
}

function attachSongActions(container) {
  const buttons = container.querySelectorAll("[data-action='mark-video']");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      void markSongItemAsVideo(button.getAttribute("data-group-key") || "");
    });
  }
}

async function markHistoryItemAsSong(groupKey) {
  if (!groupKey) return;

  historyStatus.textContent = "Updating classification...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_CLASSIFICATION_OVERRIDE",
      payload: {
        groupKey,
        classification: "song"
      }
    });

    if (!response?.ok) throw new Error(response?.error || "Failed to update classification");

    await loadStats();
    if (state.historyExpanded) await loadHistory();
    historyStatus.textContent = `Marked as song. Updated ${response.result?.updatedCount || 0} listens.`;
  } catch (error) {
    historyStatus.textContent = error.message;
  }
}

async function markSongItemAsVideo(groupKey) {
  if (!groupKey) return;

  statsStatus.textContent = "Updating classification...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_CLASSIFICATION_OVERRIDE",
      payload: {
        groupKey,
        classification: "video"
      }
    });

    if (!response?.ok) throw new Error(response?.error || "Failed to update classification");

    await loadStats();
    if (state.historyExpanded) await loadHistory();
    statsStatus.textContent = `Marked as video. Updated ${response.result?.updatedCount || 0} listens.`;
  } catch (error) {
    statsStatus.textContent = error.message;
  }
}

function buildSongTitleMarkup(item, escapedTitle) {
  const link = item.sampleVideoUrl || item.samplePageUrl || item.spotifyExternalUrl || "";
  if (!link) return `<span class="song-title">${escapedTitle}</span>`;
  return `<a class="song-title" href="${escapeAttribute(link)}" target="_blank" rel="noreferrer">${escapedTitle}</a>`;
}

function updateSongsTableMode() {
  const table = document.querySelector(".songs-table");
  const more = document.querySelector(".more-songs-list");
  const headerAction = document.querySelector(".action-column");

  table?.classList.toggle("is-correction-mode", state.correctionMode);
  more?.classList.toggle("is-correction-mode", state.correctionMode);
  if (headerAction) headerAction.hidden = !state.correctionMode;
}

function setActiveTab(tabName) {
  state.activeTab = tabName;

  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== tabName;
  }

  for (const button of tabButtons) {
    button.classList.toggle("is-active", button.getAttribute("data-tab") === tabName);
  }
}
