let operationLock: Promise<unknown> = Promise.resolve();

/**
 * Serialize helper operations that must not overlap.
 * The rejected-tail catch prevents one failure from poisoning future calls.
 */
export function enqueueGlobalOperation<T>(op: () => Promise<T>): Promise<T> {
  const run = operationLock.then(op, op);
  operationLock = run.catch(() => undefined);
  return run;
}
