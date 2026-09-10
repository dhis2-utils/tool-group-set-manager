/** Minimal RFC 4180 parser; fast enough for a few hundred thousand short rows. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let i = 0
    const n = text.length
    while (i < n) {
        const ch = text[i]
        if (ch === '"') {
            i++
            while (i < n) {
                const c = text[i]
                if (c === '"') {
                    if (text[i + 1] === '"') {
                        field += '"'
                        i += 2
                        continue
                    }
                    i++
                    break
                }
                field += c
                i++
            }
            continue
        }
        if (ch === ',') {
            row.push(field)
            field = ''
            i++
            continue
        }
        if (ch === '\n' || ch === '\r') {
            row.push(field)
            field = ''
            rows.push(row)
            row = []
            i++
            if (ch === '\r' && text[i] === '\n') {
                i++
            }
            continue
        }
        // Unquoted run: find the next delimiter in one step.
        let j = i
        while (
            j < n &&
            text[j] !== ',' &&
            text[j] !== '\n' &&
            text[j] !== '\r' &&
            text[j] !== '"'
        ) {
            j++
        }
        field += text.slice(i, j)
        i = j
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field)
        rows.push(row)
    }
    return rows
}
