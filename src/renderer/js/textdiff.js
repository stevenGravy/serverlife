/**
 * A plain line diff for two arbitrary text blobs — used to compare a
 * Helm release's values between two revisions. `diffYaml` (used
 * everywhere else in KubeLife) diffs *against a live cluster object*
 * via `kubectl diff`; there is no cluster object here, and no `helm
 * diff` plugin can be assumed installed, so this is its own small,
 * dependency-free LCS line diff. Values files are small — this only
 * needs to be correct and simple, not fast.
 */
export function diffLines(a, b) {
  // An empty blob is zero lines, not one blank line — `''.split('\n')`
  // would otherwise read as a single empty line and diff a genuinely
  // empty values.yaml against a real one as "every line changed."
  const linesA = a ? String(a).split('\n') : [];
  const linesB = b ? String(b).split('\n') : [];
  const n = linesA.length;
  const m = linesB.length;
  // lcs[i][j] = length of the longest common subsequence of linesA[i:] and linesB[j:].
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = linesA[i] === linesB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) { out.push({ type: 'same', line: linesA[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'remove', line: linesA[i] }); i++; }
    else { out.push({ type: 'add', line: linesB[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'remove', line: linesA[i] }); i++; }
  while (j < m) { out.push({ type: 'add', line: linesB[j] }); j++; }
  return out;
}
