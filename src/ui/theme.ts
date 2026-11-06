import { EmbedBuilder, MessageFlags, type InteractionReplyOptions, type RepliableInteraction } from 'discord.js';

/** The ZYTHERON visual identity: black, purple and white. */
export const BRAND = { name: 'ZYTHERON', tagline: 'Protect. Manage. Dominate.' } as const;

export const COLORS = {
  primary: 0x7c3aed,
  accent: 0x8b5cf6,
  success: 0x10b981,
  warning: 0xf59e0b,
  danger: 0xef4444,
  muted: 0x111111,
} as const;

export const ICONS = {
  brand: '◈',
  ok: '✓',
  fail: '✕',
  warn: '▲',
  info: '◆',
  shield: '⛨',
  lock: '⊘',
  clock: '◷',
  user: '◉',
  arrow: '›',
  dot: '•',
} as const;

let embedColor: number = COLORS.primary;
/** The bot's main embed colour, chosen on the Bot Identity page. */
export const setEmbedColor = (color: number): void => { embedColor = color; };

export function baseEmbed(color: number = embedColor): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setFooter({ text: `${BRAND.name} ${ICONS.dot} ${BRAND.tagline}` }).setTimestamp();
}

export const panelEmbed = (title: string, description?: string, color: number = embedColor): EmbedBuilder => {
  const embed = baseEmbed(color).setTitle(`${ICONS.brand}  ${title}`);
  return description ? embed.setDescription(description) : embed;
};

export const okEmbed = (message: string): EmbedBuilder => baseEmbed(COLORS.success).setDescription(`**${ICONS.ok}**  ${message}`);
export const failEmbed = (message: string): EmbedBuilder => baseEmbed(COLORS.danger).setDescription(`**${ICONS.fail}**  ${message}`);
export const warnEmbed = (message: string): EmbedBuilder => baseEmbed(COLORS.warning).setDescription(`**${ICONS.warn}**  ${message}`);
export const infoEmbed = (message: string): EmbedBuilder => baseEmbed(COLORS.accent).setDescription(`**${ICONS.info}**  ${message}`);

async function send(i: RepliableInteraction, options: InteractionReplyOptions): Promise<void> {
  if (i.deferred || i.replied) {
    const { flags: _flags, ...rest } = options;
    await i.followUp({ ...rest, flags: MessageFlags.Ephemeral });
  } else {
    await i.reply({ ...options, flags: MessageFlags.Ephemeral });
  }
}

export const replyOk = (i: RepliableInteraction, message: string) => send(i, { embeds: [okEmbed(message)] });
export const replyFail = (i: RepliableInteraction, message: string) => send(i, { embeds: [failEmbed(message)] });
export const replyWarn = (i: RepliableInteraction, message: string) => send(i, { embeds: [warnEmbed(message)] });
export const replyEmbed = (i: RepliableInteraction, embed: EmbedBuilder, extra: Omit<InteractionReplyOptions, 'embeds' | 'flags'> = {}) => send(i, { ...extra, embeds: [embed] });
