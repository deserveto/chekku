import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  SOCIAL_ROLES,
  getRole,
  getActiveRole,
  setActiveRole,
  resourceIdFor,
  resolveCommandResponse,
  normalizeCommandWord,
  listRolesText,
  buildInstructions,
  buildCanonicalInstructions,
  buildRepurposeInstructions,
  buildInstructionsForRole,
  HELP_TEXT,
  unknownCommandReply,
  isTelegramConfigured,
  registerSocialSlashCommands,
} from '../social-media-content-writer.js';
import { socialMediaContentWriter } from '../social-media-content-writer.js';
import type { Chat, SlashCommandEvent } from 'chat';

describe('social-media-content-writer (Telegram-backed content writer)', () => {
  it('has id social-media-content-writer', () => {
    expect(socialMediaContentWriter.id).toBe('social-media-content-writer');
  });

  it('has name Social Media Content Writer', () => {
    expect(socialMediaContentWriter.name).toBe('Social Media Content Writer');
  });

  it('has Mastra memory for channel context', async () => {
    const memory = await socialMediaContentWriter.getMemory();
    expect(memory).toBeDefined();
  });

  it('binds get-current-time and send-email tools', async () => {
    const tools = await socialMediaContentWriter.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'getCurrentTimeTool',
      'sendEmailTool',
    ]);
  });
});

describe('SOCIAL_ROLES', () => {
  it('exposes the four platform writers plus a general role', () => {
    const ids = SOCIAL_ROLES.map((r) => r.id);
    expect(ids).toEqual(['general', 'x-writer', 'instagram-writer', 'linkedin-writer', 'tiktok-writer']);
  });

  it('every role carries label, description, and guidance', () => {
    for (const role of SOCIAL_ROLES) {
      expect(role.label.trim()).not.toBe('');
      expect(role.description.trim()).not.toBe('');
      expect(role.guidance.trim()).not.toBe('');
    }
  });
});

describe('getRole', () => {
  it('returns the matching role by id', () => {
    expect(getRole('x-writer').label).toBe('X / Twitter Writer');
  });

  it('falls back to general for unknown ids', () => {
    expect(getRole('does-not-exist').id).toBe('general');
  });

  it('falls back to general for undefined', () => {
    expect(getRole(undefined).id).toBe('general');
  });
});

describe('instagram-writer brand identity (scheduled-workflow source of truth)', () => {
  // The instagram-writer role is the voice the weekly-social-drafts workflow
  // pins via buildInstructionsForRole('instagram-writer'). The brand identity
  // strings below are surfaced in every greeting-card draft, so they must
  // live in the role guidance itself (not just in the workflow prompt).
  const role = getRole('instagram-writer');

  it('carries the R brand name, tagline, and sign-off', () => {
    expect(role.guidance).toContain('R — Your Gentle AI Companion');
    expect(role.guidance).toContain('AI Human-Centered Intelligence');
    expect(role.guidance).toContain('Keluarga Besar PT Rafiq Space Intelligence');
  });

  it('pins the reflective, non-promotional tone guardrail', () => {
    expect(role.guidance).toContain('reflective');
    expect(role.guidance).toContain('warm');
    expect(role.guidance).toContain('professional');
    expect(role.guidance).toContain('never hype');
  });

  it('allows well-known religious/cultural verses with attribution', () => {
    expect(role.guidance).toContain('Quran');
    expect(role.guidance).toContain('Surah reference');
    expect(role.guidance).toContain('attribution');
  });

  it('keeps the [source] placeholder rule for unverifiable claims', () => {
    expect(role.guidance).toContain('[source] placeholder');
    expect(role.guidance).toContain('statistics');
  });

  it('surfaces the brand identity in buildInstructions for the workflow', () => {
    const instructions = buildInstructionsForRole('instagram-writer');
    expect(instructions).toContain('R — Your Gentle AI Companion');
    expect(instructions).toContain('Keluarga Besar PT Rafiq Space Intelligence');
  });
});

describe('resourceIdFor', () => {
  it('joins platform and userId', () => {
    expect(resourceIdFor('telegram', '42')).toBe('telegram:42');
  });

  it('returns undefined for empty / whitespace userIds', () => {
    expect(resourceIdFor('telegram', '')).toBeUndefined();
    expect(resourceIdFor('telegram', '   ')).toBeUndefined();
    expect(resourceIdFor('telegram', undefined)).toBeUndefined();
  });
});

