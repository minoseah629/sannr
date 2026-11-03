// An observation difference is a prompt to inspect evidence, not a schema
// verdict or an authored explanation. Compare samples conservatively, with no
// payload values and no claims about absent fields or array member identity.
const MAX_CHANGES = 8, MAX_POINTER_LENGTH = 256;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const sameShape = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const completeClient = observation => observation?.source?.kind === 'client'
  && observation.verification === 'client-observation' && observation.basis === 'observed'
  && observation.outcome === 'success' && observation.complete === true
  && observation.request_shape && observation.response_shape
  && !(observation.omissions ?? []).some(note => /^request structure omitted /u.test(note));

function responseStatus(observation) {
  if (Number.isInteger(observation.response_status))
    return { value: observation.response_status, basis: 'response_status' };
  // Previous releases passed HTTP status into capture but stored only this
  // canonical adapter note. Read that explicit status without migrating the
  // record or interpreting arbitrary author prose as transport metadata.
  if (observation.source?.kind !== 'client' || observation.source.tool !== 'api_request:http'
    || observation.basis !== 'observed') return null;
  const notes = (observation.notes ?? []).map(note => /^HTTP response status ([0-9]{3})\.$/u.exec(note)).filter(Boolean);
  if (notes.length !== 1) return null;
  const value = Number(notes[0][1]);
  return value >= 100 && value <= 599 ? { value, basis: 'legacy_note' } : null;
}

function reference(observation, status) {
  // One bounded reference per side; all references remain with the observation.
  const refs = observation.evidence ?? [];
  const evidence = refs.find(ref => ref.path.length <= 256 && (ref.locator?.length ?? 0) <= 128);
  return { observation_id: observation.id,
    ...(evidence ? { evidence: { ...evidence } } : {}),
    ...(refs.length !== (evidence ? 1 : 0) ? { evidence_references_omitted: refs.length - (evidence ? 1 : 0) } : {}),
    ...(!refs.length ? { evidence_unavailable: true } : {}),
    ...(status ? { status_basis: status.basis } : {}) };
}

export function responseChangeNotice(current, history, identity) {
  if (!completeClient(current)) return null;
  const currentStatus = responseStatus(current);
  if (identity.protocol === 'http' && (!currentStatus || currentStatus.value < 200 || currentStatus.value >= 300)) return null;
  const previous = [...history].reverse().find(candidate => {
    if (!completeClient(candidate) || candidate.source.tool !== current.source.tool
      || !sameShape(candidate.request_shape, current.request_shape)) return false;
    const status = responseStatus(candidate);
    return identity.protocol !== 'http' || status?.value === currentStatus.value;
  });
  if (!previous) return null;
  const changes = []; let omitted = 0;
  const visit = (before, after, path) => {
    // Null samples commonly represent optional data; array samples have no
    // stable member pairing. Neither supports the comparison made here.
    if (['omitted', 'null'].includes(before.type) || ['omitted', 'null'].includes(after.type)) return;
    if (before.type !== after.type) {
      if (changes.length < MAX_CHANGES && path.length <= MAX_POINTER_LENGTH)
        changes.push({ path, previous_type: before.type, current_type: after.type });
      else omitted += 1;
      return;
    }
    if (before.type !== 'object') return;
    for (const key of Object.keys(before.properties).sort()) if (Object.hasOwn(after.properties, key))
      visit(before.properties[key], after.properties[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
  };
  visit(previous.response_shape, current.response_shape, '');
  if (!changes.length) return null;
  return { code: 'RESPONSE_STRUCTURE_CHANGED', kind: 'observation-difference',
    previous: reference(previous, identity.protocol === 'http' ? responseStatus(previous) : null),
    current: reference(current, identity.protocol === 'http' ? currentStatus : null),
    changes, ...(omitted ? { omitted_changes: omitted } : {}),
    meaning: 'Matched response types differ in comparable client observations; this is not schema validation or a semantic conclusion. Payload values, absent fields, null samples and array members were not compared.',
    next: 'Inspect these observations and reconcile existing guidance. If warranted, use api_context_record to record a scoped correction with the supporting evidence.' };
}

// Keep the signal and both identities when the response budget cannot retain
// detailed evidence. api_context can retrieve the complete observations.
export function compactResponseChangeNotice(notice, { minimal = false, signalOnly = false } = {}) {
  if (signalOnly) return { code: notice.code, details_omitted: true,
    next: 'Inspect api_context; if warranted, record a scoped correction with api_context_record.' };
  return { code: notice.code,
    previous_observation_id: notice.previous?.observation_id ?? notice.previous_observation_id,
    current_observation_id: notice.current?.observation_id ?? notice.current_observation_id,
    ...(!minimal && notice.changes?.length ? { changes: notice.changes.slice(0, 1) } : {}),
    details_omitted: true,
    next: 'Inspect the differing observations with api_context; this is not verification. If warranted, record a scoped correction with api_context_record.' };
}
