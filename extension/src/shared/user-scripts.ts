export const USER_SCRIPTS_SETUP_REQUIRED =
  "请在 chrome://extensions 中打开 Browser Key Automation 的详情，启用“允许用户脚本 / Allow User Scripts”，" +
  "然后重新加载本扩展并重新枚举实例。此浏览器开关须由用户手动开启；Root Key 不能替代它。";

// The API can be absent, throw synchronously, or reject after access is revoked.
// Querying registrations is read-only; never probe by executing page code.
export async function isUserScriptsAvailable(): Promise<boolean> {
  try {
    const api = chrome.userScripts;
    if (api === undefined) return false;
    await api.getScripts();
    return true;
  } catch {
    return false;
  }
}
