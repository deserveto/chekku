import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        pre: ({ children }) => <div className="code-block"><pre>{children}</pre></div>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
