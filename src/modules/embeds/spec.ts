import { ButtonStyle, ComponentType, parseEmoji, type APIActionRowComponent, type APIComponentInMessageActionRow, type APIEmbed, type APIMessageComponentEmoji } from 'discord.js';
import { z } from 'zod';
import { snowflake } from '../../config/guildConfig.js';
import { renderVars, type Vars } from '../../core/variables.js';

const httpUrl = z.string().max(2000).regex(/^https?:\/\/\S+$/, 'Must be an http(s) URL');
/** Also allow {avatar} so templates can use the variable as an image. */
const imageUrl = z.string().max(2000).regex(/^(https?:\/\/\S+|\{avatar\})$/, 'Must be an http(s) URL or {avatar}');

export const FieldSchema = z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().default(false) });

export const EmbedSpecSchema = z.object({
  title: z.string().max(256).optional(),
  url: httpUrl.optional(),
  description: z.string().max(4096).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #7c3aed').default('#7c3aed'),
  authorName: z.string().max(256).optional(),
  authorIcon: imageUrl.optional(),
  footerText: z.string().max(2048).optional(),
  footerIcon: imageUrl.optional(),
  thumbnail: imageUrl.optional(),
  image: imageUrl.optional(),
  timestamp: z.boolean().default(false),
  fields: z.array(FieldSchema).max(25).default([]),
});
export type EmbedSpec = z.infer<typeof EmbedSpecSchema>;

export const LinkButtonSchema = z.object({ kind: z.literal('link'), label: z.string().min(1).max(80), url: httpUrl, emoji: z.string().max(64).optional() });
export const RoleButtonSchema = z.object({ kind: z.literal('role'), label: z.string().min(1).max(80), roleId: snowflake, style: z.enum(['primary', 'secondary', 'success', 'danger']).default('primary'), emoji: z.string().max(64).optional() });
export const ButtonSpecSchema = z.discriminatedUnion('kind', [LinkButtonSchema, RoleButtonSchema]);
export type ButtonSpec = z.infer<typeof ButtonSpecSchema>;

export const RoleMenuSchema = z.object({
  placeholder: z.string().max(150).default('Choose your roles'),
  options: z.array(z.object({ label: z.string().min(1).max(100), roleId: snowflake, description: z.string().max(100).optional(), emoji: z.string().max(64).optional() })).min(1).max(25),
});

const embedLength = (e: EmbedSpec): number => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.authorName?.length ?? 0) + (e.footerText?.length ?? 0) + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

export const MessageSpecSchema = z
  .object({
    content: z.string().max(2000).optional(),
    embeds: z.array(EmbedSpecSchema).max(10).default([]),
    buttons: z.array(ButtonSpecSchema).max(20).default([]),
    roleMenu: RoleMenuSchema.nullish(),
  })
  .superRefine((m, ctx) => {
    const total = m.embeds.reduce((n, e) => n + embedLength(e), 0);
    if (total > 6000) ctx.addIssue({ code: 'custom', message: `All embeds together are ${total} characters. Discord allows 6000.` });
  });
export type MessageSpec = z.infer<typeof MessageSpecSchema>;

export const emptySpec = (): MessageSpec => MessageSpecSchema.parse({ embeds: [{ title: 'New embed', description: 'Use the menu below to edit me.' }] });

export function isEmbedEmpty(e: EmbedSpec): boolean {
  return !e.title && !e.description && !e.authorName && !e.footerText && !e.thumbnail && !e.image && e.fields.length === 0;
}

const STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const;

/** Accepts unicode, <:name:id>, or <a:name:id>. Returns a Discord emoji object. */
export function toEmoji(input: string | undefined): APIMessageComponentEmoji | undefined {
  if (!input) return undefined;
  const parsed = parseEmoji(input);
  if (!parsed) return undefined;
  if (parsed.id) return { id: parsed.id, name: parsed.name, animated: parsed.animated };
  return { name: input };
}

export function renderEmbed(e: EmbedSpec, vars: Vars = {}): APIEmbed {
  const t = (s: string | undefined) => (s ? renderVars(s, vars) : undefined);
  const url = (s: string | undefined) => {
    const v = t(s);
    return v && /^https?:\/\//.test(v) ? v : undefined;
  };
  const out: APIEmbed = { color: parseInt(e.color.slice(1), 16) };
  if (e.title) out.title = t(e.title)!.slice(0, 256);
  if (e.url) out.url = e.url;
  if (e.description) out.description = t(e.description)!.slice(0, 4096);
  if (e.authorName) out.author = { name: t(e.authorName)!.slice(0, 256), icon_url: url(e.authorIcon) };
  if (e.footerText) out.footer = { text: t(e.footerText)!.slice(0, 2048), icon_url: url(e.footerIcon) };
  const thumb = url(e.thumbnail);
  if (thumb) out.thumbnail = { url: thumb };
  const image = url(e.image);
  if (image) out.image = { url: image };
  if (e.timestamp) out.timestamp = new Date().toISOString();
  if (e.fields.length) out.fields = e.fields.map((f) => ({ name: t(f.name)!.slice(0, 256), value: t(f.value)!.slice(0, 1024), inline: f.inline }));
  return out;
}

