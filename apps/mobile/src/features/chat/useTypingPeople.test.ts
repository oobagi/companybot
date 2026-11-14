// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TYPING_MS } from '@companybot/core/typing';
import { useTypingPeople } from './useTypingPeople';

type Person = { id: string; name: string; at: number };
let root: Root;
let host: HTMLDivElement;
function Example({ people }: { people: Person[] }) {
  return createElement('span', null, useTypingPeople(people).map(person => person.name).join(', '));
}
const show = (people: Person[]) => act(() => root.render(createElement(Example, { people })));
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('expires each received ping independently, regardless of the server clock', () => {
  const ada = { id: 'a', name: 'Ada', at: -99_000 };
  const ben = { id: 'b', name: 'Ben', at: 999_999_999_999 };
  show([ada]); expect(host.textContent).toBe('Ada');
  act(() => vi.advanceTimersByTime(TYPING_MS / 2));
  show([ada, ben]); expect(host.textContent).toBe('Ada, Ben');
  act(() => vi.advanceTimersByTime(TYPING_MS / 2));
  expect(host.textContent).toBe('Ben');
  // A new query result with the same ping must not resurrect expired Ada.
  show([{ ...ada }, { ...ben }]); expect(host.textContent).toBe('Ben');
  act(() => vi.advanceTimersByTime(TYPING_MS / 2));
  expect(host.textContent).toBe('');
});

it('renews a new ping and removes people immediately when they stop typing', () => {
  const ada = { id: 'a', name: 'Ada', at: 1 };
  show([ada]); act(() => vi.advanceTimersByTime(TYPING_MS - 1));
  show([{ ...ada, at: 2 }]); act(() => vi.advanceTimersByTime(1));
  expect(host.textContent).toBe('Ada');
  show([]); expect(host.textContent).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});
