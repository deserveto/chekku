export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      className={`studio-brand-mark ${className}`.trim()}
    >
      <path d="M5 8.5 16 3l11 5.5v15L16 29 5 23.5z" />
      <path d="m10 11 6-3 6 3-6 3zM10 16l6 3 6-3M10 21l6 3 6-3" />
    </svg>
  );
}
