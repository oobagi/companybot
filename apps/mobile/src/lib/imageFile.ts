import { imageError, imageHeadBytes, imageMaxBytes, imageMaxMb } from '@companybot/core/images';
import { FileMode, type File } from 'expo-file-system';

type ImageFile = Pick<File, 'size' | 'open'> | Pick<globalThis.File, 'size' | 'slice'>;

/** Sniff bounded bytes without Expo File.slice(), which constructs an unsupported RN Blob. */
export async function validateImageFile(file: ImageFile) {
  if (file.size > imageMaxBytes) throw new Error(`Pick an image under ${imageMaxMb} MB.`);
  let head: Uint8Array;
  if ('open' in file) {
    const handle = file.open(FileMode.ReadOnly);
    try { head = await handle.readBytes(imageHeadBytes); }
    finally { handle.close(); }
  } else head = new Uint8Array(await file.slice(0, imageHeadBytes).arrayBuffer());
  const problem = imageError(head, file.size);
  if (problem) throw new Error(problem);
}
