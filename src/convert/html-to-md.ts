import TurndownService from 'turndown';

const MAX_HTML_CHARS = 512_000;
const MAX_DEPTH = 500;
// Elements that never or only optionally close; they do not add nesting in practice.
const NO_DEPTH = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
  'p',
  'li',
  'td',
  'th',
  'tr',
  'option',
  'dt',
  'dd',
  'tbody',
  'thead',
  'tfoot',
]);

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});
turndown.remove(['style', 'script', 'head', 'title', 'meta', 'noscript']);
turndown.addRule('dropImages', { filter: 'img', replacement: () => '' });

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 45;

/** Linear scan: true if the HTML nests deeper than turndown can handle in reasonable time. */
function tooDeep(html: string): boolean {
  let depth = 0;
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) !== 60) continue;
    const next = html.charCodeAt(i + 1);
    if (next === 47) {
      if (depth > 0) depth--;
      continue;
    }
    if (!isLetter(next)) continue;
    let j = i + 1;
    while (j < html.length && isNameChar(html.charCodeAt(j))) j++;
    if (!NO_DEPTH.has(html.slice(i + 1, j).toLowerCase()) && ++depth > MAX_DEPTH) return true;
    i = j - 1;
  }
  return false;
}

/** Linear tag stripper used as a fallback; drops style/script/head contents. */
function stripTags(html: string): string {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const next = html.charCodeAt(lt + 1);
    if (!(isLetter(next) || next === 47 || next === 33)) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < html.length && isNameChar(html.charCodeAt(j))) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const gt = html.indexOf('>', j);
    if (gt < 0) break;
    i = gt + 1;
    if (name === 'style' || name === 'script' || name === 'head') {
      const close = lower.indexOf(`</${name}`, i);
      i = close < 0 ? html.length : close;
    }
    out.push(' ');
  }
  return out.join('').replace(/[ \t]+/g, ' ');
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/ /g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts HTML to Markdown. Never throws, and runs in bounded time: oversized or deeply
 * nested HTML falls back to the plain-text part, or to the HTML with tags stripped.
 */
export function htmlToMarkdown(html: string, fallbackText?: string): string {
  const fallback = () => tidy(fallbackText?.trim() || stripTags(html));
  if (html.length > MAX_HTML_CHARS || tooDeep(html)) return fallback();
  try {
    return tidy(turndown.turndown(html.replace(/[ \t\r\n ]{200,}/g, ' ')));
  } catch {
    return fallback();
  }
}
