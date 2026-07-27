import type { AgentSkillSummary } from '../../lib/agent-skills';

export interface CommandMenuProps {
  commands: readonly AgentSkillSummary[];
  activeIndex: number;
  onSelect: (name: string) => void;
}

export function CommandMenu({ commands, activeIndex, onSelect }: CommandMenuProps) {
  const rows = commands.map((c) => ({
    name: c.name,
    label: `/${c.name}`,
    description: c.description,
  }));
  const total = rows.length;
  const activeWrapped = total === 0 ? 0 : ((activeIndex % total) + total) % total;
  return (
    <div
      className="chat-command-menu"
      role="listbox"
      aria-label="Skill commands"
      aria-activedescendant={
        total === 0 ? undefined : `cmd-${rows[activeWrapped]!.name}`
      }
    >
      {rows.map((row, index) => (
        <button
          key={row.name}
          id={`cmd-${row.name}`}
          type="button"
          role="option"
          aria-selected={index === activeWrapped}
          className="chat-command-menu__option"
          onClick={() => onSelect(row.name)}
        >
          <span className="chat-command-menu__label">
            {row.label}
            <span className="chat-command-menu__type">Skill</span>
          </span>
          {row.description ? (
            <span className="chat-command-menu__desc">{row.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
