import {it,expect} from 'vitest';
import {messageMarkdown} from '../apps/dashboard/public/lib/markdown.js';
it('formats agent text without interpreting HTML, link targets or code contents',()=>{
 const html=messageMarkdown('# Findings\n\n**Bold** and *emphasis*\n\n- one\n- two\n\n```html\n<img src=x onerror=alert(1)>\n```\n<script>alert(1)</script>\n[click](javascript:alert(1))');
 expect(html).toContain('<h4>Findings</h4>');expect(html).toContain('<strong>Bold</strong>');expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
 expect(html).not.toMatch(/<script|<img|<a\s/i);expect(html).toContain('&lt;img');
 expect(messageMarkdown('`**literal**`')).toContain('<code>**literal**</code>');
});