describe('active role state', () => {
  beforeEach(() => {
    setActiveRole(undefined, 'general');
  });

  it('defaults to general when no role is set for a resource', () => {
    expect(getActiveRole(undefined).id).toBe('general');
    expect(getActiveRole('telegram:nobody').id).toBe('general');
  });

  it('switches per-resource and isolates resources from each other', () => {
    setActiveRole('telegram:alice', 'linkedin-writer');
    setActiveRole('telegram:bob', 'tiktok-writer');

    expect(getActiveRole('telegram:alice').id).toBe('linkedin-writer');
    expect(getActiveRole('telegram:bob').id).toBe('tiktok-writer');
    expect(getActiveRole('telegram:carol').id).toBe('general');
  });

  it('coerces unknown role ids to general', () => {
    setActiveRole('telegram:alice', 'nope');
    expect(getActiveRole('telegram:alice').id).toBe('general');
  });
});

describe('normalizeCommandWord', () => {
  it('lowercases and strips @BotName suffix used in Telegram groups', () => {
    expect(normalizeCommandWord('/Switch')).toBe('/switch');
    expect(normalizeCommandWord('/switch@ChekkuSocialBot')).toBe('/switch');
  });
});

describe('resolveCommandResponse', () => {
  const resourceId = 'telegram:alice';

  beforeEach(() => {
    // resolveCommandResponse mutates the in-memory activeRoles map; reset
    // before each case so tests don't leak role state into each other.
    setActiveRole(resourceId, 'general');
  });

  it('answers /start and /help with the help text', () => {
    expect(resolveCommandResponse('/start', '', resourceId)).toBe(HELP_TEXT);
    expect(resolveCommandResponse('/help', '', resourceId)).toBe(HELP_TEXT);
  });

  it('lists roles for /roles', () => {
    const response = resolveCommandResponse('/roles', '', resourceId);
    expect(response).toContain('Available roles:');
    expect(response).toContain('x-writer');
    expect(response).toContain('Current: general');
  });

  it('shows current role for /role without arg', () => {
    setActiveRole(resourceId, 'instagram-writer');
    const response = resolveCommandResponse('/role', '', resourceId);
    expect(response).toBe('Current role: instagram-writer — Instagram Writer');
  });

  it('switches role for /switch <known-role>', () => {
    const response = resolveCommandResponse('/switch', 'x-writer', resourceId);
    expect(response).toContain('Switched to x-writer');
    expect(getActiveRole(resourceId).id).toBe('x-writer');
  });

  it('rejects /switch with no arg', () => {
    const response = resolveCommandResponse('/switch', '', resourceId);
    expect(response).toContain('Usage: /switch <role>');
  });

  it('rejects /switch with an unknown role', () => {
    const response = resolveCommandResponse('/switch', 'mars-writer', resourceId);
    expect(response).toContain('Unknown role "mars-writer"');
    expect(getActiveRole(resourceId).id).toBe('general');
  });

  it('returns null for unknown commands (caller posts the canned reply)', () => {
    expect(resolveCommandResponse('/make-coffee', '', resourceId)).toBeNull();
  });
});

describe('unknownCommandReply', () => {
  it('names the unrecognized command and points at /help', () => {
    const reply = unknownCommandReply('/make-coffee');
    expect(reply).toContain('Unknown command "/make-coffee"');
    expect(reply).toContain('/help');
  });
});

describe('listRolesText', () => {
  it('marks the current role with ▶', () => {
    const current = getRole('linkedin-writer');
    const text = listRolesText(current);
    expect(text).toContain('▶ linkedin-writer');
    expect(text).toContain('  general —');
    expect(text).toContain('Current: linkedin-writer');
  });
});

describe('buildInstructions', () => {
  it('embeds the active role id, label, and guidance', () => {
    const role = getRole('x-writer');
    const instructions = buildInstructions(role);
    expect(instructions).toContain('Active role: x-writer — X / Twitter Writer');
    expect(instructions).toContain(role.guidance.slice(0, 40));
  });

  it('keeps the drafting-only scope language in every role', () => {
    for (const role of SOCIAL_ROLES) {
      const instructions = buildInstructions(role);
      expect(instructions).toContain('draft and plan only');
      expect(instructions).toContain('Chekku Social');
    }
  });
});

