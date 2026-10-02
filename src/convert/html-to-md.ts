import TurndownService from 'turndown';

const MAX_HTML_CHARS = 1_000_000;

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});
turndown.remove(['style', 'script', 'head', 'title', 'meta', 'noscript']);
turndown.addRule('dropImages', { filter: 'img', replacement: () => '' });

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/ /g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Converts HTML to Markdown. Never throws: oversized or pathological HTML (deep nesting,
 * huge whitespace runs) falls back to the plain-text part, or to the HTML with tags stripped.
 */
export function htmlToMarkdown(html: string, fallbackText?: string): string {
  try {
    if (html.length > MAX_HTML_CHARS) throw new Error('html too large');
    return tidy(turndown.turndown(html.replace(/[ \t\r\n ]{200,}/g, ' ')));
  } catch {
    return tidy(fallbackText?.trim() || stripTags(html));
  }
}
