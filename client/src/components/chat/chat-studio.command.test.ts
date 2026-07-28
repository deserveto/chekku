import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatStudio = readFileSync(
  new URL('./chat-studio.tsx', import.meta.url),
  'utf8',
);

describe('chat-studio slash-command picker wiring', () => {
  it('imports the skill fetcher, the command menu, and the pure picker helpers', () => {
    expect(chatStudio).toContain('listAgentSkills');
    expect(chatStudio).toContain('CommandMenu');
    expect(chatStudio).toContain("from '@/lib/agent-skills'");
    expect(chatStudio).toContain(
      "from '@/components/chat/command-menu'",
    );
    expect(chatStudio).toContain(
      "from '@/components/chat/command-picker'",
    );
    expect(chatStudio).toContain('resolveCommandKey');
    expect(chatStudio).toContain('selectSkillByIndex');
  });

  it('declares the picker state slots', () => {
    expect(chatStudio).toContain('const [commandOpen, setCommandOpen]');
    expect(chatStudio).toContain(
      'const [commandIndex, setCommandIndex]',
    );
    expect(chatStudio).toContain('AgentSkillSummary[]');
  });

  it('fetches skills in a useEffect keyed on agentId', () => {
    expect(chatStudio).toContain('listAgentSkills(agentId)');
    expect(chatStudio).toMatch(/\}, \[agentId\]\);/);
  });

  it('derives filteredSkills by case-insensitive substring match', () => {
    expect(chatStudio).toContain('filteredSkills');
    expect(chatStudio).toContain('.toLowerCase().includes(');
    expect(chatStudio).toContain('commandFilterText(input)');
  });

  it('drives commandOpen via isCommandInput in onChange', () => {
    expect(chatStudio).toContain('isCommandInput');
    expect(chatStudio).toContain('setCommandOpen(isCommand)');
  });

  it('resolves command keys through resolveCommandKey before falling through to sendMessage', () => {
    // Slice from `const keyDown` so the ordering assertion is scoped to
    // the handler and not the whole module.
    const kdStart = chatStudio.indexOf('const keyDown');
    const kd = chatStudio.slice(kdStart);
    expect(kd).toContain('resolveCommandKey');
    expect(kd).toContain('selectCommand');
    expect(kd).toContain('sendMessage(input)');
    // selectSkillByIndex lives in selectCommand (file-level, asserted
    // above); the kd slice need only prove the handler delegates to
    // selectCommand for selection.
    // CRITICAL invariant: the command interception (resolveCommandKey
    // gating) must precede the Enter -> sendMessage fallback within
    // this handler, so that Tab/Enter select the highlighted skill
    // instead of submitting an in-progress slash command.
    expect(kd.indexOf('resolveCommandKey')).toBeLessThan(
      kd.indexOf('sendMessage(input)'),
    );
  });

  it('inserts the selected skill and closes the picker without a reserved catalog branch', () => {
    expect(chatStudio).toContain('setInput(`/${name} `)');
    expect(chatStudio).toContain('setCommandOpen(false)');
    // The retired /skills branch (which reset to a bare slash) is gone.
    expect(chatStudio).not.toContain("setInput('/')");
  });

  it('renders CommandMenu conditionally on commandOpen and a non-empty match set', () => {
    expect(chatStudio).toContain('<CommandMenu');
    expect(chatStudio).toContain('commands={filteredSkills}');
    // The render guard hides an empty menu so that typing an unmatched
    // slash token does not surface a blank listbox, while still letting
    // Enter fall through to send.
    expect(chatStudio).toContain('filteredSkills.length > 0');
  });
});
