import { ChannelType, PermissionFlagsBits, Status, type Client, type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { postableChannel } from '../core/channels.js';
import { isTrusted, hasDangerousPermissions, roleAssignBlock } from '../core/permissions.js';
import { getConfig } from '../core/configService.js';
import { UserError } from '../core/types.js';
import { PostedEmbed, RolePanel, TicketPanel } from '../db/models.js';
import { MessageSpecSchema, renderMessage, type MessageSpec } from '../modules/embeds/spec.js';
import { publishRolePanel } from '../modules/roles/index.js';
import { engageLockdown, isLockedDown, liftLockdown } from '../modules/security/lockdown.js';
import { dashboardTicketAction, publishTicketPanel } from '../modules/tickets/index.js';
import { reviewFlag, type ReviewDecision } from '../modules/aimod/index.js';
import { backupSummary, createBackup, startRestore, type RestoreOptions } from '../modules/backup/index.js';
import { isBotOwner, readIdentity, saveIdentity, updateBotAccount, type Identity } from '../modules/platform/index.js';
import { ServerBackup } from '../db/models.js';
import type { StaffMemberInfo } from '../modules/staff/analytics.js';

export interface GuildInfo { id: string; name: string; icon: string | null; memberCount: number; ownerId: string; channels: number; roles: number; boosts: number; online: boolean }
export interface ChannelInfo { id: string; name: string; type: 'text' | 'voice' | 'category' | 'announcement' | 'other'; parentId: string | null }
export interface RoleInfo { id: string; name: string; color: string; position: number; managed: boolean; dangerous: boolean }
export interface Access { canManage: boolean; isOwner: boolean; isTrusted: boolean }
export interface WebhookInfo { id: string; name: string; channelId: string | null; createdBy: string | null; createdAt: Date; application: boolean }
export interface IdentityView extends Identity { username: string; avatarUrl: string | null; bannerUrl: string | null; canEdit: boolean }
export interface IdentityChange extends Identity { username?: string; avatar?: string | null; banner?: string | null }

/**
 * Everything the dashboard needs from Discord. Permissions come from the live gateway,
 * never from the OAuth token, so they are correct the moment a role changes.
 */
export interface DashboardGateway {
  clientId: string;
  ping(): number;
  uptimeMs(): number;
  isOnline(): boolean;
  /** avatarUrl, bannerUrl and nickname are this server's custom ones. The defaults are the bot's normal look. */
  getBotProfile(guildId: string): Promise<{ username: string; nickname: string | null; avatarUrl: string | null; bannerUrl: string | null; defaultAvatarUrl: string | null; defaultBannerUrl: string | null }>;
  setBotImages(guildId: string, images: { avatar?: string | null; banner?: string | null }): Promise<void>;
  /** Throws unless this person, and the bot, can post in the channel. */
  assertCanPost(guildId: string, channelId: string, userId: string): Promise<void>;
  setNickname(guildId: string, nickname: string | null, byUsername: string): Promise<void>;
  guildIds(): string[];
  getGuild(guildId: string): GuildInfo | null;
  getChannels(guildId: string): ChannelInfo[];
  getRoles(guildId: string): RoleInfo[];
  getAccess(guildId: string, userId: string): Promise<Access | null>;
  postMessage(guildId: string, channelId: string, spec: MessageSpec, userId: string): Promise<{ url: string }>;
  publishRolePanel(guildId: string, panelId: string, channelId: string, userId: string): Promise<{ url: string }>;
  publishTicketPanel(guildId: string, panelId: string, channelId: string, userId: string): Promise<{ url: string }>;
  deleteMessage(guildId: string, channelId: string, messageId: string): Promise<void>;
  isLocked(guildId: string): Promise<boolean>;
  setLockdown(guildId: string, on: boolean, userId: string, reason: string): Promise<{ changed: number; failed: number }>;
  /** Never includes webhook tokens or URLs. */
  listWebhooks(guildId: string): Promise<WebhookInfo[]>;
  deleteWebhook(guildId: string, webhookId: string, byUsername: string): Promise<void>;
  getIdentity(userId: string): Promise<IdentityView>;
  updateIdentity(userId: string, change: IdentityChange): Promise<void>;
  createBackup(guildId: string, byUsername: string): Promise<ReturnType<typeof backupSummary>>;
  restoreBackup(guildId: string, backupId: string, byUsername: string, options: RestoreOptions): Promise<void>;
  memberName(guildId: string, userId: string): string;
  reviewAiFlag(guildId: string, flagId: string, decision: ReviewDecision, userId: string): Promise<void>;
  /** Members holding any of these roles. Bots are left out. */
  staffRoster(guildId: string, roleIds: string[]): Promise<StaffMemberInfo[]>;
  memberCard(guildId: string, userId: string): StaffMemberInfo | null;
  ticketAction(guildId: string, ticketId: string, action: 'close' | 'reopen' | 'assign' | 'add' | 'remove', userId: string, targetId?: string): Promise<void>;
}

const typeOf = (t: ChannelType): ChannelInfo['type'] =>
  t === ChannelType.GuildText ? 'text' : t === ChannelType.GuildVoice || t === ChannelType.GuildStageVoice ? 'voice' : t === ChannelType.GuildCategory ? 'category' : t === ChannelType.GuildAnnouncement ? 'announcement' : 'other';

/** A website user can only post where they could post in Discord. */
async function postingContext(g: Guild, channelId: string, userId: string) {
  const member = await g.members.fetch(userId);
  return { member, channel: postableChannel(g, channelId, member) };
}

const ROSTER_REFRESH_MS = 5 * 60_000;
const rosterFetched = new Map<string, number>();

export function createClientGateway(client: Client): DashboardGateway {
  const toCard = (m: GuildMember): StaffMemberInfo => ({ id: m.id, name: m.user.tag, avatar: m.displayAvatarURL({ size: 64 }), joinedAt: m.joinedAt, roleIds: [...m.roles.cache.keys()], roleName: m.roles.highest.id === m.guild.id ? null : m.roles.highest.name });
  const guildOf = (id: string) => {
    const g = client.guilds.cache.get(id);
    if (!g) throw new UserError('ZYTHERON is not in that server.');
    return g;
  };
  return {
    get clientId() { return client.application?.id ?? client.user?.id ?? ''; },
    ping: () => Math.round(client.ws.ping),
    uptimeMs: () => client.uptime ?? 0,
    isOnline: () => client.isReady() && client.ws.status === Status.Ready,
    guildIds: () => [...client.guilds.cache.keys()],
    async getBotProfile(id) {
      const me = guildOf(id).members.me;
      // Discord only sends the banner when the user is fetched directly.
      const user = await client.user?.fetch().catch(() => client.user);
      return {
        username: user?.username ?? 'ZYTHERON',
        nickname: me?.nickname ?? null,
        avatarUrl: me?.avatarURL({ size: 256 }) ?? null,
        bannerUrl: me?.bannerURL({ size: 512 }) ?? null,
        defaultAvatarUrl: user?.displayAvatarURL({ size: 256 }) ?? null,
        defaultBannerUrl: user?.bannerURL({ size: 512 }) ?? null,
      };
    },
    async setBotImages(id, images) {
      guildOf(id);
      try {
        await client.rest.patch(`/guilds/${id}/members/@me`, { body: images });
        await guildOf(id).members.fetchMe({ force: true }).catch(() => undefined);
      } catch (err) {
        const message = (err as Error).message ?? '';
        throw new UserError(/rate|too fast/i.test(message) ? 'Discord limits how often this can change. Please try again later.' : 'Discord would not accept that image. Try a smaller PNG, JPG or GIF.');
      }
    },
    async assertCanPost(guildId, channelId, userId) {
      await postingContext(guildOf(guildId), channelId, userId);
    },
    async setNickname(id, nickname, byUsername) {
      const me = guildOf(id).members.me;
      if (!me) throw new UserError('ZYTHERON is not ready in that server yet. Please try again.');
      try {
        await me.setNickname(nickname, `Changed on the dashboard by ${byUsername}`);
      } catch {
        throw new UserError('Discord would not let me change my nickname. Check that I have the Change Nickname permission.');
      }
    },
    getGuild(id) {
      const g = client.guilds.cache.get(id);
      return g ? { id: g.id, name: g.name, icon: g.iconURL({ size: 128 }), memberCount: g.memberCount, ownerId: g.ownerId, channels: g.channels.cache.size, roles: g.roles.cache.size - 1, boosts: g.premiumSubscriptionCount ?? 0, online: g.available } : null;
    },
    getChannels(id) {
      return [...guildOf(id).channels.cache.values()].filter((c) => !c.isThread()).map((c) => ({ id: c.id, name: c.name, type: typeOf(c.type), parentId: c.parentId })).sort((a, b) => a.name.localeCompare(b.name));
    },
    getRoles(id) {
      const g = guildOf(id);
      return [...g.roles.cache.values()].filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed, dangerous: hasDangerousPermissions(r.permissions.bitfield) }));
    },
    async getAccess(guildId, userId) {
      const g = client.guilds.cache.get(guildId);
      if (!g) return null;
      const member = await g.members.fetch(userId).catch(() => null);
      if (!member) return null;
      const { security } = await getConfig(guildId);
      return { canManage: member.permissions.has(PermissionFlagsBits.ManageGuild), isOwner: g.ownerId === userId, isTrusted: isTrusted(g, userId, security.trustedAdmins) };
    },
    async postMessage(guildId, channelId, spec, userId) {
      const g = guildOf(guildId);
      const validated = MessageSpecSchema.parse(spec);
      const { member, channel } = await postingContext(g, channelId, userId);
      const roleIds = [...validated.buttons.flatMap((b) => (b.kind === 'role' ? [b.roleId] : [])), ...(validated.roleMenu?.options.map((o) => o.roleId) ?? [])];
      for (const id of roleIds) {
        const role = g.roles.cache.get(id);
        if (!role) throw new UserError('A role in this message no longer exists.');
        const block = roleAssignBlock(role, g.members.me!, member);
        if (block) throw new UserError(block);
      }
      const message = await channel.send({ ...renderMessage(validated, { server: g.name, membercount: g.memberCount }), allowedMentions: { parse: [] } });
      await PostedEmbed.create({ guildId, channelId, messageId: message.id, spec: validated, createdBy: userId });
      return { url: message.url };
    },
    async publishRolePanel(guildId, panelId, channelId, userId) {
      const g = guildOf(guildId);
      const { member } = await postingContext(g, channelId, userId);
      const panel = await RolePanel.findOne({ _id: panelId, guildId });
      if (!panel) throw new UserError('That panel no longer exists.');
      return { url: (await publishRolePanel(g, panel, channelId, member)).url };
    },
    async publishTicketPanel(guildId, panelId, channelId, userId) {
      const g = guildOf(guildId);
      await postingContext(g, channelId, userId);
      const panel = await TicketPanel.findOne({ _id: panelId, guildId });
      if (!panel) throw new UserError('That panel no longer exists.');
      return { url: (await publishTicketPanel(g, panel, channelId)).url };
    },
    async deleteMessage(guildId, channelId, messageId) {
      const channel = guildOf(guildId).channels.cache.get(channelId) as GuildTextBasedChannel | undefined;
      if (channel && 'messages' in channel) await channel.messages.delete(messageId).catch(() => undefined); // it may already be gone
    },
    isLocked: (guildId) => isLockedDown(guildId),
    async setLockdown(guildId, on, userId, reason) {
      const g = guildOf(guildId);
      if (on) {
        const r = await engageLockdown(g, userId, reason);
        return { changed: r.locked, failed: r.failed };
      }
      const r = await liftLockdown(g, userId);
      return { changed: r.restored, failed: r.failed };
    },
    async listWebhooks(guildId) {
      const hooks = await guildOf(guildId).fetchWebhooks().catch(() => { throw new UserError('ZYTHERON needs the Manage Webhooks permission to list webhooks.'); });
      return [...hooks.values()].map((w) => ({ id: w.id, name: w.name, channelId: w.channelId, createdBy: w.owner?.username ?? null, createdAt: w.createdAt, application: Boolean(w.applicationId) }));
    },
    async deleteWebhook(guildId, webhookId, byUsername) {
      const hook = (await guildOf(guildId).fetchWebhooks().catch(() => { throw new UserError('ZYTHERON needs the Manage Webhooks permission to remove webhooks.'); })).get(webhookId);
      if (!hook) throw new UserError('That webhook no longer exists.');
      await hook.delete(`Removed on the dashboard by ${byUsername}`);
    },
    async getIdentity(userId) {
      const user = await client.user!.fetch().catch(() => client.user!);
      return { ...(await readIdentity()), username: user.username, avatarUrl: user.displayAvatarURL({ size: 256 }), bannerUrl: user.bannerURL({ size: 512 }) ?? null, canEdit: await isBotOwner(client, userId) };
    },
    async updateIdentity(userId, change) {
      if (!(await isBotOwner(client, userId))) throw new UserError("Only the bot's owner in the Discord Developer Portal can change this, because it affects every server.");
      const { username, avatar, banner, ...identity } = change;
      await updateBotAccount(client, { ...(username ? { username } : {}), ...(avatar !== undefined ? { avatar } : {}), ...(banner !== undefined ? { banner } : {}) });
      await saveIdentity(client, identity);
    },
    async createBackup(guildId, byUsername) {
      return backupSummary(await createBackup(guildOf(guildId), byUsername));
    },
    async restoreBackup(guildId, backupId, byUsername, options) {
      const doc = await ServerBackup.findOne({ guildId, backupId });
      if (!doc) throw new UserError('That backup no longer exists.');
      await startRestore(guildOf(guildId), doc, options, byUsername);
    },
    memberName(guildId, userId) {
      return client.guilds.cache.get(guildId)?.members.cache.get(userId)?.user.tag ?? client.users.cache.get(userId)?.tag ?? userId;
    },
    async reviewAiFlag(guildId, flagId, decision, userId) {
      const g = guildOf(guildId);
      await reviewFlag(g, flagId, decision, await g.members.fetch(userId));
    },
    async staffRoster(guildId, roleIds) {
      const g = guildOf(guildId);
      if (!roleIds.length) return [];
      // Asking Discord for every member is slow on big servers, so it happens at most every few minutes.
      if (Date.now() - (rosterFetched.get(guildId) ?? 0) > ROSTER_REFRESH_MS) {
        await g.members.fetch().catch(() => undefined);
        rosterFetched.set(guildId, Date.now());
      }
      return [...g.members.cache.values()].filter((m) => !m.user.bot && roleIds.some((r) => m.roles.cache.has(r))).map(toCard);
    },
    memberCard(guildId, userId) {
      const m = client.guilds.cache.get(guildId)?.members.cache.get(userId);
      return m ? toCard(m) : null;
    },
    ticketAction: (guildId, ticketId, action, userId, targetId) => dashboardTicketAction(guildOf(guildId), ticketId, action, userId, targetId),
  };
}
