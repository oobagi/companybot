import { TYPING_MS } from '@companybot/core/typing';
import { useEffect, useRef, useState } from 'react';

type Typist = { id: string; name: string; at: number };
const keyOf = (person: Typist) => `${person.id}:${person.at}`;

/** Each server ping gets one local lifetime; another person's ping must not extend it. */
export function useTypingPeople(people: readonly Typist[]) {
  const entries = useRef(new Map<string, { active: boolean; timer: ReturnType<typeof setTimeout> }>());
  const [visible, setVisible] = useState(people);
  useEffect(() => {
    const current = new Set(people.map(keyOf));
    for (const [key, entry] of entries.current) if (!current.has(key)) { clearTimeout(entry.timer); entries.current.delete(key); }
    for (const person of people) {
      const key = keyOf(person);
      if (entries.current.has(key)) continue;
      const entry = { active: true, timer: setTimeout(() => {
        entry.active = false;
        setVisible(previous => previous.filter(value => keyOf(value) !== key));
      }, TYPING_MS) };
      entries.current.set(key, entry);
    }
    setVisible(people.filter(person => entries.current.get(keyOf(person))?.active));
  }, [people]);
  useEffect(() => { const live = entries.current; return () => { for (const entry of live.values()) clearTimeout(entry.timer); live.clear(); }; }, []);
  return visible.filter(person => people.some(value => keyOf(value) === keyOf(person)));
}
