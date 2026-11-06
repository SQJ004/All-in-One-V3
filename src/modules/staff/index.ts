import { Events, type GuildMember, type PartialGuildMember } from 'discord.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { on, type VortexModule } from '../../core/types.js';
import { StaffRecord } from '../../db/models.js';

const staffRoleIds = (cfg: { adminRoles: string[]; moderatorRoles: string[]; helperRoles: string[]; supportRoles: string[] }) => new Set([...cfg.adminRoles, ...cfg.moderatorRoles, ...cfg.helperRoles, ...cfg.supportRoles]);

/** Adds a history record when someone gains or loses a staff role in Discord. */
export async function onStaffRoleChange(before: GuildMember | PartialGuildMember, after: GuildMember): Promise<void> {
  if (before.partial || after.user.bot) return;
  const { staff } = await getConfig(after.guild.id);
  const watched = staffRoleIds(staff);
  if (!watched.size) return;
  const changes = [
    ...[...watched].filter((id) => after.roles.cache.has(id) && !before.roles.cache.has(id)).map((id) => `Gained ${after.guild.roles.cache.get(id)?.name ?? id}`),
    ...[...watched].filter((id) => !after.roles.cache.has(id) && before.roles.cache.has(id)).map((id) => `Lost ${after.guild.roles.cache.get(id)?.name ?? id}`),
  ];
  if (!changes.length) return;
  await StaffRecord.create({ guildId: after.guild.id, userId: after.id, userName: after.user.tag, type: 'role_change', adminId: null, adminName: 'Discord', reason: changes.join(', '), date: new Date() })
    .catch((err) => logger.warn({ err }, 'Could not record a staff role change'));
}

export const staffModule: VortexModule = {
  name: 'staff',
  events: [on(Events.GuildMemberUpdate, onStaffRoleChange)],
};
