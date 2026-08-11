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
