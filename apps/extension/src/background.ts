import { attachAdminRouter, isTrustedAdminPort } from "./background/admin-router.js";
import { attachAdminEntry, openWelcomeOnInstall } from "./background/admin-entry.js";
import { attachDemoRouter, isTrustedDemoPort } from "./background/demo-service.js";
import {
  acceptTransportMessage,
  ensureTransportDocument,
  isTrustedTransportMessage,
} from "./background/transport-controller.js";
import { initializeOccupationService } from "./background/occupation-service.js";
import { initializeTabService } from "./background/tab-service.js";

const manifest = chrome.runtime.getManifest();
initializeTabService();
initializeOccupationService();
attachAdminEntry();

chrome.runtime.onConnect.addListener((port) => {
  if (isTrustedDemoPort(port)) { attachDemoRouter(port); return; }
  if (isTrustedAdminPort(port)) {
    attachAdminRouter(port);
    return;
  }
  port.disconnect();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedTransportMessage(message, sender)) return;
  void acceptTransportMessage(message).then(sendResponse, () => sendResponse(undefined));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.info("Browser Key Automation installed", {
    reason: details.reason,
    version: manifest.version,
  });
  void ensureTransportDocument();
  void openWelcomeOnInstall(details.reason).catch((error: unknown) => {
    console.error("Failed to open Browser Key Automation welcome page", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureTransportDocument();
});

void ensureTransportDocument();
