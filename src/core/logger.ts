import { pino } from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'silent' : 'info');
const pretty = process.env.NODE_ENV !== 'production' && !process.env.VITEST;

export const logger = pino({
  level,
  base: { app: 'vortex' },
  redact: { paths: ['token', 'accessToken', 'authorization', '*.token', '*.accessToken'], remove: true },
  ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' } } } : {}),
});
