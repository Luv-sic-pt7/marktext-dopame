// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { CLASS_NAMES } from '../../config';
import { Muya } from '../../muya';

const editors: Muya[] = [];

function boot(markdown: string) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown });
    muya.init();
    editors.push(muya);
    return muya;
}

afterEach(() => {
    while (editors.length)
        editors.pop()!.destroy();
    document.body.innerHTML = '';
});

describe('strikethrough delimiter identity', () => {
    it('keeps selected delimiters addressable without changing raw text or content offsets', () => {
        const markdown = '前缀 ~~中文删除~~ 后缀';
        const muya = boot(markdown);
        const block = muya.editor.scrollPage!.firstContentInDescendant()!;
        block.setCursor(5, 9, true);
        const markers = [...muya.domNode.querySelectorAll(`.${CLASS_NAMES.MU_DEL_MARKER}`)];
        expect(markers).toHaveLength(2);
        expect(markers.map(marker => marker.textContent)).toEqual(['~~', '~~']);
        expect(markers.every(marker => marker.classList.contains(CLASS_NAMES.MU_REMOVE))).toBe(true);
        expect(muya.domNode.querySelector('del')!.textContent).toBe('中文删除');
        expect(muya.editor.selection.getSelection()).toMatchObject({
            anchor: { offset: 5 },
            focus: { offset: 9 },
        });
        expect(muya.getMarkdown().trimEnd()).toBe(markdown);
        muya.format('del');
        muya.flush();
        expect(muya.getMarkdown().trimEnd()).toBe('前缀 中文删除 后缀');
        muya.undo();
        expect(muya.getMarkdown().trimEnd()).toBe(markdown);
    });

    it('does not tag literal tildes, code spans, emphasis or heading text as delete markers', () => {
        const muya = boot('# 标题\n\n字面 \\~\\~ 与 `~~代码~~`，**~~嵌套~~**。');
        expect(muya.domNode.querySelector('h1')!.textContent).toContain('标题');
        expect(muya.domNode.querySelector('code')!.textContent).toBe('~~代码~~');
        expect(muya.domNode.querySelectorAll(`.${CLASS_NAMES.MU_DEL_MARKER}`)).toHaveLength(2);
        expect(muya.domNode.querySelector(`h1 .${CLASS_NAMES.MU_DEL_MARKER}`)).toBeNull();
        expect(muya.domNode.querySelector(`code .${CLASS_NAMES.MU_DEL_MARKER}`)).toBeNull();
        expect(muya.getMarkdown()).toContain('**~~嵌套~~**');
    });
});
