import { describe, it, expect } from 'vitest';
import {
  listAccountIds,
  resolveAccount,
  defaultAccountId,
  isEnabled,
  isConfigured,
} from '../src/config.js';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';

describe('config.ts', () => {
  describe('listAccountIds', () => {
    it('should return empty array for config without channels', () => {
      const cfg = {} as OpenClawConfig;
      expect(listAccountIds(cfg)).toEqual([]);
    });

    it('should return empty array for config without qq section', () => {
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      expect(listAccountIds(cfg)).toEqual([]);
    });

    it('should return account IDs from qq section', () => {
      const cfg = {
        channels: {
          qq: {
            default: { botQQ: '123' },
            account2: { botQQ: '456' },
          },
        },
      } as unknown as OpenClawConfig;
      const ids = listAccountIds(cfg);
      expect(ids).toContain('default');
      expect(ids).toContain('account2');
      expect(ids.length).toBe(2);
    });

    it('should handle single account', () => {
      const cfg = {
        channels: {
          qq: {
            primary: { botQQ: '123' },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(cfg)).toEqual(['primary']);
    });
  });

  describe('defaultAccountId', () => {
    it('should return first account ID if available', () => {
      const cfg = {
        channels: {
          qq: {
            first: { botQQ: '111' },
            second: { botQQ: '222' },
          },
        },
      } as unknown as OpenClawConfig;
      // Object.keys order is insertion order in modern JS
      expect(defaultAccountId(cfg)).toBe('first');
    });

    it('should return "default" when no accounts exist', () => {
      const cfg = {} as OpenClawConfig;
      expect(defaultAccountId(cfg)).toBe('default');
    });

    it('should return "default" when channels is empty', () => {
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      expect(defaultAccountId(cfg)).toBe('default');
    });
  });

  describe('resolveAccount', () => {
    it('should resolve account with full config', () => {
      const cfg = {
        channels: {
          qq: {
            test: {
              enabled: true,
              wsUrl: 'ws://localhost:3001',
              token: 'test-token',
              botQQ: '123456',
              dmPolicy: 'open',
              allowFrom: ['111', '222'],
              groupPolicy: 'allowlist',
              groupAllowFrom: ['1001', '1002'],
              thinkingIndicator: true,
              groupContextMessages: 30,
            },
          },
        },
      } as unknown as OpenClawConfig;
      
      const account = resolveAccount(cfg, 'test');
      expect(account).toEqual({
        accountId: 'test',
        enabled: true,
        wsUrl: 'ws://localhost:3001',
        token: 'test-token',
        botQQ: '123456',
        dmPolicy: 'open',
        allowFrom: ['111', '222'],
        groupPolicy: 'allowlist',
        groupAllowFrom: ['1001', '1002'],
        thinkingIndicator: true,
        groupContextMessages: 30,
      });
    });

    it('should apply default values for missing fields', () => {
      const cfg = {
        channels: {
          qq: {
            minimal: {
              botQQ: '123',
            },
          },
        },
      } as unknown as OpenClawConfig;
      
      const account = resolveAccount(cfg, 'minimal');
      expect(account).toEqual({
        accountId: 'minimal',
        enabled: true, // default
        wsUrl: 'ws://localhost:3001', // default
        token: '', // default
        botQQ: '123',
        dmPolicy: 'allowlist', // default
        allowFrom: [],
        groupPolicy: 'allowlist', // default
        groupAllowFrom: [],
        thinkingIndicator: false, // default
        groupContextMessages: 20, // default
      });
    });

    it('should use first account when accountId is not specified', () => {
      const cfg = {
        channels: {
          qq: {
            first: { botQQ: '111' },
            second: { botQQ: '222' },
          },
        },
      } as unknown as OpenClawConfig;
      
      const account = resolveAccount(cfg);
      expect(account.accountId).toBe('first');
      expect(account.botQQ).toBe('111');
    });

    it('should use "default" accountId when no accounts exist', () => {
      const cfg = {} as OpenClawConfig;
      const account = resolveAccount(cfg);
      expect(account.accountId).toBe('default');
    });

    it('should handle enabled: false', () => {
      const cfg = {
        channels: {
          qq: {
            disabled: {
              enabled: false,
              botQQ: '123',
            },
          },
        },
      } as unknown as OpenClawConfig;
      
      const account = resolveAccount(cfg, 'disabled');
      expect(account.enabled).toBe(false);
    });

    it('should normalize dmPolicy to "open" or "allowlist"', () => {
      const cfg1 = {
        channels: {
          qq: {
            test: { botQQ: '123', dmPolicy: 'open' },
          },
        },
      } as unknown as OpenClawConfig;
      
      expect(resolveAccount(cfg1, 'test').dmPolicy).toBe('open');

      const cfg2 = {
        channels: {
          qq: {
            test: { botQQ: '123', dmPolicy: 'allowlist' },
          },
        },
      } as unknown as OpenClawConfig;
      
      expect(resolveAccount(cfg2, 'test').dmPolicy).toBe('allowlist');

      const cfg3 = {
        channels: {
          qq: {
            test: { botQQ: '123', dmPolicy: 'invalid' },
          },
        },
      } as unknown as OpenClawConfig;
      
      expect(resolveAccount(cfg3, 'test').dmPolicy).toBe('allowlist');
    });

    it('should normalize groupPolicy to "open" or "allowlist"', () => {
      const cfg1 = {
        channels: {
          qq: {
            test: { botQQ: '123', groupPolicy: 'open' },
          },
        },
      } as unknown as OpenClawConfig;
      
      expect(resolveAccount(cfg1, 'test').groupPolicy).toBe('open');

      const cfg2 = {
        channels: {
          qq: {
            test: { botQQ: '123', groupPolicy: 'invalid' },
          },
        },
      } as unknown as OpenClawConfig;
      
      expect(resolveAccount(cfg2, 'test').groupPolicy).toBe('allowlist');
    });

    it('should convert allowFrom numbers to strings', () => {
      const cfg = {
        channels: {
          qq: {
            test: {
              botQQ: '123',
              allowFrom: [111, 222, '333'],
            },
          },
        },
      } as unknown as OpenClawConfig;
      
      const account = resolveAccount(cfg, 'test');
      expect(account.allowFrom).toEqual(['111', '222', '333']);
    });

    it('should convert groupAllowFrom numbers to strings', () => {
      const cfg = {
        channels: {
          qq: {
            test: {
              botQQ: '123',
              groupAllowFrom: [1001, 1002, '1003'],
            },
          },
        },
      } as unknown as OpenClawConfig;
      
      const account = resolveAccount(cfg, 'test');
      expect(account.groupAllowFrom).toEqual(['1001', '1002', '1003']);
    });

    it('should handle groupContextMessages edge cases', () => {
      const cfg1 = {
        channels: {
          qq: {
            test: { botQQ: '123', groupContextMessages: -5 },
          },
        },
      } as unknown as OpenClawConfig;
      expect(resolveAccount(cfg1, 'test').groupContextMessages).toBe(0);

      const cfg2 = {
        channels: {
          qq: {
            test: { botQQ: '123', groupContextMessages: 10.7 },
          },
        },
      } as unknown as OpenClawConfig;
      expect(resolveAccount(cfg2, 'test').groupContextMessages).toBe(10);

      const cfg3 = {
        channels: {
          qq: {
            test: { botQQ: '123', groupContextMessages: 0 },
          },
        },
      } as unknown as OpenClawConfig;
      expect(resolveAccount(cfg3, 'test').groupContextMessages).toBe(0);
    });
  });

  describe('isEnabled', () => {
    it('should return true for enabled account', () => {
      const account = resolveAccount({} as OpenClawConfig);
      account.enabled = true;
      expect(isEnabled(account)).toBe(true);
    });

    it('should return false for disabled account', () => {
      const account = resolveAccount({} as OpenClawConfig);
      account.enabled = false;
      expect(isEnabled(account)).toBe(false);
    });
  });

  describe('isConfigured', () => {
    it('should return true when both wsUrl and botQQ are set', () => {
      const account = resolveAccount({} as OpenClawConfig);
      account.wsUrl = 'ws://localhost:3001';
      account.botQQ = '123456';
      expect(isConfigured(account)).toBe(true);
    });

    it('should return false when wsUrl is missing', () => {
      const account = resolveAccount({} as OpenClawConfig);
      account.wsUrl = '';
      account.botQQ = '123456';
      expect(isConfigured(account)).toBe(false);
    });

    it('should return false when botQQ is missing', () => {
      const account = resolveAccount({} as OpenClawConfig);
      account.wsUrl = 'ws://localhost:3001';
      account.botQQ = '';
      expect(isConfigured(account)).toBe(false);
    });

    it('should return false when both are missing', () => {
      const account = resolveAccount({} as OpenClawConfig);
      account.wsUrl = '';
      account.botQQ = '';
      expect(isConfigured(account)).toBe(false);
    });
  });
});
