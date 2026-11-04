import { describe, expect, it } from 'vitest';
import { boundDocumentSteps } from './requests';

describe('native document bridge boundary', () => {
  const changes = { version: 2, clientId: 'editor-a', steps: ['{"stepType":"replace"}'] };
  it('binds valid collaboration changes to the native page', () => {
    expect(boundDocumentSteps('native-page', changes)).toEqual({ id: 'native-page', ...changes });
  });
  it('rejects payload attempts to override the native page or workspace', () => {
    expect(() => boundDocumentSteps('native-page', { ...changes, id: 'another-page' })).toThrow();
    expect(() => boundDocumentSteps('native-page', { ...changes, workspaceId: 'another-workspace' })).toThrow();
  });
  it.each([null, [], { ...changes, version: NaN }, { ...changes, version: -1 }, { ...changes, clientId: {} }, { ...changes, steps: [null] }, { ...changes, steps: Array(1001).fill('step') }])('rejects malformed runtime payload %j', payload => {
    expect(() => boundDocumentSteps('native-page', payload)).toThrow();
  });
});