export function renderComponents(spec: MessageSpec): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  for (let i = 0; i < spec.buttons.length && rows.length < 4; i += 5) {
    rows.push({
      type: ComponentType.ActionRow,
      components: spec.buttons.slice(i, i + 5).map((b, n) =>
        b.kind === 'link'
          ? { type: ComponentType.Button as const, style: ButtonStyle.Link as const, label: b.label, url: b.url, emoji: toEmoji(b.emoji) }
          : { type: ComponentType.Button as const, style: STYLE[b.style], label: b.label, custom_id: `embed:role:${b.roleId}:${i + n}`, emoji: toEmoji(b.emoji) },
      ),
    });
  }
  if (spec.roleMenu) {
    rows.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: 'embed:rolemenu',
        placeholder: spec.roleMenu.placeholder,
        min_values: 0,
        max_values: spec.roleMenu.options.length,
        options: spec.roleMenu.options.map((o) => ({ label: o.label, value: o.roleId, description: o.description, emoji: toEmoji(o.emoji) })),
      }],
    });
  }
  return rows;
}

export function renderMessage(spec: MessageSpec, vars: Vars = {}) {
  return {
    content: spec.content ? renderVars(spec.content, vars) : undefined,
    embeds: spec.embeds.map((e) => renderEmbed(e, vars)),
    components: renderComponents(spec),
  };
}

/** Import of ZYTHERON specs and of plain Discord message JSON, the format most embed tools export. */
export function importJson(text: string): MessageSpec {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'That is not valid JSON.', input: text }]);
  }
  if (raw?.embeds?.some?.((e: any) => e.footer || e.author || typeof e.color === 'number' || e.image?.url || e.thumbnail?.url) || raw?.footer || raw?.author) {
    const list = Array.isArray(raw.embeds) ? raw.embeds : [raw];
    return MessageSpecSchema.parse({
      content: raw.content || undefined,
      embeds: list.map((e: any) => ({
        title: e.title, url: e.url, description: e.description,
        color: typeof e.color === 'number' ? `#${e.color.toString(16).padStart(6, '0')}` : undefined,
        authorName: e.author?.name, authorIcon: e.author?.icon_url, footerText: e.footer?.text, footerIcon: e.footer?.icon_url,
        thumbnail: e.thumbnail?.url, image: e.image?.url, timestamp: Boolean(e.timestamp),
        fields: (e.fields ?? []).map((f: any) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
      })),
    });
  }
  return MessageSpecSchema.parse(raw);
}

export const LIBRARY: Record<string, { label: string; description: string; spec: () => MessageSpec }> = {
  announcement: { label: 'Announcement', description: 'A clean headline with details', spec: () => MessageSpecSchema.parse({ embeds: [{ title: 'Announcement', description: 'Write your announcement here.\n\nAdd the key details and what people should do next.', color: '#3b82f6', footerText: '{server}', timestamp: true }] }) },
  rules: { label: 'Server rules', description: 'Numbered rules with a footer', spec: () => MessageSpecSchema.parse({ embeds: [{ title: 'Server Rules', color: '#7c3aed', description: 'By staying in {server} you agree to the rules below.', fields: [{ name: '1. Be respectful', value: 'No harassment, hate speech or personal attacks.' }, { name: '2. No spam', value: 'Keep messages on topic, and no unsolicited advertising.' }, { name: '3. Follow Discord rules', value: 'The Terms of Service and Community Guidelines apply here.' }], footerText: 'Breaking the rules may lead to removal.' }] }) },
  info: { label: 'Information', description: 'Quick facts in inline columns', spec: () => MessageSpecSchema.parse({ embeds: [{ title: 'About {server}', description: 'Who we are and what you can find here.', color: '#7c3aed', fields: [{ name: 'Members', value: '{membercount}', inline: true }, { name: 'Founded', value: 'Add a date', inline: true }, { name: 'Website', value: 'Add a link', inline: true }] }] }) },
  event: { label: 'Event', description: 'When, where and what', spec: () => MessageSpecSchema.parse({ embeds: [{ title: 'Community Event', description: 'What is happening and why people should come.', color: '#ec4899', fields: [{ name: 'When', value: 'Add a date', inline: true }, { name: 'Where', value: 'Add a channel', inline: true }, { name: 'Hosted by', value: 'Add a name', inline: true }], timestamp: true }] }) },
  roles: { label: 'Role picker', description: 'Starter message with a role section', spec: () => MessageSpecSchema.parse({ embeds: [{ title: 'Pick your roles', description: 'Use the buttons below to add or remove roles.', color: '#10b981' }] }) },
  update: { label: 'Changelog', description: 'Added, changed, fixed', spec: () => MessageSpecSchema.parse({ embeds: [{ title: 'Update', color: '#3b82f6', fields: [{ name: 'Added', value: 'What is new.' }, { name: 'Changed', value: 'What behaves differently.' }, { name: 'Fixed', value: 'What was repaired.' }], timestamp: true }] }) },
};
