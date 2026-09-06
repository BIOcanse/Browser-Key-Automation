// Isolated test fixture only. No product Key/relay/native implementation.
chrome.runtime.onInstalled.addListener(() => {});
globalThis.__nativeFixtureReady = true;
