export interface TranscriptMessage { author: string; authorId: string; avatar?: string; at: Date; content: string; attachments: string[]; embeds: number; bot: boolean }

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeHref = (url: string): string | null => (/^https:\/\//i.test(url) ? escapeHtml(url) : null);

/** Self-contained HTML transcript. All user content is escaped: this file gets opened in a browser. */
export function renderTranscript(meta: { guildName: string; number: number; subject: string; owner: string; closedBy: string }, messages: TranscriptMessage[]): string {
  const rows = messages.map((m) => {
    const files = m.attachments.map((a) => {
      const href = safeHref(a);
      return href ? `<a href="${href}" rel="noreferrer noopener">${escapeHtml(a.split('/').pop()?.split('?')[0] ?? 'attachment')}</a>` : '';
    }).join(' ');
    return `<article><header><strong>${escapeHtml(m.author)}</strong>${m.bot ? '<span class="tag">BOT</span>' : ''}<time>${m.at.toISOString().replace('T', ' ').slice(0, 19)} UTC</time></header>${m.content ? `<p>${escapeHtml(m.content).replace(/\n/g, '<br>')}</p>` : ''}${m.embeds ? `<p class="dim">[${m.embeds} embed${m.embeds > 1 ? 's' : ''}]</p>` : ''}${files ? `<p class="files">${files}</p>` : ''}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket #${meta.number} transcript</title><style>
body{margin:0;background:#07050f;color:#e7e3f5;font:15px/1.5 system-ui,sans-serif}main{max-width:820px;margin:auto;padding:24px 16px}h1{font-size:20px;margin:0}.meta{color:#9d96b8;margin:6px 0 24px}article{border-top:1px solid #231c3a;padding:12px 0}header{display:flex;gap:8px;align-items:baseline}time{margin-left:auto;color:#6f688a;font-size:12px}p{margin:4px 0;word-wrap:break-word}.tag{background:#7c3aed;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px}.dim{color:#9d96b8}a{color:#60a5fa}
</style></head><body><main><h1>Ticket #${meta.number}: ${escapeHtml(meta.subject)}</h1><div class="meta">${escapeHtml(meta.guildName)} · Opened by ${escapeHtml(meta.owner)} · Closed by ${escapeHtml(meta.closedBy)} · ${messages.length} messages</div>${rows}</main></body></html>`;
}
