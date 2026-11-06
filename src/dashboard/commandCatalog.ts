import { ApplicationCommandOptionType as T, PermissionsBitField } from 'discord.js';
import { ALWAYS_ON } from '../core/commandRules.js';
import { MODULES } from '../core/registry.js';
import { prefixAliases, prefixUsage } from '../core/textCommands.js';

export type CommandCategory = 'Moderation' | 'Utility' | 'Fun' | 'Music' | 'Admin';
export interface CatalogEntry { name: string; description: string; usage: string; permissions: string[]; category: CommandCategory; requirement?: string; prefixUsage?: string }

/** Which homepage filter each slash command belongs to. Economy has no commands yet. */
export const CATEGORIES: Record<string, CommandCategory> = {
  play: 'Music', youtube: 'Music', leave: 'Music', pause: 'Music', resume: 'Music', skip: 'Music', stop: 'Music', queue: 'Music', nowplaying: 'Music', volume: 'Music', loop: 'Music', shuffle: 'Music', remove: 'Music', clearqueue: 'Music', previous: 'Music', seek: 'Music', lyrics: 'Music',
  moderation: 'Moderation', modconfig: 'Moderation', automod: 'Moderation',
  level: 'Fun', giveaway: 'Fun', poll: 'Fun', starboard: 'Fun', birthday: 'Fun',
  user: 'Utility', avatar: 'Utility', server: 'Utility', roles: 'Utility', moveme: 'Utility', roll: 'Fun', help: 'Utility', ping: 'Utility', afk: 'Utility', profile: 'Utility', invites: 'Utility', serverstats: 'Utility', selfrole: 'Utility', suggest: 'Utility',
  security: 'Admin', logs: 'Admin', welcome: 'Admin', embed: 'Admin', rolepanel: 'Admin', autorole: 'Admin', temprole: 'Admin', ticket: 'Admin', cc: 'Admin',
  autoresponse: 'Admin', schedule: 'Admin', rule: 'Admin', suggestions: 'Admin', challenge: 'Admin', setup: 'Admin',
};

/** Music commands anyone can use from anywhere, because they change nothing. */
const MUSIC_READ_ONLY = new Set(['queue', 'nowplaying', 'lyrics', 'youtube']);
const requirementFor = (name: string): string | undefined => {
  if (name === 'moveme') return 'Be in a voice channel';
  if (CATEGORIES[name] !== 'Music' || MUSIC_READ_ONLY.has(name)) return undefined;
  return name === 'play' ? 'Be in a voice channel' : "Be in the bot's voice channel";
};

const prefixUsageFor = (name: string): string | undefined => {
  const usage = prefixUsage(name);
  if (!usage) return undefined;
  const aliases = prefixAliases(name);
  return aliases.length ? `${usage} (or ${aliases.join(', ')})` : usage;
};

interface Option { type: number; name: string; description: string; required?: boolean; choices?: unknown[]; options?: Option[] }

const PLACEHOLDER: Partial<Record<number, string>> = {
  [T.Integer]: 'number', [T.Number]: 'number', [T.Boolean]: 'true/false', [T.User]: '@user', [T.Channel]: '#channel', [T.Role]: '@role', [T.Mentionable]: '@mention', [T.Attachment]: 'file',
};

function usage(path: string, options: Option[] = []): string {
  const parts = options.map((o) => {
    const text = `${o.name}:${o.choices?.length ? 'choice' : PLACEHOLDER[o.type] ?? 'text'}`;
    return o.required ? text : `[${text}]`;
  });
  return [`/${path}`, ...parts].join(' ');
}

const FLAG_LABELS: Record<string, string> = { ManageGuild: 'Manage Server' };
const permissionNames = (bits: bigint[] | string | null | undefined): string[] => {
  if (bits === null || bits === undefined) return [];
  return new PermissionsBitField(bits as bigint[]).toArray().map((flag) => FLAG_LABELS[flag] ?? flag.replace(/([a-z])([A-Z])/g, '$1 $2'));
};

/** Every command a member can really run, read from the same definitions registered with Discord. */
function build(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const command of MODULES.flatMap((m) => m.commands ?? [])) {
    const data = command.data as unknown as { name: string; description: string; options?: Option[]; default_member_permissions?: string | null };
    const defaults = data.default_member_permissions ? BigInt(data.default_member_permissions) : null;
    const add = (key: string, path: string, description: string, options?: Option[]) => {
      // The same lookup the command router uses before running a command.
      const need = command.perms?.[key] ?? command.perms?.['*'] ?? (defaults === null ? null : [defaults]);
      out.push({ name: `/${path}`, description, usage: usage(path, options), permissions: permissionNames(need), category: CATEGORIES[data.name] ?? 'Utility', requirement: requirementFor(data.name), prefixUsage: prefixUsageFor(data.name) });
    };
    const top = data.options ?? [];
    const nested = top.filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
    if (!nested.length) add('', data.name, data.description, top);
    for (const o of nested) {
      if (o.type === T.Subcommand) add(o.name, `${data.name} ${o.name}`, o.description, o.options);
      else for (const s of o.options ?? []) add(`${o.name}.${s.name}`, `${data.name} ${o.name} ${s.name}`, s.description, s.options);
    }
  }
  return out;
}

export interface CommandSummary { name: string; description: string; category: CommandCategory; subcommands: number; alwaysOn: boolean }

/** One entry per command a server can switch on or off, for the dashboard's Commands page. */
export const commandSummaries = (): CommandSummary[] => MODULES.flatMap((m) => m.commands ?? []).map(({ data }) => ({
  name: data.name, description: data.description, category: CATEGORIES[data.name] ?? 'Utility',
  subcommands: (data.options ?? []).flatMap((o) => (o.type === T.Subcommand ? [o] : o.type === T.SubcommandGroup ? ((o as { options?: unknown[] }).options ?? []) : [])).length,
  alwaysOn: ALWAYS_ON.has(data.name),
}));

let cached: CatalogEntry[] | undefined;
export const commandCatalog = (): CatalogEntry[] => (cached ??= build());
