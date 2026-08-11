import Image, { type StaticImageData } from 'next/image';
import type { ReactNode } from 'react';

import { BrandMark } from '@/components/ui/brand-mark';

interface AuthLayoutProps {
  image: StaticImageData;
  imageAlt: string;
  eyebrow: string;
  title: string;
  description: string;
  quote: string;
  children: ReactNode;
}

export function AuthLayout({
  image,
  imageAlt,
  eyebrow,
  title,
  description,
  quote,
  children,
}: AuthLayoutProps) {
  return (
    <main className="auth-shell">
      <div className="auth-frame">
        <aside className="auth-visual">
          <Image
            src={image}
            alt={imageAlt}
            fill
            priority
            sizes="(max-width: 760px) 100vw, (max-width: 1080px) 42vw, 520px"
          />
          <div className="auth-visual-shade" aria-hidden="true" />
          <div className="auth-visual-brand">
            <BrandMark />
            <span>Chekku</span>
          </div>
          <p className="auth-visual-quote">{quote}</p>
        </aside>

        <section className="auth-content">
          <div className="auth-content-inner">
            <div className="auth-heading">
              <p className="auth-eyebrow">{eyebrow}</p>
              <h1 className="auth-title">{title}</h1>
              <p className="auth-description">{description}</p>
            </div>
            {children}
          </div>
          <p className="auth-security-note">
            Local-first by design <span aria-hidden="true">·</span> Your workspace stays yours
          </p>
        </section>
      </div>
    </main>
  );
}
