import { AuditLogEvent } from 'discord.js';
import type { GuildConfig } from '../../config/guildConfig.js';
import { SlidingWindow } from '../../core/rateLimit.js';
import { scanContent, type LinkVerdict } from './linkScanner.js';

export type SecurityConfig = GuildConfig['security'];
export type NukeAction = keyof SecurityConfig['antiNuke']['limits'];

/** Audit log events counted toward anti-nuke limits. */
export const AUDIT_TO_ACTION: Partial<Record<AuditLogEvent, NukeAction>> = {
  [AuditLogEvent.ChannelDelete]: 'channelDelete',
  [AuditLogEvent.ChannelCreate]: 'channelCreate',
  [AuditLogEvent.RoleDelete]: 'roleDelete',
  [AuditLogEvent.RoleCreate]: 'roleCreate',
  [AuditLogEvent.MemberBanAdd]: 'ban',
  [AuditLogEvent.MemberKick]: 'kick',
  [AuditLogEvent.WebhookCreate]: 'webhookCreate',
  [AuditLogEvent.EmojiDelete]: 'emojiDelete',
  [AuditLogEvent.GuildUpdate]: 'serverUpdate',
  [AuditLogEvent.ChannelOverwriteCreate]: 'permissionChange',
  [AuditLogEvent.ChannelOverwriteUpdate]: 'permissionChange',
  [AuditLogEvent.ChannelOverwriteDelete]: 'permissionChange',
};

export interface ExemptionContext { actorId: string; ownerId: string; botId: string; roleIds: string[] }

/** Who anti-nuke never acts on. This is the main false-positive guard, together with monitor mode. */
export function isSecurityExempt(cfg: SecurityConfig, ctx: ExemptionContext): boolean {
  if (ctx.actorId === ctx.botId || ctx.actorId === ctx.ownerId) return true;
  if (cfg.trustedAdmins.includes(ctx.actorId) || cfg.whitelistUsers.includes(ctx.actorId)) return true;
  return ctx.roleIds.some((r) => cfg.whitelistRoles.includes(r));
}

export class NukeTracker {
  private readonly window = new SlidingWindow();
  private readonly tripped = new Map<string, number>();

  /** Counts an action. `trip` is true once when the limit is reached, so one attacker gets one punishment. */
  record(guildId: string, actorId: string, action: NukeAction, limit: { count: number; windowSec: number }, now = Date.now()): { count: number; trip: boolean; alreadyTripped: boolean } {
    const count = this.window.hit(`${guildId}:${actorId}:${action}`, limit.windowSec * 1000, now);
    const key = `${guildId}:${actorId}`;
    const alreadyTripped = (this.tripped.get(key) ?? 0) > now;
    if (count >= limit.count && !alreadyTripped) {
      this.tripped.set(key, now + 5 * 60_000);
      return { count, trip: true, alreadyTripped: false };
    }
    return { count, trip: false, alreadyTripped };
  }

  clear(guildId: string, actorId: string): void {
    this.tripped.delete(`${guildId}:${actorId}`);
  }
}

// ---------- Join protection ----------
export interface AccountSignals { ageDays: number; hasAvatar: boolean; username: string; bot: boolean }

const SUSPICIOUS_NAME = [/free\s*nitro/i, /(discord|server)\s*(mod|admin|staff|support)/i, /(nitro|steam)\s*gift/i, /\bairdrop\b/i, /\.(gg|com|ru)\b/i, /https?:/i];

/** 0-100 risk score from public account signals. Age dominates; the others only tip the balance. */
export function scoreAccount(s: AccountSignals, minAgeDays: number): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (s.ageDays < minAgeDays) {
    score += 50;
    reasons.push(`Account is only ${s.ageDays.toFixed(1)} days old`);
    if (s.ageDays < 1) { score += 15; reasons.push('Created within the last 24 hours'); }
  }
  if (!s.hasAvatar) { score += 15; reasons.push('No profile picture'); }
  if (SUSPICIOUS_NAME.some((re) => re.test(s.username))) { score += 40; reasons.push('Username matches scam patterns'); }
  return { score: Math.min(100, score), reasons };
}

export class RaidDetector {
  private readonly joins = new SlidingWindow();
  private readonly raidUntil = new Map<string, number>();
  private readonly recent = new Map<string, Array<{ id: string; at: number }>>();

  /** Registers a join. `started` is true when this join opened raid mode; `recent` lists the joiners who triggered it. */
  join(guildId: string, memberId: string, cfg: SecurityConfig['antiRaid'], now = Date.now()): { raid: boolean; started: boolean; recent: string[] } {
    const windowMs = cfg.windowSec * 1000;
    const list = (this.recent.get(guildId) ?? []).filter((j) => j.at > now - windowMs);
    list.push({ id: memberId, at: now });
    this.recent.set(guildId, list);
    const count = this.joins.hit(guildId, windowMs, now);
    const active = (this.raidUntil.get(guildId) ?? 0) > now;
    if (active) {
      this.raidUntil.set(guildId, now + cfg.raidModeMinutes * 60_000); // sustained joins extend it
      return { raid: true, started: false, recent: [] };
    }
    if (count >= cfg.joinThreshold) {
      this.raidUntil.set(guildId, now + cfg.raidModeMinutes * 60_000);
      return { raid: true, started: true, recent: list.map((j) => j.id) };
    }
    return { raid: false, started: false, recent: [] };
  }

