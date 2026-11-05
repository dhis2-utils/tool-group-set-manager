import { noGroupIsWarning, noGroupSeverity } from './noGroup'

test('compulsory is an error, a data dimension a warning, anything else neutral', () => {
    expect(noGroupSeverity({ compulsory: true, dataDimension: true })).toBe(
        'error'
    )
    expect(noGroupSeverity({ compulsory: true, dataDimension: false })).toBe(
        'error'
    )
    expect(noGroupSeverity({ compulsory: false, dataDimension: true })).toBe(
        'warning'
    )
    expect(noGroupSeverity({ compulsory: false, dataDimension: false })).toBe(
        'neutral'
    )
    expect(noGroupIsWarning({ compulsory: false, dataDimension: true })).toBe(
        true
    )
})
