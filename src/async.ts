export type RaceResult<T> =
  | { status: "success"; value: T }
  | { status: "timeout" }
  | { status: "aborted" };

export async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  opts: { timeoutMs: number; abortSignal?: AbortSignal },
): Promise<RaceResult<T>> {
  const { timeoutMs, abortSignal } = opts;

  const timeoutPromise = new Promise<RaceResult<T>>((resolve) => {
    const timeoutId = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    // Clean up timeout if promise resolves first
    promise.finally(() => clearTimeout(timeoutId));
  });

  const abortPromise = new Promise<RaceResult<T>>((resolve) => {
    if (!abortSignal) {
      resolve({ status: "aborted" });
      return;
    }
    if (abortSignal.aborted) {
      resolve({ status: "aborted" });
      return;
    }
    const onAbort = () => resolve({ status: "aborted" });
    abortSignal.addEventListener("abort", onAbort, { once: true });
    // Clean up listener if promise resolves first
    promise.finally(() => abortSignal.removeEventListener("abort", onAbort));
  });

  try {
    const value = await Promise.race([promise, timeoutPromise, abortPromise]);
    if (value === timeoutPromise || value === abortPromise) {
      return value;
    }
    return { status: "success", value };
  } catch (err) {
    // Propagate errors from the main promise
    throw err;
  }
}
