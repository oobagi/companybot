import { expect, it, vi } from 'vitest';
import { imageHeadBytes, imageMaxBytes } from '@companybot/core/images';
import { validateImageFile } from './imageFile';
vi.mock('expo-file-system', () => ({ FileMode: { ReadOnly: 'r' } }));
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
it('reads only the native signature bytes in read-only mode and closes the handle', async () => {
  const readBytes = vi.fn(async () => png); const close = vi.fn();
  const open = vi.fn(() => ({ readBytes, close }));
  const file = { size: 100, open, slice: () => { throw new Error('RN Blob unsupported'); } };
  await validateImageFile(file as unknown as Parameters<typeof validateImageFile>[0]);
  expect(open).toHaveBeenCalledWith('r'); expect(readBytes).toHaveBeenCalledWith(imageHeadBytes); expect(close).toHaveBeenCalledOnce();
});
it('closes native handles on failure and rejects oversized files before reading', async () => {
  const close = vi.fn(); const open = vi.fn(() => ({ readBytes: async () => { throw new Error('Read failed'); }, close }));
  const file = { size: 100, open } as unknown as Parameters<typeof validateImageFile>[0];
  await expect(validateImageFile(file)).rejects.toThrow('Read failed'); expect(close).toHaveBeenCalledOnce();
  open.mockClear();
  await expect(validateImageFile({ ...file, size: imageMaxBytes + 1 })).rejects.toThrow('Pick an image under'); expect(open).not.toHaveBeenCalled();
});
it('keeps browser slicing and rejects non-image content', async () => {
  await validateImageFile(new Blob([png]));
  await expect(validateImageFile(new Blob(['not an image']))).rejects.toThrow('Pick a PNG');
});
