export interface Hierarchy {
    n: number
    level: Uint8Array
    parent: Int32Array
    /** position of each object in depth-first order */
    order: Int32Array
    /** exclusive end (in order positions) of each object's subtree */
    subtreeEnd: Int32Array
    /** object index at each order position */
    byOrder: Int32Array
}

/**
 * Builds a depth-first numbering so that "idx is in the subtree of root"
 * becomes a range check on order positions. Iterative, so a 266K-node tree
 * does not overflow the call stack. Input order is arbitrary.
 */
export function buildHierarchy(
    parent: Int32Array,
    level: Uint8Array
): Hierarchy {
    const n = parent.length
    // Build child adjacency as CSR arrays (firstChild offsets + children list).
    const childCount = new Int32Array(n + 1)
    for (let i = 0; i < n; i++) {
        const p = parent[i]
        if (p >= 0) {
            childCount[p + 1]++
        }
    }
    for (let i = 0; i < n; i++) {
        childCount[i + 1] += childCount[i]
    }
    const children = new Int32Array(n)
    const fill = childCount.slice(0, n)
    for (let i = 0; i < n; i++) {
        const p = parent[i]
        if (p >= 0) {
            children[fill[p]++] = i
        }
    }

    const order = new Int32Array(n)
    const subtreeEnd = new Int32Array(n)
    const byOrder = new Int32Array(n)
    const stack = new Int32Array(n)
    let position = 0

    for (let root = 0; root < n; root++) {
        if (parent[root] >= 0) {
            continue
        }
        let top = 0
        stack[top++] = root
        // A negative marker on the stack means "post-visit": set subtreeEnd.
        while (top > 0) {
            const node = stack[--top]
            if (node < 0) {
                subtreeEnd[~node] = position
                continue
            }
            order[node] = position
            byOrder[position] = node
            position++
            stack[top++] = ~node
            for (let c = childCount[node + 1] - 1; c >= childCount[node]; c--) {
                stack[top++] = children[c]
            }
        }
    }

    return { n, level, parent, order, subtreeEnd, byOrder }
}

export function isInSubtree(h: Hierarchy, root: number, idx: number): boolean {
    const pos = h.order[idx]
    return pos >= h.order[root] && pos < h.subtreeEnd[root]
}

export function ancestorAtLevel(
    h: Hierarchy,
    idx: number,
    level: number
): number {
    let node = idx
    while (node >= 0 && h.level[node] > level) {
        node = h.parent[node]
    }
    return node >= 0 && h.level[node] === level ? node : -1
}
