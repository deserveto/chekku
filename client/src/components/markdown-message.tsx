import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, node, ...props }) => {
          void node;
          return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
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
}
