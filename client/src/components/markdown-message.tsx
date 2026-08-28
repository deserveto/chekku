import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { isSafeImageSrc } from '@/lib/safe-image-src';

// Memoized: chat streams update `messages` many times per second, and an
// unmemoized render re-parses every historical message's markdown per delta.
export const MarkdownMessage = memo(function MarkdownMessage({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, node, ...props }) => {
          void node;
          return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
        },
        img: ({ src, alt, node, ...props }) => {
          void node;
          const srcUrl = typeof src === 'string' ? src : '';
          if (!isSafeImageSrc(srcUrl)) {
            return null;
          }
          return (
            // Tool/agent image URLs are bounded storage routes or explicit
            // external URLs; next/image optimization does not apply here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              {...props}
              src={srcUrl}
              alt={alt ?? ''}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          );
        },
        pre: ({ children }) => <div className="code-block"><pre>{children}</pre></div>,
        table: ({ children, node, ...props }) => {
          void node;
          return (
            <div
              className="markdown-table-wrap"
              tabIndex={0}
              role="region"
              aria-label="Scrollable table"
            >
              <table {...props}>{children}</table>
            </div>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
