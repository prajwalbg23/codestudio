export async function hashEditorText(source, cryptoApi = globalThis.crypto) {
  if (typeof source !== 'string' || !cryptoApi?.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('Secure text hashing is unavailable in this browser.');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isConfirmedPersistedRevision(revision, fileName, hashedText) {
  return Boolean(revision
    && revision.fileName === fileName
    && /^yrev1_[a-f0-9]{64}$/.test(revision.revisionId || '')
    && /^[a-f0-9]{64}$/.test(revision.sourceHash || '')
    && hashedText?.source !== undefined
    && hashedText.sourceHash === revision.sourceHash);
}
