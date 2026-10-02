import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/convert/html-to-md.js';
import { markdownToHtml } from '../../src/convert/md-to-html.js';

describe('htmlToMarkdown', () => {
  it('converts headings, emphasis, links and lists', () => {
    const md = htmlToMarkdown(
      '<h1>Hi</h1><p>This is <b>bold</b> and <a href="https://x.de">a link</a>.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(md).toContain('# Hi');
    expect(md).toContain('**bold**');
    expect(md).toContain('[a link](https://x.de)');
    expect(md).toMatch(/-\s+one/);
  });

  it('drops styles, scripts and images', () => {
    const md = htmlToMarkdown(
      '<head><style>p{color:red}</style><title>T</title></head><script>alert(1)</script><p>Text<img src="cid:logo"></p>',
    );
    expect(md).toBe('Text');
  });

  it('survives messy newsletter html without throwing', () => {
    const html =
      '<table><tr><td><table><tr><td><font face="Arial">Deal&nbsp;of the day</font></td></tr></table></td></tr></table><div><p>Unclosed <span>tags<br><br><br><br>end';
    const md = htmlToMarkdown(html);
    expect(md).toContain('Deal');
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('markdownToHtml', () => {
  it('renders markdown to an html document', () => {
    const html = markdownToHtml('# Title\n\nHello **world**\n\n- a\n- b');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('<li>a</li>');
  });

  it('removes dangerous html', () => {
    const html = markdownToHtml(
      'hi <script>alert(1)</script> <a href="javascript:alert(1)">x</a> <img src=x onerror=alert(1)>',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror');
  });
});
