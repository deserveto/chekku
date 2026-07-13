import type { Metadata } from 'next';
import './globals.css';
import './studio.css';

export const metadata: Metadata = {
  title: 'Chekku — Agent Studio',
  description: 'Build and run Mastra agents with tools, memory, and browser delegation.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
