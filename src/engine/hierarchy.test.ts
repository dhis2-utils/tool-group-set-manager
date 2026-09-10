import { ancestorAtLevel, buildHierarchy, isInSubtree } from './hierarchy'

// Tree (index: level):
// 0 root (1)
// ├─ 1 A (2)
// │  ├─ 3 A1 (3)
// │  └─ 4 A2 (3)
// └─ 2 B (2)
//    └─ 5 B1 (3)
//       └─ 6 B1x (4)
const parent = Int32Array.from([-1, 0, 0, 1, 1, 2, 5])
const level = Uint8Array.from([1, 2, 2, 3, 3, 3, 4])

describe('buildHierarchy', () => {
    const h = buildHierarchy(parent, level)

    it('assigns a depth-first order where children follow their parent', () => {
        expect(h.order[0]).toBe(0)
        expect(h.order[1]).toBeLessThan(h.order[3])
        expect(h.order[1]).toBeLessThan(h.order[4])
        expect(h.order[2]).toBeLessThan(h.order[5])
        expect(h.order[5]).toBeLessThan(h.order[6])
    })

    it('subtreeEnd covers exactly the descendants', () => {
        expect(h.subtreeEnd[0] - h.order[0]).toBe(7)
        expect(h.subtreeEnd[1] - h.order[1]).toBe(3)
        expect(h.subtreeEnd[2] - h.order[2]).toBe(3)
        expect(h.subtreeEnd[6] - h.order[6]).toBe(1)
    })

    it('byOrder inverts order', () => {
        for (let i = 0; i < 7; i++) {
            expect(h.byOrder[h.order[i]]).toBe(i)
        }
    })

    it('handles a forest with several roots', () => {
        const f = buildHierarchy(
            Int32Array.from([-1, -1, 0, 1]),
            Uint8Array.from([1, 1, 2, 2])
        )
        expect(f.subtreeEnd[0] - f.order[0]).toBe(2)
        expect(f.subtreeEnd[1] - f.order[1]).toBe(2)
    })

    it('does not depend on input order (children before parents)', () => {
        const p = Int32Array.from([1, -1])
        const l = Uint8Array.from([2, 1])
        const h2 = buildHierarchy(p, l)
        expect(isInSubtree(h2, 1, 0)).toBe(true)
        expect(isInSubtree(h2, 0, 1)).toBe(false)
    })
})

describe('isInSubtree', () => {
    const h = buildHierarchy(parent, level)
    it('includes the root itself and all descendants', () => {
        expect(isInSubtree(h, 2, 2)).toBe(true)
        expect(isInSubtree(h, 2, 5)).toBe(true)
        expect(isInSubtree(h, 2, 6)).toBe(true)
        expect(isInSubtree(h, 2, 3)).toBe(false)
        expect(isInSubtree(h, 0, 6)).toBe(true)
    })

    it("does not report unreachable (cyclic) nodes as inside a real root's subtree", () => {
        // Node 0 is a real root with no children. Nodes 1 and 2 point at
        // each other and are never visited by the depth-first walk, so they
        // must not collide with root 0's own (unused) order/subtreeEnd
        // sentinel position.
        const corrupted = buildHierarchy(
            Int32Array.from([-1, 2, 1]),
            Uint8Array.from([1, 2, 2])
        )
        expect(isInSubtree(corrupted, 0, 1)).toBe(false)
        expect(isInSubtree(corrupted, 0, 2)).toBe(false)
    })
})

describe('ancestorAtLevel', () => {
    const h = buildHierarchy(parent, level)
    it('walks up to the requested level', () => {
        expect(ancestorAtLevel(h, 6, 2)).toBe(2)
        expect(ancestorAtLevel(h, 6, 3)).toBe(5)
        expect(ancestorAtLevel(h, 6, 4)).toBe(6)
        expect(ancestorAtLevel(h, 3, 1)).toBe(0)
    })
    it('returns -1 when the object is above the requested level', () => {
        expect(ancestorAtLevel(h, 1, 3)).toBe(-1)
    })

    it('returns -1 instead of looping forever on a parent cycle', () => {
        // Two nodes point at each other at the same level, violating the
        // "parent is strictly shallower" invariant. The walk must detect
        // this and bail out rather than spin forever.
        const cyclic = buildHierarchy(
            Int32Array.from([1, 0]),
            Uint8Array.from([2, 2])
        )
        expect(ancestorAtLevel(cyclic, 0, 1)).toBe(-1)
    })
})