describe('buildCanonicalInstructions', () => {
  it('frames the image brick as a designed 1:1 poster/infographic (not a photo, not video)', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('IMAGE BRICK');
    expect(instructions).toContain('platform-agnostic 1:1 image composition');
    expect(instructions).toContain('designed poster/infographic');
    expect(instructions).toContain('NOT a bare photograph');
    expect(instructions).toContain('NOT a video script');
    expect(instructions).toContain('ACTUAL TEXT drawn from this Canonical Content Unit');
    expect(instructions).toContain('Ground every panel in the source');
    expect(instructions).toContain('Do NOT include camera direction');
    expect(instructions).toContain('"carousel", "slide", or "reel"');
  });

  it('demands detailed visual brief properties for each panel', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('hero object');
    expect(instructions).toContain('environment');
    expect(instructions).toContain('emotional goal');
    expect(instructions).toContain('composition');
    expect(instructions).toContain('supporting elements');
    expect(instructions).toContain('negative constraints');
    expect(instructions).toContain('Overlay');
  });

  it('keeps the medium-form brick factual and hedged', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('Keep it factual');
    expect(instructions).toContain('diharapkan');
    expect(instructions).toContain('berpotensi');
  });

  it('uses the corrected 8 Blocks terminology (not "7-brick")', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('Canonical Content Unit — 8 Blocks');
    expect(instructions).not.toContain('7-brick');
    expect(instructions).not.toContain('7 brick');
  });

  it('documents the anti-strengthening factual integrity rules', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('Factual integrity rules');
    expect(instructions).toContain('traceable to a verified fact');
    expect(instructions).toContain('NEVER strengthen a claim');
    expect(instructions).toContain('assessment');
    expect(instructions).toContain('endorsement');
    expect(instructions).toContain('menilai kesiapan');
    expect(instructions).toContain('menyatakan siap');
  });

  it('distinguishes editorial framing from new factual claims in THESIS', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('Editorial framing is allowed in THESIS and HOOKS only');
    expect(instructions).toContain('the ANGLE you take on a fact, not a NEW fact');
  });

  it('allows an optional source-attribution panel when the source is verified', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('source-attribution panel');
    expect(instructions).toContain('Source: <publisher> • <year>');
    expect(instructions).toContain('OMIT this panel entirely if the source is unverifiable');
  });
});

describe('buildRepurposeInstructions (anti-drift)', () => {
  const repurposeInstructions = () => {
    const role: { id: string; label: string; guidance: string } = {
      id: 'instagram-writer',
      label: 'Instagram Writer',
      guidance: 'reflective warm tone',
    };
    return buildRepurposeInstructions(role as never);
  };

  it('documents what the repurpose step MAY change', () => {
    const text = repurposeInstructions();
    expect(text).toContain('You MAY change');
    expect(text).toContain('tone');
    expect(text).toContain('length');
    expect(text).toContain('structure');
    expect(text).toContain('hook wording');
  });

  it('documents what the repurpose step MAY NOT change', () => {
    const text = repurposeInstructions();
    expect(text).toContain('You MAY NOT change');
    expect(text).toContain('subject of the story');
    expect(text).toContain('factual claims');
    expect(text).toContain('scope');
    expect(text).toContain('chronology');
    expect(text).toContain('attribution');
    expect(text).toContain('meaning of the source');
  });

  it('includes the assessment-vs-endorsement mapping for the repurpose step', () => {
    const text = repurposeInstructions();
    expect(text).toContain('menilai kesiapan AI Indonesia');
    expect(text).toContain('mengakui');
    expect(text).toContain('mengesahkan');
  });

  it('preserves the hedged-wording rule for the repurpose step', () => {
    const text = repurposeInstructions();
    expect(text).toContain('berpotensi');
    expect(text).toContain('diharapkan');
    expect(text).toContain('FORBIDDEN: "akan"');
  });

  it('warns against dropping details that would make the remaining text misleading', () => {
    const text = repurposeInstructions();
    expect(text).toContain('clarity beats brevity');
  });
});

describe('buildCanonicalInstructions (pillar-aware + expanded anti-strengthening)', () => {
  it('documents pillar-aware voice for CELEBRATION, TECHNOLOGY, GENERAL', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('Pillar-aware voice');
    expect(instructions).toContain('CELEBRATION — voice is warm, respectful, elegant');
    expect(instructions).toContain('TECHNOLOGY & AI — voice is informative, intelligent, modern');
    expect(instructions).toContain('GENERAL / DIGITAL SOCIETY — voice is accessible');
  });

  it('aligns THESIS with the technology sub-angle when one is provided', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('AI Infrastructure');
    expect(instructions).toContain('AI Agents');
    expect(instructions).toContain('AI Explained');
  });

  it('expands the anti-strengthening mapping to planned/completed and announced/launched', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('"planned" / "direncanakan" / "target"');
    expect(instructions).toContain('"completed"');
    expect(instructions).toContain('"announced" / "diumumkan"');
    expect(instructions).toContain('"launched"');
    expect(instructions).toContain('menggunakan teknologi Nvidia');
    expect(instructions).toContain('Nvidia-owned facility');
  });

  it('requires contextual caveats to be preserved across bricks', () => {
    const instructions = buildCanonicalInstructions();
    expect(instructions).toContain('Contextual caveats from the source');
    expect(instructions).toContain('MUST be preserved');
    expect(instructions).toContain('Firmus adalah developer');
  });
});

