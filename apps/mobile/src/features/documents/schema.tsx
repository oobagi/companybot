import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { createContext, useContext } from 'react';
import { pageBlockConfig } from '@companybot/core/page-block-config';
import { pageHref } from '@companybot/core/page-links';

export type Reference = { title: string; archived: boolean } | null;
export const References = createContext<Record<string, Reference>>({});
export const PageBlockActions = createContext<((blockId: string) => void) | null>(null);
const pageSpec = createReactBlockSpec(pageBlockConfig, {
  render: function PageBlock({ block, editor }) {
    const page = useContext(References)[block.props.pageId];
    const actions = useContext(PageBlockActions);
    return <div className="mobile-page-block" contentEditable={false}><a className="mobile-page-link" href={pageHref(block.props.pageId)}>
      <span aria-hidden>▤</span><span>{page?.title ?? 'Page'}</span>{page?.archived && <small>Archived</small>}{page === null && <small>Unavailable</small>}
    </a>{editor.isEditable && actions && <button type="button" aria-label={`Block actions for ${page?.title ?? 'page'}`} onPointerDown={event => event.preventDefault()} onClick={() => actions(block.id)}>•••</button>}</div>;
  },
  toExternalHTML: ({ block }) => <a href={pageHref(block.props.pageId)}>Page</a>,
})();

export const documentSchema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, page: pageSpec } });
export type PageEditor = typeof documentSchema.BlockNoteEditor;
