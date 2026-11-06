import type { Guild, GuildMember, PartialGuildMember, User } from 'discord.js';

export type Vars = Record<string, string | number>;

/** Replaces {key} for known keys only. Unknown braces are left alone, values are not re-expanded. */
export function renderVars(text: string, vars: Vars): string {
  return text.replace(/\{([a-z_]+)\}/gi, (whole, key: string) => {
    const value = vars[key.toLowerCase()];
    return value === undefined ? whole : String(value);
  });
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export function userVars(user: User, guild: Guild): Vars {
  return {
    user: `<@${user.id}>`,
    username: user.displayName ?? user.username,
    tag: user.tag,
    userid: user.id,
    avatar: user.displayAvatarURL({ extension: 'png', size: 512 }),
    createdat: dateFmt.format(user.createdAt),
    server: guild.name,
    membercount: guild.memberCount,
  };
}

/** Accurate join position for existing members when cached; a newcomer is simply the newest member. */
export function memberVars(member: GuildMember | PartialGuildMember, opts: { newcomer?: boolean } = {}): Vars {
  const guild = member.guild;
  let joinposition: number = guild.memberCount;
  if (!opts.newcomer && member.joinedTimestamp) {
    joinposition = guild.members.cache.filter((m) => (m.joinedTimestamp ?? 0) <= member.joinedTimestamp!).size;
  }
  return { ...userVars(member.user as User, guild), joinposition };
}

export const VARIABLE_HELP = '`{user}` `{username}` `{tag}` `{server}` `{membercount}` `{avatar}` `{userid}` `{createdat}` `{joinposition}`';
