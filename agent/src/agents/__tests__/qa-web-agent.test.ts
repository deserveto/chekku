import { describe, it, expect } from 'vitest';

import { shouldApproveQaWebTool } from '../qa-web-agent.js';

describe('shouldApproveQaWebTool', () => {
  describe('sendEmailTool (consequential external action)', () => {
    it('requires approval in browser approval mode', () => {
      expect(shouldApproveQaWebTool('approval', 'sendEmailTool')).toBe(true);
    });

    it('requires approval even in full browser access mode', () => {
      // Regression: previously the whole gate was disabled when
      // browserAccess === 'full', so email bypassed approval. The gate matches
      // the tool registration key (`sendEmailTool`), not the tool id.
      expect(shouldApproveQaWebTool('full', 'sendEmailTool')).toBe(true);
    });

    it('requires approval when no browser access mode is set', () => {
      expect(shouldApproveQaWebTool(undefined, 'sendEmailTool')).toBe(true);
    });
  });

  describe('browser interaction tools (per-session access mode)', () => {
    it('requires approval for browser tools in approval mode', () => {
      expect(shouldApproveQaWebTool('approval', 'browser_click')).toBe(true);
      expect(shouldApproveQaWebTool('approval', 'browser_type')).toBe(true);
      expect(shouldApproveQaWebTool('approval', 'browser_drag')).toBe(true);
    });

    it('runs browser tools without approval in full access mode', () => {
      expect(shouldApproveQaWebTool('full', 'browser_click')).toBe(false);
      expect(shouldApproveQaWebTool('full', 'browser_type')).toBe(false);
    });

    it('defaults to gating browser tools when no mode is set', () => {
      expect(shouldApproveQaWebTool(undefined, 'browser_click')).toBe(true);
    });
  });

  describe('non-consequential tools', () => {
    it('never gates calculator / current-time tools', () => {
      expect(shouldApproveQaWebTool('approval', 'calculator')).toBe(false);
      expect(shouldApproveQaWebTool('full', 'getCurrentTime')).toBe(false);
      expect(shouldApproveQaWebTool(undefined, 'calculator')).toBe(false);
    });
  });
});