describe('buildRepurposeInstructions (caveat preservation + expanded mapping)', () => {
  const repurposeInstructions = () => {
    const role: { id: string; label: string; guidance: string } = {
      id: 'instagram-writer',
      label: 'Instagram Writer',
      guidance: 'reflective warm tone',
    };
    return buildRepurposeInstructions(role as never);
  };

  it('preserves contextual caveats across the repurpose step', () => {
    const text = repurposeInstructions();
    expect(text).toContain('Contextual caveats from the canonical unit');
    expect(text).toContain('Firmus adalah developer');
    expect(text).toContain('clarity beats brevity');
  });

  it('expands the mapping to planned/completed, announced/launched, using-tech/owned', () => {
    const text = repurposeInstructions();
    expect(text).toContain('direncanakan');
    expect(text).toContain('telah selesai');
    expect(text).toContain('diumumkan');
    expect(text).toContain('diluncurkan');
    expect(text).toContain('menggunakan teknologi Nvidia');
    expect(text).toContain('milik Nvidia');
  });

  it('documents pillar-aware tone for the repurpose step', () => {
    const text = repurposeInstructions();
    expect(text).toContain('Pillar-aware tone');
    expect(text).toContain('CELEBRATION');
    expect(text).toContain('TECHNOLOGY & AI');
    expect(text).toContain('GENERAL / DIGITAL SOCIETY');
  });
});

describe('Telegram optional boot (issue #1 regression)', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('imports without throwing and omits channels when TELEGRAM_BOT_TOKEN is unset', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const mod = await import('../social-media-content-writer.js');
    expect(mod.socialMediaContentWriter.id).toBe('social-media-content-writer');
    expect(mod.isTelegramConfigured).toBe(false);
    expect(mod.socialMediaContentWriter.getChannels()).toBeNull();
    vi.unstubAllEnvs();
  });

  it('wires the Telegram channel when TELEGRAM_BOT_TOKEN is set', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const mod = await import('../social-media-content-writer.js');
    expect(mod.isTelegramConfigured).toBe(true);
    expect(mod.socialMediaContentWriter.getChannels()).not.toBeNull();
    vi.unstubAllEnvs();
  });

  it('exposes isTelegramConfigured as a boolean', () => {
    expect(typeof isTelegramConfigured).toBe('boolean');
  });
});

describe('registerSocialSlashCommands routing (issue #3 regression)', () => {
  type Handler = (event: SlashCommandEvent) => Promise<void>;

  function createMockSdk() {
    let handler: Handler | undefined;
    const sdk = {
      onSlashCommand(h: Handler) {
        handler = h;
      },
    };
    return {
      sdk: sdk as unknown as Chat,
      dispatch(event: SlashCommandEvent) {
        if (!handler) throw new Error('no handler registered');
        return handler(event);
      },
    };
  }

  function mockEvent(command: string, text = '') {
    const post = vi.fn().mockResolvedValue(undefined);
    const event = {
      adapter: { name: 'telegram' },
      user: { userId: '42' },
      channel: { id: 'tg-chat-1', post },
      command,
      text,
    } as unknown as SlashCommandEvent;
    return { event, post };
  }

  it('posts the known-command reply', async () => {
    const { sdk, dispatch } = createMockSdk();
    registerSocialSlashCommands(sdk);

    const { event, post } = mockEvent('/help');
    await dispatch(event);

    expect(post).toHaveBeenCalledWith(HELP_TEXT);
  });

  it('posts the canned "Unknown command" reply for an unknown command', async () => {
    // Issue #3: unknown slash commands must not be silently dropped nor fire an
    // LLM turn. Both wired paths (onDirectMessage + onSlashCommand) post the
    // canned reply so the user is told it is unrecognized and pointed at /help.
    const { sdk, dispatch } = createMockSdk();
    registerSocialSlashCommands(sdk);

    const { event, post } = mockEvent('/make-coffee', 'beans');
    await dispatch(event);

    expect(post).toHaveBeenCalledWith(unknownCommandReply('/make-coffee'));
  });
});
