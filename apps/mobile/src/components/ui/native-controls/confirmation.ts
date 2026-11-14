export type ConfirmationQuestion = { title: string; body: string; action?: string; danger?: boolean };

/** An old native dialog must never approve a later request or work after unmount. */
export function createConfirmationController(present: (question: ConfirmationQuestion, settle: (answer: boolean) => void) => void) {
  let pending: ((answer: boolean) => void) | undefined;
  return {
    confirm(question: ConfirmationQuestion): Promise<boolean> {
      // Native alerts cannot be dismissed programmatically. Decline overlapping requests.
      if (pending) return Promise.resolve(false);
      return new Promise(resolve => {
        let settled = false;
        const settle = (answer: boolean) => {
          if (settled) return;
          settled = true;
          pending = undefined;
          resolve(answer);
        };
        pending = settle;
        try { present(question, settle); } catch { settle(false); }
      });
    },
    cancel() { pending?.(false); },
  };
}
