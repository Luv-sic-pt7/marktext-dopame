import type { HardLineBreakToken, ISyntaxRenderOptions } from '../types';
import type Renderer from './index';
import { CLASS_NAMES } from '../../config';

export default function hardLineBreak(
    this: Renderer,
    { h, token }: ISyntaxRenderOptions & { token: HardLineBreakToken },
) {
    const { spaces, lineBreak, isAtEnd } = token;
    const bands = this.lineBreakHighlights(
        h,
        token,
        token.range.end - lineBreak.length,
        token.range.end,
    );
    const className = CLASS_NAMES.MU_HARD_LINE_BREAK;
    const spaceClass = CLASS_NAMES.MU_HARD_LINE_BREAK_SPACE;
    const marker = spaces === '\\'
        ? h(`span.${CLASS_NAMES.MU_HIDE}.${CLASS_NAMES.MU_REMOVE}`, spaces)
        : spaces;

    if (isAtEnd) {
        return [
            h(`span.${className}`, h(`span.${spaceClass}`, marker)),
            h(`span.${CLASS_NAMES.MU_LINE_END}`, bands.length ? [...bands, lineBreak] : lineBreak),
        ];
    }
    else {
        return [
            h(`span.${className}`, bands.length
                ? [...bands, h(`span.${spaceClass}`, marker), lineBreak]
                : [h(`span.${spaceClass}`, marker), lineBreak]),
        ];
    }
}
