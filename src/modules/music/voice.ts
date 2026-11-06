import { entersState, joinVoiceChannel, VoiceConnectionDisconnectReason, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { Guild } from 'discord.js';
import { logger } from '../../core/logger.js';
import { UserError } from '../../core/types.js';
import type { VoiceLink } from './player.js';

const READY_TIMEOUT_MS = 20_000;
const MAX_REJOINS = 5;

export interface SuperviseTimings { rejoinDelayMs?: number; waitMs?: number; readyMs?: number }

/** Recovers from dropped connections, and reports when the bot has really been removed. */
export function superviseConnection(connection: VoiceConnection, onLost: () => void, timings: SuperviseTimings = {}): void {
  const { rejoinDelayMs = 3000, waitMs = 5000, readyMs = READY_TIMEOUT_MS } = timings;
  const destroy = () => { if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); };

  connection.on('error', (err) => logger.warn({ err: err.message }, 'Voice connection error'));

  connection.on(VoiceConnectionStatus.Disconnected, async (_before, state) => {
    const kicked = state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === 4014;
    if (kicked) {
      // 4014 can mean moved to another channel, which reconnects by itself, or removed.
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, waitMs);
      } catch {
        destroy();
      }
    } else if (connection.rejoinAttempts < MAX_REJOINS) {
      await new Promise((done) => setTimeout(done, (connection.rejoinAttempts + 1) * rejoinDelayMs));
      if (connection.state.status === VoiceConnectionStatus.Disconnected) connection.rejoin();
    } else {
      destroy();
    }
  });

  // Connecting that never finishes would otherwise leave the bot silent in the channel.
  const expectReady = async () => {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, readyMs);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Ready && connection.state.status !== VoiceConnectionStatus.Disconnected) destroy();
    }
  };
  connection.on(VoiceConnectionStatus.Connecting, expectReady);
  connection.on(VoiceConnectionStatus.Destroyed, onLost);
}

export async function joinVoice(guild: Guild, channelId: string, onLost: () => void): Promise<VoiceLink> {
  const connection = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ guildId: guild.id, err: (err as Error).message }, 'Could not connect to voice');
    connection.destroy();
    throw new UserError('I could not connect to your voice channel. Please try again, and check that I can see it.');
  }
  superviseConnection(connection, onLost);
  const link: VoiceLink = {
    channelId,
    subscribe: (audio) => { connection.subscribe(audio); },
    move(next) {
      connection.rejoin({ channelId: next, selfDeaf: true, selfMute: false });
      link.channelId = next;
    },
    destroy() {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    },
  };
  return link;
}
