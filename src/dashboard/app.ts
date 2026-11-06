import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { logger } from '../core/logger.js';
import { UserError } from '../core/types.js';
import { WebSession, type IWebSession } from '../db/models.js';
import { apiRouter } from './api.js';
import { commandCatalog } from './commandCatalog.js';
import type { DashboardGateway } from './gateway.js';
import { botInviteUrl } from './invite.js';
import type { OAuthClient, OAuthGuild } from './oauth.js';

export interface DashboardOptions {
  /** Only the test preview sets this. It marks every page as sample data. */
  demo?: boolean;
  gateway: DashboardGateway;
  oauth: OAuthClient;
  sessionSecret: string;
  secureCookies: boolean;
  trustProxy: number;
  publicUrl: string;
  /** Discord invite for the support server, shown on the homepage. */
  supportUrl?: string;
  /** Tests relax the limiter; production never sets this. */
  rateLimitPerMinute?: number;
}

export interface AuthedRequest extends Request {
  session: IWebSession;
}

const COOKIE = 'vx_session';
const STATE_COOKIE = 'vx_state';
const SESSION_MS = 7 * 86_400_000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

function findPublicDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return join(dir, 'public');
    dir = dirname(dir);
  }
  throw new Error('Cannot locate the public directory');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** OAuth tokens are encrypted at rest with AES-256-GCM, so a database leak does not expose them. */
export function sealer(secret: string) {
  const key = createHash('sha256').update(`vortex-session:${secret}`).digest();
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed: string): string {
      const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
      const d = createDecipheriv('aes-256-gcm', key, iv!);
      d.setAuthTag(tag!);
      return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
    },
  };
}

export function createDashboardApp(opts: DashboardOptions) {
  const app = express();
  const seal = sealer(opts.sessionSecret);
  const guildCache = new Map<string, { at: number; guilds: OAuthGuild[] }>();
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${opts.secureCookies ? '; Secure' : ''}`;

  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'upgrade-insecure-requests': opts.secureCookies ? [] : null,
      },
    },
    strictTransportSecurity: opts.secureCookies,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '256kb' }));

  const limit = (max: number) => rateLimit({ windowMs: 60_000, limit: opts.rateLimitPerMinute ?? max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Slow down a little.' } });
  app.use('/auth', limit(30));
  app.use('/api', limit(300));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, ping: opts.gateway.ping(), uptimeMs: opts.gateway.uptimeMs() });
  });

  // ---------- Auth ----------
  app.get('/auth/login', (_req, res) => {
    const state = randomBytes(24).toString('hex');
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=${state}; Max-Age=600; ${cookieFlags}`);
    res.redirect(opts.oauth.authorizeUrl(state));
  });

  app.get('/auth/callback', async (req, res) => {
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    const { code, state } = req.query;
    if (typeof code !== 'string' || typeof state !== 'string' || !expected || !safeEqual(state, expected)) {
      res.status(400).send('Login failed: invalid or expired state. Please go back and try again.');
      return;
    }
    const token = await opts.oauth.exchange(code);
    const user = await opts.oauth.fetchUser(token.accessToken);
    const id = randomBytes(32).toString('base64url');
    await WebSession.create({
      _id: sha256(id), // only a hash is stored, so a database read cannot be replayed as a cookie
      userId: user.id, username: user.username, avatar: user.avatar,
      accessTokenEnc: seal.seal(token.accessToken), csrf: randomBytes(24).toString('hex'),
      expiresAt: new Date(Date.now() + Math.min(SESSION_MS, token.expiresIn * 1000)),
    });
    res.setHeader('Set-Cookie', [`${COOKIE}=${id}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags}`, `${STATE_COOKIE}=; Max-Age=0; ${cookieFlags}`]);
    res.redirect('/#/');
  });

  const requireSession: RequestHandler = async (req, res, next) => {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const session = id ? await WebSession.findById(sha256(id)) : null;
    if (!session || session.expiresAt.getTime() < Date.now()) {
      res.status(401).json({ error: 'Not signed in.' });
      return;
    }
    (req as AuthedRequest).session = session as IWebSession;
    next();
  };

  /** CSRF: state-changing requests need the per-session token and, when sent, a matching Origin. */
  const requireCsrf: RequestHandler = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const session = (req as AuthedRequest).session;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(opts.publicUrl).origin) {
      res.status(403).json({ error: 'Cross-origin request blocked.' });
      return;
    }
    if (!safeEqual(String(req.headers['x-csrf-token'] ?? ''), session.csrf)) {
      res.status(403).json({ error: 'Invalid CSRF token. Reload the page.' });
      return;
    }
    next();
  };

  app.post('/auth/logout', requireSession, requireCsrf, async (req, res) => {
    await WebSession.deleteOne({ _id: (req as AuthedRequest).session._id });
    guildCache.delete((req as AuthedRequest).session.userId);
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags}`);
    res.json({ ok: true });
  });

  const userGuilds = async (session: IWebSession): Promise<OAuthGuild[]> => {
    const hit = guildCache.get(session.userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.guilds;
    const guilds = await opts.oauth.fetchGuilds(seal.open(session.accessTokenEnc));
    guildCache.set(session.userId, { at: Date.now(), guilds });
    return guilds;
  };

  // The only API routes that work without signing in, for the public homepage. They hold nothing private.
  app.get('/api/public', (_req, res) => {
    const { gateway } = opts;
    const catalog = commandCatalog();
    res.json({
      inviteUrl: botInviteUrl(gateway.clientId),
      ...(opts.demo ? { demo: true } : {}),
      supportUrl: opts.supportUrl ?? null,
      stats: {
        servers: gateway.guildIds().length,
        users: gateway.guildIds().reduce((sum, id) => sum + (gateway.getGuild(id)?.memberCount ?? 0), 0),
        commands: new Set(catalog.map((c) => c.name.split(' ')[0])).size,
        subcommands: catalog.length,
        online: gateway.isOnline(),
      },
    });
  });
  // Lets public pages ask whether someone is signed in without logging a failed request.
  app.get('/api/public/session', async (req, res) => {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const session = id ? await WebSession.findById(sha256(id)) : null;
    res.json({ signedIn: Boolean(session && session.expiresAt.getTime() >= Date.now()) });
  });
  app.get('/api/public/commands', (_req, res) => {
    res.json({ commands: commandCatalog() });
  });

  app.use('/api', requireSession, requireCsrf, apiRouter(opts.gateway, userGuilds));
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found.' }); });

  // ---------- Frontend ----------
  const publicDir = findPublicDir();
  app.use(express.static(publicDir, { index: 'index.html', maxAge: opts.secureCookies ? '1h' : 0 }));
  app.use((req, res, next) => (req.method === 'GET' && req.accepts('html') ? res.sendFile(join(publicDir, 'index.html')) : next()));

  // ---------- Errors ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Some values are not valid.', issues: err.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) });
    } else if (err instanceof UserError) {
      res.status(400).json({ error: err.message });
    } else if ((err as { code?: string })?.code === 'DUPLICATE') {
      res.status(409).json({ error: 'An item with that name already exists.' });
    } else if ((err as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: 'That request is too large.' });
    } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON.' });
    } else {
      logger.error({ err }, 'Dashboard request failed');
      res.status(500).json({ error: 'Something went wrong on the server.' });
    }
  });

  return app;
}
