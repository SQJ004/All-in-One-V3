export interface OAuthUser { id: string; username: string; avatar: string | null }
export interface OAuthGuild { id: string; name: string; icon: string | null; owner: boolean; permissions: string }

export interface OAuthClient {
  authorizeUrl(state: string): string;
  exchange(code: string): Promise<{ accessToken: string; expiresIn: number }>;
  fetchUser(accessToken: string): Promise<OAuthUser>;
  fetchGuilds(accessToken: string): Promise<OAuthGuild[]>;
}

const API = 'https://discord.com/api/v10';

export function discordOAuth(cfg: { clientId: string; clientSecret: string; redirectUri: string }): OAuthClient {
  const get = async <T>(path: string, token: string): Promise<T> => {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Discord API ${path} responded ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    authorizeUrl: (state) => `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: cfg.redirectUri, scope: 'identify guilds', state, prompt: 'none' })}`,
    async exchange(code) {
      const res = await fetch(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Token exchange failed with ${res.status}`);
      const data = (await res.json()) as { access_token: string; expires_in: number };
      return { accessToken: data.access_token, expiresIn: data.expires_in };
    },
    fetchUser: (token) => get<OAuthUser>('/users/@me', token),
    fetchGuilds: (token) => get<OAuthGuild[]>('/users/@me/guilds', token),
  };
}
