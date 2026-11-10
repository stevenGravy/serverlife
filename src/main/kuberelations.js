'use strict';
/**
 * Where a resource leads next — the chains kubescan.js's label-selector
 * matching never reaches, because none of these are label relationships:
 * a Pod's own metadata already says who made it (`ownerReferences`), a
 * PersistentVolumeClaim says which PersistentVolume it is bound to by
 * name, and a Service's Endpoints object is simply the one with the same
 * name in the same namespace. One hop at a time — the detail panel walks
 * further by fetching the next object and asking this again, the same way
 * a person clicking through would.
 */

/** Candidates to jump to from one full (already-fetched) object. Pure — no IO. */
function relatedOf(object) {
  if (!object || typeof object !== 'object') return [];
  const kind = object.kind;
  const name = object.metadata?.name;
  const namespace = object.metadata?.namespace || null;
  const out = [];

  const owners = object.metadata?.ownerReferences || [];
  const owner = owners.find((o) => o.controller) || owners[0];
  if (owner?.kind && owner?.name) out.push({ kind: owner.kind, name: owner.name, namespace, via: 'owner' });

  if (kind === 'PersistentVolumeClaim' && object.spec?.volumeName) {
    out.push({ kind: 'PersistentVolume', name: object.spec.volumeName, namespace: null, via: 'volumeName' });
  }
  if (kind === 'Service' && name) {
    out.push({ kind: 'Endpoints', name, namespace, via: 'same name' });
  }
  return out;
}

module.exports = { relatedOf };
