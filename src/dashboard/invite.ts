const CREATE_INVITE = 1n << 0n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;
const MOVE_MEMBERS = 1n << 24n;

/** What /setup checks for, plus what posting, reacting and music need. Deliberately not Administrator. */
const PERMISSIONS = String(1375342030070n | CREATE_INVITE | CONNECT | SPEAK | MOVE_MEMBERS);

export function botInviteUrl(clientId: string, guildId?: string): string {
  const params = new URLSearchParams({ client_id: clientId, scope: 'bot applications.commands', permissions: PERMISSIONS });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params}`;
}