  isActive(guildId: string, now = Date.now()): boolean {
    return (this.raidUntil.get(guildId) ?? 0) > now;
  }

  end(guildId: string): void {
    this.raidUntil.delete(guildId);
    this.joins.reset(guildId);
  }
}

// ---------- Message protection ----------
export interface MessageFacts {
  guildId: string;
  authorId: string;
  channelId: string;
  messageId: string;
  content: string;
  userMentions: number;
  roleMentions: number;
  everyoneAttempt: boolean;
  canMentionEveryone: boolean;
}

export type ViolationType = 'spam' | 'duplicate' | 'mass_mention' | 'everyone' | 'link' | 'banned_word' | 'caps';
export interface Violation { type: ViolationType; detail: string; link?: LinkVerdict; deleteIds?: string[] }

interface RecentMessage { id: string; hash: string; at: number }

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function wordMatch(content: string, words: string[]): string | null {
  const lower = content.toLowerCase();
  for (const raw of words) {
    const word = raw.toLowerCase();
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(lower)) return raw;
  }
  return null;
}

export function capsPercent(content: string): number {
  const letters = content.replace(/[^\p{L}]/gu, '');
  if (letters.length < 12) return 0; // short shouts like "LOL" are not worth a strike
  return Math.round(((letters.length - letters.replace(/\p{Lu}/gu, '').length) / letters.length) * 100);
}

export class MessageGuard {
  private readonly history = new Map<string, RecentMessage[]>();

  evaluate(cfg: SecurityConfig, m: MessageFacts, now = Date.now()): Violation[] {
    const out: Violation[] = [];
    const key = `${m.guildId}:${m.authorId}`;
    const maxWindow = Math.max(cfg.antiSpam.windowSec, cfg.antiSpam.duplicateWindowSec) * 1000;
    const hash = normalize(m.content);
    const list = (this.history.get(key) ?? []).filter((r) => r.at > now - maxWindow);
    list.push({ id: m.messageId, hash, at: now });
    this.history.set(key, list);
    if (this.history.size > 50_000) this.history.delete(this.history.keys().next().value!);

    if (cfg.antiSpam.enabled) {
      const inWindow = list.filter((r) => r.at > now - cfg.antiSpam.windowSec * 1000);
      if (inWindow.length >= cfg.antiSpam.maxMessages) out.push({ type: 'spam', detail: `${inWindow.length} messages in ${cfg.antiSpam.windowSec}s`, deleteIds: inWindow.map((r) => r.id) });
      if (hash.length > 0) {
        const dupes = list.filter((r) => r.hash === hash && r.at > now - cfg.antiSpam.duplicateWindowSec * 1000);
        if (dupes.length >= cfg.antiSpam.maxDuplicates) out.push({ type: 'duplicate', detail: `Same message ${dupes.length} times`, deleteIds: dupes.map((r) => r.id) });
      }
    }
    if (cfg.antiMention.enabled) {
      const total = m.userMentions + m.roleMentions;
      if (total >= cfg.antiMention.maxMentions) out.push({ type: 'mass_mention', detail: `${total} mentions in one message` });
      if (cfg.antiMention.blockEveryone && m.everyoneAttempt && !m.canMentionEveryone) out.push({ type: 'everyone', detail: 'Tried to mention everyone without permission' });
    }
    for (const link of scanContent(m.content, cfg.antiLinks)) out.push({ type: 'link', detail: `${link.reason}${link.host ? ` (${link.host})` : ''}`, link });
    const word = wordMatch(m.content, cfg.automod.bannedWords);
    if (word) out.push({ type: 'banned_word', detail: 'Contains a banned word' });
    if (cfg.automod.maxCapsPercent > 0) {
      const caps = capsPercent(m.content);
      if (caps >= cfg.automod.maxCapsPercent) out.push({ type: 'caps', detail: `${caps}% capital letters` });
    }
    return out;
  }

  forget(guildId: string, authorId: string): void {
    this.history.delete(`${guildId}:${authorId}`);
  }
}

// ---------- Strike ladder ----------
export class StrikeLedger {
  private readonly strikes = new Map<string, number[]>();

  add(guildId: string, userId: string, decayMinutes: number, amount = 1, now = Date.now()): number {
    const key = `${guildId}:${userId}`;
    const live = (this.strikes.get(key) ?? []).filter((t) => t > now - decayMinutes * 60_000);
    for (let i = 0; i < amount; i++) live.push(now);
    this.strikes.set(key, live);
    return live.length;
  }
}

export type LadderRung = SecurityConfig['ladder'][number];

export function ladderAction(ladder: LadderRung[], strikes: number): LadderRung | null {
  return [...ladder].sort((a, b) => b.strikes - a.strikes).find((r) => strikes >= r.strikes) ?? null;
}

/** Phishing is dangerous enough to count as several strikes at once. */
export const violationWeight = (v: Violation): number => (v.type === 'link' && v.link?.category !== 'invite' ? 3 : 1);
