const DEFAULT_SETTINGS = {
  backendUrl: "",
  apiKey: "",
  listenThresholdSec: 30,
  minProgressPercent: 0.5,
  debug: false
};

const form = document.getElementById("settings-form");
const status = document.getElementById("status");

document.addEventListener("DOMContentLoaded", restoreSettings);
form.addEventListener("submit", saveSettings);

async function restoreSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  document.getElementById("backendUrl").value = settings.backendUrl;
  document.getElementById("apiKey").value = settings.apiKey;
  document.getElementById("listenThresholdSec").value = settings.listenThresholdSec;
  document.getElementById("minProgressPercent").value = settings.minProgressPercent;
  document.getElementById("debug").checked = settings.debug;
}

async function saveSettings(event) {
  event.preventDefault();

  const settings = {
    backendUrl: document.getElementById("backendUrl").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim(),
    listenThresholdSec: Number(document.getElementById("listenThresholdSec").value || DEFAULT_SETTINGS.listenThresholdSec),
    minProgressPercent: Number(document.getElementById("minProgressPercent").value || DEFAULT_SETTINGS.minProgressPercent),
    debug: document.getElementById("debug").checked
  };

  await chrome.storage.sync.set(settings);
  status.textContent = "Settings saved.";

  window.setTimeout(() => {
    status.textContent = "";
  }, 2500);
}
