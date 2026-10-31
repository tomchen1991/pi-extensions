export interface Config { endpoint: string; token: string; deviceId: string; projectId: string | null }
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** No filesystem, credential discovery, DNS resolution, or network access here. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.PI_MONITOR_URL;
  const token = env.PI_MONITOR_TOKEN;
  const deviceId = env.PI_MONITOR_DEVICE_ID;
  const projectId = env.PI_MONITOR_PROJECT_ID || null;
  if (!raw || !token || !deviceId) throw new Error("monitor_missing_config");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("monitor_invalid_url"); }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("monitor_invalid_url");
  // Literal loopback only: avoid relying on DNS for the cleartext exception.
  if (url.protocol === "ws:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("monitor_requires_wss");
  if (!identifier.test(deviceId) || (projectId !== null && !identifier.test(projectId))) throw new Error("monitor_invalid_id");
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error("monitor_invalid_token");
  return { endpoint: url.href, token, deviceId, projectId };
}
