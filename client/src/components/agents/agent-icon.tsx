import type { ReactNode } from 'react';

import type { AgentIconId } from '@/lib/agent-icons';

const paths: Record<AgentIconId, ReactNode> = {
  spark: <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Zm7 13 .8 3.2L23 19l-3.2.8L19 23l-.8-3.2L15 19l3.2-.8L19 15Z" />,
  browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 8h18M7 6h.01M10 6h.01M8 16l3-3 2 2 3-4" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M10 5h4M11 18.5h2" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /><path d="m4 8 6-5 6 7 5-4" /></>,
  network: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="m10.7 7.2-4.4 8.6M13.3 7.2l4.4 8.6M7.5 18h9" /></>,
  pen: <><path d="m4 20 4.7-1 10.8-10.8a2.1 2.1 0 0 0-3-3L5.7 16 4 20Z" /><path d="m14.8 6.9 3 3M4 22h16" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 3 3 2-2 6 6" /></>,
  bot: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8" /><circle cx="12" cy="3" r="1" /></>,
  terminal: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m6 8 4 4-4 4M13 16h5" /></>,
  code: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3Z" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.5 4.5" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" /><path d="M4 5.5v16M8 7h8M8 11h8" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></>,
  rocket: <><path d="M14.5 4.5c2.1-2.1 5.4-2.4 6.9-1.9.5 1.5.2 4.8-1.9 6.9l-6.7 6.7-5-1-1-5 6.7-6.7Z" /><path d="m7.8 16.2-3.5 3.5M5.5 13.5l-3 1M10.5 18.5l-1 3M14 10h.01" /></>,
  shield: <><path d="M12 3 20 6v5c0 5-3.2 8.4-8 10-4.8-1.6-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.3 2.3 4.7-4.7" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  workflow: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 6h4a3 3 0 0 1 3 3v.5M15.5 14.5a3 3 0 0 1-3 3h-4" /></>,
  settings: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="4" /></>,
  message: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.7 8.7 0 0 1-3.6-.8L4 20l1.4-3.9A7.2 7.2 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
  mic: <><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>,
  megaphone: <><path d="m4 12 14-6v12L4 12Z" /><path d="M18 10h2a2 2 0 0 1 0 4h-2M7 13l1.5 6H5l-1-7" /></>,
  document: <><path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M8 12h6M8 16h6" /></>,
  puzzle: <><path d="M9 4a2.5 2.5 0 1 1 5 0v1h3a2 2 0 0 1 2 2v3h1a2.5 2.5 0 1 1 0 5h-1v3a2 2 0 0 1-2 2h-3v-1a2.5 2.5 0 1 0-5 0v1H6a2 2 0 0 1-2-2v-3h1a2.5 2.5 0 1 0 0-5H4V7a2 2 0 0 1 2-2h3V4Z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  bolt: <path d="m13 2-8 12h6l-1 8 8-12h-6l1-8Z" />,
  heart: <path d="M20.8 8.8c0 5-8.8 10.2-8.8 10.2S3.2 13.8 3.2 8.8A4.7 4.7 0 0 1 12 6.2a4.7 4.7 0 0 1 8.8 2.6Z" />,
  flag: <><path d="M5 21V4" /><path d="M5 5c4-3 7 3 14 0v9c-7 3-10-3-14 0" /></>,
};

export function AgentIcon({ icon }: { icon?: AgentIconId }) {
  return (
    <svg
      className="studio-agent-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[icon ?? 'spark']}
    </svg>
  );
}
