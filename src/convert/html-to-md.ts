import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});
turndown.remove(['style', 'script', 'head', 'title', 'meta', 'noscript']);
turndown.addRule('dropImages', { filter: 'img', replacement: () => '' });

export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
