'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface CompetitiveSlidesProps {
  analysisId: string;
  slidesMarkdown: string;
}

interface Rendered {
  html: string;
  css: string;
}

export function CompetitiveSlides({ analysisId, slidesMarkdown }: CompetitiveSlidesProps) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { Marp } = await import('@marp-team/marp-core');
        const result = new Marp({ script: false }).render(slidesMarkdown) as Rendered;
        if (cancelled) return;
        setRendered(result);
        setError(false);
      } catch {
        if (cancelled) return;
        setError(true);
        setRendered(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slidesMarkdown]);

  useEffect(() => {
    if (!rendered) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const slides = document.querySelectorAll<Element>('.competitive-slides-stage svg[data-marpit-svg]');
      if (slides.length === 0) return;
      const current = Array.from(slides).findIndex((slide) => {
        const rect = slide.getBoundingClientRect();
        return rect.top >= -10 && rect.bottom <= window.innerHeight + 10;
      });
      const targetIndex = event.key === 'ArrowRight'
        ? Math.min(current + 1, slides.length - 1)
        : Math.max(current - 1, 0);
      slides[targetIndex]?.scrollIntoView({ behavior: 'smooth' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rendered]);

  if (error) {
    return (
      <div className="studio-alert studio-alert-error" role="alert">
        <p>Could not render slides.</p>
        <p>
          <Link href={`/reports/competitive/${encodeURIComponent(analysisId)}`}>Back to analysis</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="competitive-slides-shell">
      <div className="competitive-slides-toolbar">
        <button type="button" className="studio-button" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {!rendered ? (
        <p className="competitive-slides-loading">Rendering deck…</p>
      ) : (
        <div className="competitive-slides-stage">
          <style dangerouslySetInnerHTML={{ __html: rendered.css }} />
          <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
      )}
    </div>
  );
}
