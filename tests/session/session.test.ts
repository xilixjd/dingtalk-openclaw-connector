import { describe, it, expect, beforeEach } from 'vitest';
import { __testables } from '../../test';

const {
  normalizeSlashCommand,
  buildSessionContext,
  isMessageProcessed,
  markMessageProcessed,
  cleanupProcessedMessages,
} = __testables as any;

describe('session management helpers', () => {
  beforeEach(() => {
    // 通过多次 cleanup 尽可能清空内部 Map（超过 TTL 的条目会被清理）
    cleanupProcessedMessages();
  });

  describe('normalizeSlashCommand', () => {
    it.each([
      ['', ''],
      ['   ', '   '], // 非命令返回原文，不强制 trim 成空
      ['/new', '/new'],
      [' /new ', '/new'],
      ['/NEW', '/new'],
      ['/New', '/new'],
      ['/reset', '/new'],
      ['/clear', '/new'],
      ['新会话', '/new'],
      ['重新开始', '/new'],
      ['清空对话', '/new'],
      ['  新会话  ', '/new'],
      ['hello', 'hello'],
      [' /not-a-command ', ' /not-a-command '],
      ['/new session', '/new session'],
      ['new', 'new'],
      ['新会话xxx', '新会话xxx'],
    ] as const)('"%s" -> "%s"', (input, expected) => {
      expect(normalizeSlashCommand(input)).toBe(expected);
    });
  });

  describe('buildSessionContext', () => {
    const base = {
      accountId: 'acc-1',
      senderId: 'u-1',
      senderName: 'Alice',
      groupSubject: 'Test Group',
    };

    it('should keep single-user session when separateSessionByConversation=false', () => {
      const ctx = buildSessionContext({
        ...base,
        conversationType: '2',
        conversationId: 'cid-1',
        separateSessionByConversation: false,
      });

      expect(ctx).toEqual({
        channel: 'dingtalk-connector',
        accountId: 'acc-1',
        chatType: 'group',
        peerId: 'u-1',
        senderName: 'Alice',
      });
    });

    it('should build direct chat session when conversationType=1', () => {
      const ctx = buildSessionContext({
        ...base,
        conversationType: '1',
        conversationId: undefined,
      });

      expect(ctx).toEqual({
        channel: 'dingtalk-connector',
        accountId: 'acc-1',
        chatType: 'direct',
        peerId: 'u-1',
        senderName: 'Alice',
      });
    });

    it('should build group-shared session by default', () => {
      const ctx = buildSessionContext({
        ...base,
        conversationType: '2',
        conversationId: 'cid-1',
      });

      expect(ctx).toEqual({
        channel: 'dingtalk-connector',
        accountId: 'acc-1',
        chatType: 'group',
        peerId: 'cid-1',
        conversationId: 'cid-1',
        senderName: 'Alice',
        groupSubject: 'Test Group',
      });
    });

    it('should build group+sender isolated session when groupSessionScope=group_sender', () => {
      const ctx = buildSessionContext({
        ...base,
        conversationType: '2',
        conversationId: 'cid-1',
        groupSessionScope: 'group_sender',
      });

      expect(ctx).toEqual({
        channel: 'dingtalk-connector',
        accountId: 'acc-1',
        chatType: 'group',
        peerId: 'cid-1:u-1',
        conversationId: 'cid-1',
        senderName: 'Alice',
        groupSubject: 'Test Group',
      });
    });

    it('should use senderId as peerId when conversationId is undefined (group)', () => {
      const ctx = buildSessionContext({
        ...base,
        conversationType: '2',
        conversationId: undefined,
      });
      expect(ctx.chatType).toBe('group');
      expect(ctx.peerId).toBe('u-1');
    });

    it('should use senderId as peerId when conversationId is empty string (group)', () => {
      const ctx = buildSessionContext({
        ...base,
        conversationType: '2',
        conversationId: '',
      });
      expect(ctx.peerId).toBe('u-1');
      expect(ctx.sessionPeerId).toBe('u-1');
    });
  });

  describe('message de-duplication', () => {
    it('should report unprocessed for new message ids', () => {
      expect(isMessageProcessed('msg-1')).toBe(false);
    });

    it('should report unprocessed for empty messageId', () => {
      expect(isMessageProcessed('')).toBe(false);
    });

    it('should mark message as processed', () => {
      const id = 'msg-processed';
      expect(isMessageProcessed(id)).toBe(false);
      markMessageProcessed(id);
      expect(isMessageProcessed(id)).toBe(true);
    });

    it('should not mark empty messageId (no-op)', () => {
      markMessageProcessed('');
      expect(isMessageProcessed('')).toBe(false);
    });

    it('cleanupProcessedMessages does not throw', () => {
      cleanupProcessedMessages();
    });
  });
});

