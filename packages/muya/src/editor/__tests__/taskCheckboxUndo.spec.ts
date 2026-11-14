// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it } from 'vitest';
import TaskListCheckbox from '../../block/gfm/taskListCheckbox';
import { Muya } from '../../muya';
import { ChangeSource } from '../../types';

let muya: Muya | null = null;
let previousVersion: string | undefined;

beforeEach(() => {
    previousVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    muya?.destroy();
    muya = null;
    if (previousVersion === undefined)
        delete (window as Partial<Window>).MUYA_VERSION;
    else
        window.MUYA_VERSION = previousVersion;
});

it('undo and redo synchronize a task checkbox attachment with the document state', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    muya = new Muya(host, { markdown: '- [ ] parent\n  - [ ] child\n' });
    muya.init();
    const checkbox = muya.domNode.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    let attachment: TaskListCheckbox | undefined;
    muya.editor.scrollPage?.depthFirstTraverse((block) => {
        if (!block.isParent())
            return;
        block.attachments.forEach((node) => {
            if (node instanceof TaskListCheckbox && node.domNode === checkbox)
                attachment = node;
        });
    });
    expect(attachment).toBeDefined();
    muya.editor.history.cutoff();
    attachment!.update(true, ChangeSource.User);
    muya.flush();
    muya.editor.history.cutoff();
    expect(checkbox.checked).toBe(true);
    expect(muya.getMarkdown()).toContain('- [x] child');

    muya.undo();
    muya.flush();
    expect(checkbox.checked).toBe(false);
    expect(muya.getMarkdown()).toContain('- [ ] child');

    muya.redo();
    muya.flush();
    expect(checkbox.checked).toBe(true);
    expect(muya.getMarkdown()).toContain('- [x] child');

    attachment!.update(false, ChangeSource.User);
    muya.flush();
    expect(checkbox.checked).toBe(false);
    expect(muya.getMarkdown()).toContain('- [ ] child');
});
