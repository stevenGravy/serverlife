/**
 * Crash-loop and stalled-rollout detection, fed by whatever a kube
 * browser pane is already polling — not an independent background
 * monitor for clusters nobody has open (see the Section 8 plan for why:
 * a 24/7 per-cluster watch outliving the UI is a materially bigger
 * thing than this roadmap item asked for).
 *
 * Both work off the same trimmed `{name, namespace, ...}` row shape
 * `kube:resources` already returns (`kuberesources.js`'s `rowFrom()`),
 * not a full raw Kubernetes object — nothing here needs more than the
 * few extra fields `rowFrom()` already adds for exactly this (
 * `waitingReason`, `desiredReplicas`, `readyReplicas`), and the caller
 * tags each row with its own `kind` itself (since it already knows —
 * one `kube:resources` call per kind).
 */

/** A Pod Kubernetes itself has already labeled crash-looping — not a restart-count threshold guessed from outside. */
export function detectCrashLoops(pods) {
  return (pods || []).filter((p) => p.waitingReason === 'CrashLoopBackOff');
}

/**
 * A Deployment/StatefulSet short of its desired replicas, continuously,
 * for at least `thresholdMs` — a single snapshot can't tell "stalled"
 * from "just started rolling out," so the caller keeps `seenSince` (a
 * Map keyed by `${kind}/${namespace}/${name}`) across polls: the first
 * time a workload is seen unready, and cleared the moment it recovers.
 * Mutates `seenSince` in place (adding/removing entries) and returns the
 * ones that have been unready long enough to actually alert on.
 */
export function detectStalledRollouts(workloads, now, seenSince, thresholdMs = 300000) {
  const stalled = [];
  const seen = new Set();
  for (const w of workloads || []) {
    const key = `${w.kind}/${w.namespace}/${w.name}`;
    seen.add(key);
    const desired = w.desiredReplicas ?? 1;
    const ready = w.readyReplicas ?? 0;
    if (ready >= desired) { seenSince.delete(key); continue; }
    if (!seenSince.has(key)) { seenSince.set(key, now); continue; }
    if (now - seenSince.get(key) >= thresholdMs) stalled.push(w);
  }
  // A workload that no longer appears at all (deleted, or this poll
  // missed it) shouldn't keep counting toward a future alert forever.
  for (const key of [...seenSince.keys()]) if (!seen.has(key)) seenSince.delete(key);
  return stalled;
}
