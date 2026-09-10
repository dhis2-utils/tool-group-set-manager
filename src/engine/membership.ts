export interface SetMembership {
    /** group position in the set, -1 = none, -2 = more than one */
    groupOf: Int32Array
    /** number of groups of this set the object belongs to, saturating at 255 */
    memberCount: Uint8Array
    /** sorted member object indexes per group position */
    groupMembers: Int32Array[]
}

export function buildSetMembership(
    n: number,
    groupMembers: Int32Array[]
): SetMembership {
    const groupOf = new Int32Array(n).fill(-1)
    const memberCount = new Uint8Array(n)
    const sorted = groupMembers.map((members) => members.slice().sort())
    // Tracks, per object, the last group index that already counted it, so
    // a duplicate id within one group's own member list isn't counted (and
    // reported as a conflict) twice.
    const lastCountedGroup = new Int32Array(n).fill(-1)

    sorted.forEach((members, g) => {
        for (let k = 0; k < members.length; k++) {
            const idx = members[k]
            if (lastCountedGroup[idx] === g) {
                continue
            }
            lastCountedGroup[idx] = g
            if (memberCount[idx] < 255) {
                memberCount[idx]++
            }
            groupOf[idx] = memberCount[idx] === 1 ? g : -2
        }
    })

    return { groupOf, memberCount, groupMembers: sorted }
}

function contains(sortedMembers: Int32Array, idx: number): boolean {
    let lo = 0
    let hi = sortedMembers.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const v = sortedMembers[mid]
        if (v === idx) {
            return true
        }
        if (v < idx) {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return false
}

export function groupsOf(m: SetMembership, idx: number): number[] {
    if (m.memberCount[idx] === 0) {
        return []
    }
    if (m.groupOf[idx] >= 0) {
        return [m.groupOf[idx]]
    }
    const result: number[] = []
    m.groupMembers.forEach((members, g) => {
        if (contains(members, idx)) {
            result.push(g)
        }
    })
    return result
}
