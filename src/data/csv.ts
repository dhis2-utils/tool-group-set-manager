// A spreadsheet reads a cell that starts with one of these as a formula.
// Names and History notes are free text any app user can write, so an
// export opened in Excel would run them (CSV formula injection).
const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[,"\r\n]/

function csvField(raw: string): string {
    // The leading apostrophe makes the spreadsheet treat the cell as text.
    // Only the writer adds it: `parseCsv` reads SQL view data, which never
    // passes through here, so nothing has to strip it again.
    const value = FORMULA_START.test(raw) ? `'${raw}` : raw
    return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Minimal RFC 4180 writer, the counterpart to `parseCsv` below. Rows are
 * joined with CRLF, the line ending the format specifies, and a field is
 * quoted (with any embedded quote doubled) only when it actually needs it
 * -- a comma, a quote, or either kind of newline. A field a spreadsheet
 * would run as a formula is prefixed with an apostrophe first.
 */
export function toCsv(rows: string[][]): string {
    return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

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
