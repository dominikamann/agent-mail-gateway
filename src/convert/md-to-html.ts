import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const STYLE =
  'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5';

export function markdownToHtml(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  const safe = sanitizeHtml(rendered, {
    allowedTags: sanitizeHtml.defaults.allowedTags,
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
  return `<!doctype html><html><body style="${STYLE}">${safe}</body></html>`;
}
