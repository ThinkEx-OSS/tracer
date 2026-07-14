import { createFailure, type UserFacingFailure } from "../shared/failure";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly failure: UserFacingFailure;

  constructor(provider: string, message: string, status?: number) {
    super(message);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.status = status;
    this.failure = classifyProviderFailure(provider, message, status);
  }
}

function classifyProviderFailure(
  provider: string,
  detail: string,
  status?: number,
): UserFacingFailure {
  const normalized = detail.toLowerCase();
  const safeDetail = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|forbidden|not authorized/.test(normalized)
  ) {
    return createFailure({
      code: "provider_authentication",
      message: `${provider} rejected the configured credentials.`,
      action: `Verify the ${provider} token, account, and required permissions.`,
      retryable: false,
      source: "provider",
    });
  }
  if (status === 429) {
    return createFailure({
      code: "provider_rate_limited",
      message: `${provider} temporarily rate-limited the request.`,
      action: "Wait briefly, then run the checks again.",
      retryable: true,
      source: "provider",
    });
  }
  if (normalized.includes("timed out")) {
    return createFailure({
      code: "provider_timeout",
      message: `${provider} did not respond before the request timed out.`,
      action: "Run the checks again. If this persists, inspect provider availability.",
      retryable: true,
      source: "provider",
    });
  }
  if (normalized.includes("too large")) {
    return createFailure({
      code: "provider_response_too_large",
      message: `${provider} returned more data than Tracer can safely process.`,
      action: "Narrow the query or reduce the requested time window.",
      retryable: false,
      source: "provider",
    });
  }
  if (/invalid json|incompatible|no operation summary|invalid failure time/.test(normalized)) {
    return createFailure({
      code: "provider_invalid_response",
      message: `${provider} returned data Tracer could not understand.`,
      action: "Run the checks again. If this persists, inspect the provider response in logs.",
      retryable: true,
      source: "provider",
    });
  }
  return createFailure({
    code: "provider_request_failed",
    message: safeDetail,
    action: "Run the checks again. If this persists, inspect the provider configuration and logs.",
    retryable: true,
    source: "provider",
  });
}

export async function fetchProviderJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new ProviderRequestError(provider, `${provider} request ${reason}`);
  }

  if (!response.ok) {
    throw new ProviderRequestError(
      provider,
      `${provider} request failed with status ${response.status}`,
      response.status,
    );
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new ProviderRequestError(provider, `${provider} response was too large`);
  }

  try {
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new ProviderRequestError(provider, `${provider} response was too large`);
    }
    return JSON.parse(body) as T;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(provider, `${provider} returned an invalid JSON response`);
  }
}

export function providerFailure(error: unknown, fallback = "Provider request failed") {
  return error instanceof ProviderRequestError
    ? error.failure
    : createFailure({
        code: "provider_request_failed",
        message: fallback,
        action: "Run the checks again. If this persists, inspect provider logs.",
        retryable: true,
        source: "provider",
      });
}
