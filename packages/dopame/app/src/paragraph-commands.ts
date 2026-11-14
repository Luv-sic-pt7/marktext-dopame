export type ParagraphType = 'paragraph' | 'blockquote' | 'ul-bullet' | 'ol-order' | 'ul-task'

export interface ParagraphLineChange {
  text: string
  removed: number
  added: number
}

const listMarker = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)/
const paragraphMarker =
  /^([ \t]*)(?:#{1,6}[ \t]+|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/

function lineType(line: string): ParagraphType {
  if (/^[ \t]*>/.test(line)) return 'blockquote'
  if (/^[ \t]*[-+*][ \t]+\[[ xX]\][ \t]+/.test(line)) return 'ul-task'
  if (/^[ \t]*[-+*][ \t]+/.test(line)) return 'ul-bullet'
  if (/^[ \t]*\d+[.)][ \t]+/.test(line)) return 'ol-order'
  return 'paragraph'
}

export function convertParagraphLines(
  lines: string[],
  requested: ParagraphType
): ParagraphLineChange[] {
  const populated = lines.filter((line) => line.trim())
  const type =
    requested !== 'paragraph' &&
    populated.length &&
    populated.every((line) => lineType(line) === requested)
      ? 'paragraph'
      : requested
  let order = 0
  return lines.map((line) => {
    if (!line.trim() && lines.length > 1 && type !== 'blockquote')
      return { text: line, removed: 0, added: 0 }
    const marker = paragraphMarker.exec(line)
    const indentation = marker?.[1] ?? /^[ \t]*/.exec(line)![0]
    const removed = marker?.[0].length ?? indentation.length
    const body = line.slice(removed)
    const prefix =
      type === 'paragraph'
        ? ''
        : indentation +
          (type === 'blockquote'
            ? '> '
            : type === 'ul-bullet'
              ? '- '
              : type === 'ul-task'
                ? '- [ ] '
                : `${++order}. `)
    return { text: prefix + body, removed, added: prefix.length }
  })
}

/** Change one selected list region, preserving the relative indentation of its descendants. */
export function indentListLines(
  lines: string[],
  from: number,
  to: number,
  outdent: boolean
): ParagraphLineChange[] | null {
  const first = listMarker.exec(lines[from])
  if (!first) return null
  const indentation = first[1].length
  let amount = 0
  for (let line = from - 1; line >= 0; line--) {
    if (!lines[line].trim()) continue
    const previous = listMarker.exec(lines[line])
    if (
      previous &&
      (outdent ? previous[1].length < indentation : previous[1].length === indentation)
    ) {
      amount = outdent ? indentation - previous[1].length : previous[2].length + previous[3].length
      break
    }
    if (outdent && previous) continue
    const previousIndent = /^[ \t]*/.exec(lines[line])![0].length
    if (previousIndent <= indentation) break
  }
  if (!amount) return null
  return lines.slice(from, to + 1).map((line) => {
    if (!line.trim()) return { text: line, removed: 0, added: 0 }
    const removed = outdent ? Math.min(amount, /^[ \t]*/.exec(line)![0].length) : 0
    const prefix = outdent ? '' : ' '.repeat(amount)
    return { text: prefix + line.slice(removed), removed, added: prefix.length }
  })
}
