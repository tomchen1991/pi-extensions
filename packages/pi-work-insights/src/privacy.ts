// Conservative omission, not a claim of complete secret detection.
const patterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
  /(?:password|passwd|api[_-]?key|access[_-]?token|secret|密码|密钥)["']?\s*[:=]\s*["']?[^\s"',}]{4,}/i,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/i,
  /[?&](?:token|key|password|secret|signature|sig)=[^\s&]+/i,
  /data:[^\s;]+;base64,/i,
  /[A-Za-z0-9+/]{200,}={0,2}/,
];
export function hasSensitiveText(text: string): boolean {
  return patterns.some(pattern => pattern.test(text));
}
export function safeText(text: string): string | undefined {
  // Inspect BEFORE truncating, so secrets straddling a boundary cannot leak.
  if (hasSensitiveText(text)) return undefined;
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
