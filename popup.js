const popupStatus = document.getElementById("popupStatus");
const popupTopSongs = document.getElementById("popupTopSongs");
const openOptionsButton = document.getElementById("openOptions");

document.addEventListener("DOMContentLoaded", loadPopupTopSongs);
openOptionsButton.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

async function loadPopupTopSongs() {
  popupStatus.textContent = "Loading top songs...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TOP_SONGS",
      payload: {
        month: getCurrentMonthValue(),
        limit: 10,
        minConfidence: 0.55
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load top songs");
    }

    const items = Array.isArray(response.result?.items) ? response.result.items : [];
    renderPopupSongs(items);
    popupStatus.textContent = items.length ? `${items.length} songs in this month's top list.` : "No songs tracked this month yet.";
  } catch (error) {
    popupTopSongs.innerHTML = `<li class="popup-empty">${escapeHtml(error.message)}</li>`;
    popupStatus.textContent = error.message;
  }
}

function renderPopupSongs(items) {
  if (!items.length) {
    popupTopSongs.innerHTML = `<li class="popup-empty">No top songs yet. Play a few songs and check back.</li>`;
    return;
  }

  popupTopSongs.innerHTML = items
    .map((item, index) => `
      <li class="popup-row">
        <span class="popup-rank">${index + 1}</span>
        <div>${renderPopupTitle(item)}</div>
        <span class="popup-artist">${escapeHtml(item.artist || "Unknown artist")}</span>
        <span class="popup-plays">${Number(item.playCount || 0)}</span>
      </li>
    `)
    .join("");
}

function renderPopupTitle(item) {
  const title = escapeHtml(item.title || "Unknown title");
  const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl.trim() : "";
  if (!sourceUrl) {
    return `<span class="popup-title">${title}</span>`;
  }

  return `<a class="popup-title" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noreferrer">${title}</a>`;
}

function getCurrentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
