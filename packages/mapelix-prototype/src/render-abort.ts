/** Shared cancellation reason for queued and running tile renders. */
export function renderAbortError(): DOMException {
  return new DOMException("The tile render was aborted", "AbortError");
}
