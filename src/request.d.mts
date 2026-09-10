export function requestWithTimeout<T>(request: (signal: AbortSignal) => PromiseLike<T>, timeoutMs?: number): Promise<T>;
