import { describe, expect, it } from 'vitest';
import { decodeCharacterReference } from '../../config/escapeCharacter';
import { generator, tokenizer, tokensToInlineHtml, tokensToPlainText } from '../lexer';

describe('commonMark character references and hard breaks', () => {
    it.each([
        ['&#65;', 'A'],
        ['&#x1F600;', '😀'],
        ['&#X22;', '"'],
        ['&#0;', '�'],
        ['&#xD800;', '�'],
        ['&#1114112;', '�'],
        ['&#x110000;', '�'],
    ])('decodes %s without changing the source token', (source, character) => {
        const tokens = tokenizer(source);
        expect(decodeCharacterReference(source)).toBe(character);
        expect(tokens[0].type).toBe('html_escape');
        expect(tokensToPlainText(tokens)).toBe(character);
        expect(generator(tokens)).toBe(source);
    });

    it('keeps invalid references and code literal, and escapes decoded HTML characters', () => {
        for (const source of ['&#;', '&#x;', '&#12345678;', '&#x1234567;', '&MadeUpEntity;']) {
            expect(tokensToPlainText(tokenizer(source))).toBe(source);
        }
        expect(tokensToPlainText(tokenizer('`&#65;`'))).toBe('&#65;');
        expect(tokensToInlineHtml(tokenizer('&#60;script&#62;'))).toBe('&lt;script&gt;');
        expect(tokenizer('$&#65;$').some(token => token.type === 'html_escape')).toBe(false);
    });

    it('only treats an unescaped backslash before a newline as a hard break', () => {
        for (const count of [1, 2, 3, 4]) {
            const source = `甲${'\\'.repeat(count)}\n乙`;
            const tokens = tokenizer(source);
            expect(tokens.filter(token => token.type === 'hard_line_break')).toHaveLength(count % 2);
            expect(tokens.filter(token => token.type === 'soft_line_break')).toHaveLength(1 - count % 2);
            for (const token of tokens)
                expect(source.slice(token.range.start, token.range.end)).toBe(token.raw);
            expect(generator(tokens)).toBe(source);
        }
        expect(tokenizer('甲  \n乙').some(token => token.type === 'hard_line_break')).toBe(true);
        expect(tokenizer('`甲\\\n乙`').some(token => token.type === 'hard_line_break')).toBe(false);
    });
});
