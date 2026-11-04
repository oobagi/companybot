/** Plain data shared by native/web editors and the server's document schema. */
export const pageBlockConfig = {
  type: 'page',
  propSchema: { pageId: { default: '' } },
  content: 'none',
} as const;
