import { PermissionFlagsBits, PermissionsBitField, type Guild, type GuildMember, type Role } from 'discord.js';

/** Bits that must never be handed out by self-service role panels or automation. */
export const DANGEROUS_PERMISSIONS: bigint[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageNicknames,
];

export const hasDangerousPermissions = (bits: bigint): boolean => DANGEROUS_PERMISSIONS.some((p) => (bits & p) === p);

/** Returns why `actor` may not moderate `target`, or null when allowed. */
export function moderationBlock(actor: GuildMember, target: GuildMember, me: GuildMember): string | null {
  if (target.id === actor.id) return 'You cannot moderate yourself.';
  if (target.id === me.id) return 'I cannot moderate myself.';
  if (target.id === target.guild.ownerId) return 'The server owner cannot be moderated.';
  if (actor.id !== actor.guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) return 'That member has an equal or higher role than you.';
  if (target.roles.highest.position >= me.roles.highest.position) return 'That member has an equal or higher role than me. Move my role above theirs.';
  return null;
}

/** Validates that a role can be safely granted by the bot; pass actor when a person configures it. */
export function roleAssignBlock(role: Role, me: GuildMember, actor?: GuildMember, opts: { allowDangerous?: boolean } = {}): string | null {
  if (role.managed) return `${role.name} is managed by an integration and cannot be assigned.`;
  if (role.id === role.guild.id) return '@everyone cannot be assigned.';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I need the Manage Roles permission.';
  if (role.position >= me.roles.highest.position) return `${role.name} is above my highest role. Move my role above it.`;
  if (actor && actor.id !== actor.guild.ownerId && role.position >= actor.roles.highest.position) return `${role.name} is equal to or above your highest role.`;
  if (!opts.allowDangerous && hasDangerousPermissions(role.permissions.bitfield)) return `${role.name} has moderator or admin permissions, so it cannot be self-assigned or automated.`;
  return null;
}

export const missingPerms = (member: GuildMember, perms: bigint[]): string[] =>
  perms.filter((p) => !member.permissions.has(p)).flatMap((p) => new PermissionsBitField(p).toArray());

/** Owner or configured trusted admin. Used for security settings, so an ordinary admin cannot disarm protection. */
export const isTrusted = (guild: Guild, userId: string, trustedAdmins: string[]): boolean => guild.ownerId === userId || trustedAdmins.includes(userId);
