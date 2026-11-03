import { parseCsv, toCsv } from './csv'

describe('parseCsv', () => {
    it('splits rows and columns', () => {
        expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
            ['a', 'b', 'c'],
            ['1', '2', '3'],
        ])
    })

    it('handles CRLF and quoted fields with commas and doubled quotes', () => {
        expect(parseCsv('uid,name\r\nx1,"Clinic, ""A"""\r\n')).toEqual([
            ['uid', 'name'],
            ['x1', 'Clinic, "A"'],
        ])
    })

    it('keeps empty fields', () => {
        expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']])
    })

    it('keeps a newline embedded in a quoted field', () => {
        expect(parseCsv('uid,note\nx1,"line1\nline2"\n')).toEqual([
            ['uid', 'note'],
            ['x1', 'line1\nline2'],
        ])
    })
})

describe('toCsv', () => {
    it('joins plain fields with commas and rows with CRLF', () => {
        expect(
            toCsv([
                ['a', 'b', 'c'],
                ['1', '2', '3'],
            ])
        ).toBe('a,b,c\r\n1,2,3\r\n')
    })

    it('quotes a field containing a comma, a quote and a newline, doubling the quote', () => {
        expect(toCsv([['x1', 'Clinic, "A"\nnext line']])).toBe(
            'x1,"Clinic, ""A""\nnext line"\r\n'
        )
    })

    it('round-trips through parseCsv', () => {
        const rows = [
            ['uid', 'name', 'note'],
            ['a1', 'Plain', ''],
            ['a2', 'Has, comma', 'Quote " here\nand a newline'],
        ]
        expect(parseCsv(toCsv(rows))).toEqual(rows)
    })
})
