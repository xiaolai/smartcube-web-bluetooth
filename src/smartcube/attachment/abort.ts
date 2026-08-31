/** The error every cancellable step rejects with when its AbortSignal fires. */
export function abortError(): DOMException {
    return new DOMException('Aborted', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw abortError();
    }
}
