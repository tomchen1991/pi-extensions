// Fail closed: the Codex SDK normalizes even ordinary 429s to a ChatGPT
// "usage limit" message. That message alone is NOT evidence of exhausted quota.
export function hasQuotaCode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.code === "usage_limit_reached" || record.type === "usage_limit_reached") return true;
  return [record.error, record.response].some(child => {
    if (!child || typeof child !== "object") return false;
    const nested = child as Record<string, unknown>;
    return nested.code === "usage_limit_reached" || nested.type === "usage_limit_reached" ||
      (nested.error !== undefined && hasQuotaCode(nested.error));
  });
}

export function hasExhaustedQuotaHeaders(headers: Record<string, string>): boolean {
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return ["primary", "secondary"].some(window => {
    const value = normalized[`x-codex-${window}-used-percent`];
    return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 100;
  });
}

export function isQuotaError(text: string | undefined): boolean {
  if (!text) return false;
  // Exact machine code only. Human-friendly/HTTP-only messages are ambiguous.
  return /\busage_limit_reached\b/.test(text);
}
