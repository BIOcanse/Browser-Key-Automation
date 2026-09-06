import { isUserScriptsAvailable } from "../shared/user-scripts.js";
import { applyTranslations, onLocaleChanged, t, type UiMessageKey } from "../ui/page-ui.js";

const setupCandidate = document.querySelector<HTMLElement>("[data-user-scripts-setup]");
if (setupCandidate === null) throw new Error("Missing User Scripts setup container");
const setup: HTMLElement = setupCandidate;

// Packaged UI only. No page or caller-provided HTML enters this container.
setup.innerHTML = `
  <div class="setup-heading"><span class="setup-mark" aria-hidden="true">JS</span><div><h2 data-user-scripts-status role="status" aria-live="polite"></h2><p data-user-scripts-message></p></div></div>
  <div class="setup-actions"><button class="button button-primary" type="button" data-open-script-settings data-i18n="openSettings"></button><button class="button button-secondary" type="button" data-recheck-user-scripts data-i18n="recheck"></button></div>
  <label class="setup-address" hidden><span data-i18n="settingsAddress"></span><input data-script-settings-url readonly data-i18n-aria="settingsAddress" spellcheck="false"></label>
  <p class="setup-result" data-script-settings-result role="status" aria-live="polite"></p>`;
applyTranslations(setup);

function required<ElementType extends Element>(selector: string): ElementType {
  const element = setup.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing setup element: ${selector}`);
  return element;
}

const status = required<HTMLElement>("[data-user-scripts-status]");
const message = required<HTMLElement>("[data-user-scripts-message]");
const result = required<HTMLElement>("[data-script-settings-result]");
const addressLabel = required<HTMLElement>(".setup-address");
const address = required<HTMLInputElement>("[data-script-settings-url]");
const settingsUrl = `chrome://extensions/?id=${chrome.runtime.id}`;
address.value = settingsUrl;
address.addEventListener("click", () => address.select());
let available = false;
let checking = false;
let resultKey: UiMessageKey | null = null;

function render(): void {
  status.textContent = t(available ? "setupReady" : "setupRequired");
  message.textContent = available ? "" : t("setupRequiredMessage");
  result.textContent = resultKey === null ? "" : t(resultKey);
}
onLocaleChanged(render);

async function check(): Promise<void> {
  if (checking) return;
  checking = true;
  status.textContent = t("setupChecking");
  try {
    available = await isUserScriptsAvailable();
    setup.setAttribute("data-user-scripts-state", available ? "ready" : "required");
    render();
  } finally { checking = false; }
}

required<HTMLButtonElement>("[data-open-script-settings]").addEventListener("click", () => {
  void chrome.tabs.create({ url: settingsUrl, active: true }).then(() => {
    resultKey = "setupOpened";
    addressLabel.hidden = true;
    render();
  }, () => {
    resultKey = "setupFailed";
    addressLabel.hidden = false;
    render();
  });
});
required<HTMLButtonElement>("[data-recheck-user-scripts]").addEventListener("click", () => window.location.reload());
window.addEventListener("focus", () => { void check(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
void check();
