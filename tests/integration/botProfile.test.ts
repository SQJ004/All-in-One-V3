import { Client, ClientUser, GuildMember } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientGateway } from '../../src/dashboard/gateway.js';

/** Uses discord.js's real image code, because it refuses sizes that Discord does not offer. */
const GUILD = '100000000000000001';
const BOT = '500000000000000001';

function world({ custom = false, banner = 'bannerhash' as string | null } = {}) {
  const client = new Client({ intents: [] });
  const user = new (ClientUser as any)(client, { id: BOT, username: 'ZYTHERON', avatar: 'avatarhash', banner, discriminator: '9585' });
  client.user = user;
  const guild: any = { id: GUILD, client, members: {} };
  guild.members.me = new (GuildMember as any)(client, { user: { id: BOT }, nick: custom ? 'Custom' : null, avatar: custom ? 'serveravatar' : null, banner: custom ? 'serverbanner' : null, roles: [] }, guild);
  client.guilds.cache.set(GUILD, guild);
  const fetch = vi.spyOn(user, 'fetch').mockResolvedValue(user);
  return { client, user, fetch, gateway: createClientGateway(client) };
}

describe('the bot profile on the Personalize page', () => {
  let client: Client | undefined;
  afterEach(async () => { await client?.destroy(); });

  it("gives the bot's real name, avatar and banner as the defaults", async () => {
    const w = world();
    client = w.client;
    const profile = await w.gateway.getBotProfile(GUILD);
    expect(profile).toMatchObject({ username: 'ZYTHERON', nickname: null, avatarUrl: null, bannerUrl: null });
    expect(profile.defaultAvatarUrl).toContain(`/avatars/${BOT}/avatarhash`);
    expect(profile.defaultBannerUrl).toContain(`/banners/${BOT}/bannerhash`);
  });

  it("also gives this server's custom look", async () => {
    const w = world({ custom: true });
    client = w.client;
    const profile = await w.gateway.getBotProfile(GUILD);
    expect(profile.nickname).toBe('Custom');
    expect(profile.avatarUrl).toContain('serveravatar');
    expect(profile.bannerUrl).toContain('serverbanner');
  });

  it('copes with a bot that has no banner', async () => {
    const w = world({ banner: null });
    client = w.client;
    expect((await w.gateway.getBotProfile(GUILD)).defaultBannerUrl).toBeNull();
  });

  it('still works when Discord cannot be reached', async () => {
    const w = world();
    client = w.client;
    w.fetch.mockRejectedValue(new Error('Network down'));
    expect((await w.gateway.getBotProfile(GUILD)).defaultAvatarUrl).toContain('avatarhash');
  });
});
