/** Interrupted external calls may have taken effect; never present them as a safe failure. */
export function approvalFailure(approval: { outcome: string | null; error: string | null }) {
  const uncertain = approval.outcome === 'unknown';
  return {
    uncertain,
    text: uncertain
      ? `Allowed, but it may or may not have happened.${approval.error ? ` ${approval.error}` : ''}`
      : `Failed${approval.error ? `: ${approval.error}` : '.'}`,
  };
}
