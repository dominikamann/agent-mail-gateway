import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { GatewayError } from '../errors.js';

const STYLE =
  'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5';

export function markdownToHtml(markdown: string): string {
  let rendered: string;
  try {
    rendered = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  } catch {
    // e.g. thousands of nested quotes overflow the renderer's stack
    throw new GatewayError(
      'validation_error',
      'The text cannot be rendered (too deeply nested); simplify its formatting',
    );
  }
  const safe = sanitizeHtml(rendered, {
    allowedTags: sanitizeHtml.defaults.allowedTags,
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
  return `<!doctype html><html><body style="${STYLE}">${safe}</body></html>`;
}
