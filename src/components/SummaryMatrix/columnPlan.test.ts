import { MAX_GROUP_COLUMNS, planColumns } from './columnPlan'

const g = (n: number) => ({
    id: `g${n}`,
    displayName: `Group ${n}`,
    canWrite: true,
})

// One row, so a group's total is just its own cell.
const resultWith = (perGroup: number[]) => ({
    groups: perGroup.map((_, i) => g(i)),
    rows: [
        {
            object: 0,
            row: null,
            perGroup,
            missing: 0,
            unassigned: 0,
            conflict: 0,
            total: perGroup.reduce((a, b) => a + b, 0),
        },
    ],
})

describe('planColumns', () => {
    it('shows every group when there are few enough', () => {
        const plan = planColumns(resultWith([5, 1, 3]))
        expect(plan.shown.map((s) => s.index)).toEqual([0, 2, 1])
        expect(plan.other).toEqual([])
    })

    it('caps at MAX_GROUP_COLUMNS, biggest total first', () => {
        const perGroup = Array.from({ length: 12 }, (_, i) => i)
        const plan = planColumns(resultWith(perGroup))
        expect(plan.shown).toHaveLength(MAX_GROUP_COLUMNS)
        expect(plan.shown[0].index).toBe(11)
        expect(plan.other).toHaveLength(12 - MAX_GROUP_COLUMNS)
        // nothing is lost: shown + other is every group, once each
        expect(
            [...plan.shown, ...plan.other].map((s) => s.index).sort((a, b) => a - b)
        ).toEqual(perGroup.map((_, i) => i))
    })

    it('sums a group across every row, not just the first', () => {
        const result = {
            groups: [g(0), g(1)],
            rows: [
                { object: 0, row: null, perGroup: [1, 9], missing: 0, unassigned: 0, conflict: 0, total: 10 },
                { object: 1, row: null, perGroup: [9, 0], missing: 0, unassigned: 0, conflict: 0, total: 9 },
            ],
        }
        const plan = planColumns(result)
        expect(plan.ranked.map((r) => r.total)).toEqual([10, 9])
    })

    it('honours a pinned selection over the ranking', () => {
        const perGroup = Array.from({ length: 12 }, (_, i) => i)
        const plan = planColumns(resultWith(perGroup), [0, 1])
        expect(plan.shown.map((s) => s.index)).toEqual([1, 0])
        expect(plan.other).toHaveLength(10)
    })

    it('ranks every group even when none are capped', () => {
        const plan = planColumns(resultWith([5, 1, 3]))
        expect(plan.ranked.map((r) => r.index)).toEqual([0, 2, 1])
    })
})
