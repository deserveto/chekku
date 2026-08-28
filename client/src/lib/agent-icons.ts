export const AGENT_ICON_IDS = [
  'spark',
  'browser',
  'phone',
  'chart',
  'network',
  'pen',
  'compass',
  'image',
  'bot',
  'terminal',
  'code',
  'database',
  'globe',
  'search',
  'book',
  'mail',
  'calendar',
  'rocket',
  'shield',
  'target',
  'layers',
  'workflow',
  'settings',
  'message',
  'mic',
  'megaphone',
  'document',
  'puzzle',
  'clock',
  'bolt',
  'heart',
  'flag',
] as const;

export type AgentIconId = (typeof AGENT_ICON_IDS)[number];

const BUILT_IN_ICONS: Record<string, AgentIconId> = {
  'main-agent': 'spark',
  'qa-web-agent': 'browser',
  'qa-android-agent': 'phone',
  'pm-agent': 'chart',
  'social-media-supervisor-agent': 'network',
  'social-media-content-writer': 'pen',
  'social-media-strategist-agent': 'compass',
  'visual-content-agent': 'image',
};

export function isAgentIconId(value: unknown): value is AgentIconId {
  return typeof value === 'string'
    && (AGENT_ICON_IDS as readonly string[]).includes(value);
}

export function defaultAgentIcon(agentId: string): AgentIconId {
  return BUILT_IN_ICONS[agentId] ?? 'spark';
}

export function readAgentIcon(
  metadata: Record<string, unknown> | undefined,
  agentId: string,
): AgentIconId {
  const chekku = metadata?.chekku;
  const iconKey = chekku && typeof chekku === 'object'
    ? (chekku as Record<string, unknown>).iconKey
    : undefined;
  return isAgentIconId(iconKey) ? iconKey : defaultAgentIcon(agentId);
}

export function labelForAgentIcon(icon: AgentIconId): string {
  return {
    spark: 'Spark',
    browser: 'Browser',
    phone: 'Mobile',
    chart: 'Analysis',
    network: 'Network',
    pen: 'Writer',
    compass: 'Strategy',
    image: 'Visual',
    bot: 'Assistant',
    terminal: 'Terminal',
    code: 'Code',
    database: 'Data',
    globe: 'Web',
    search: 'Search',
    book: 'Knowledge',
    mail: 'Email',
    calendar: 'Schedule',
    rocket: 'Launch',
    shield: 'Security',
    target: 'Focus',
    layers: 'Layers',
    workflow: 'Workflow',
    settings: 'Settings',
    message: 'Chat',
    mic: 'Voice',
    megaphone: 'Broadcast',
    document: 'Document',
    puzzle: 'Utility',
    clock: 'Time',
    bolt: 'Fast',
    heart: 'Care',
    flag: 'Milestone',
  }[icon];
}
