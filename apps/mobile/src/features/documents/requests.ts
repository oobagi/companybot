/** Native bridge payloads are untrusted runtime values, regardless of TS annotations. */
export function boundDocumentSteps(pageId: string, input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('Invalid document changes.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['version', 'clientId', 'steps'].includes(key))) throw new Error('Unexpected document operation.');
  const { version, clientId, steps } = value;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 ||
    !(typeof clientId === 'string' || (typeof clientId === 'number' && Number.isFinite(clientId))) ||
    !Array.isArray(steps) || steps.length > 1000 || steps.some(step => typeof step !== 'string')) throw new Error('Invalid document changes.');
  return { id: pageId, version, clientId, steps: steps as string[] };
}
