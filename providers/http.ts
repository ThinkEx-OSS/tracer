const REQUEST_TIMEOUT_MS = 15_000;

export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status?: number;

  constructor(provider: string, message: string, status?: number) {
    super(message);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.status = status;
  }
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

  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderRequestError(provider, `${provider} returned an invalid JSON response`);
  }
}

export function providerErrorMessage(error: unknown, fallback = "Provider request failed") {
  return error instanceof ProviderRequestError ? error.message : fallback;
}
