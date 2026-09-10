import { SetMembership } from './membership'
import { EngineConfig, GroupSetMeta } from './types'

export interface ObjectAttributes {
    /** data elements: 1 = AGGREGATE, 2 = TRACKER */
    domainType?: Uint8Array
    /** category options: category indexes each option belongs to */
    categoryOfOption?: Int32Array[]
}

/**
 * Which objects a group set applies to (spec 3.1). 1 = in population.
 */
// eslint-disable-next-line max-params -- signature fixed by the engine's task-6 contract
export function populationFor(
    set: GroupSetMeta,
    n: number,
    membership: SetMembership,
    attrs: ObjectAttributes,
    config: EngineConfig
): Uint8Array {
    const population = new Uint8Array(n)

    switch (set.objectType) {
        case 'organisationUnit':
        case 'indicator':
            population.fill(1)
            return population

        case 'dataElement': {
            const domainType = attrs.domainType
            if (!domainType) {
                population.fill(1)
                return population
            }
            for (let i = 0; i < n; i++) {
                const isAggregate = domainType[i] === 1
                population[i] = isAggregate || config.includeTracker ? 1 : 0
            }
            return population
        }

        case 'categoryOption': {
            const categoryOfOption = attrs.categoryOfOption
            if (!categoryOfOption) {
                population.fill(1)
                return population
            }
            // Categories touched by the set: every category of every current member.
            const touched = new Set<number>()
            for (let i = 0; i < n; i++) {
                if (membership.memberCount[i] > 0) {
                    categoryOfOption[i].forEach((c) => touched.add(c))
                }
            }
            for (let i = 0; i < n; i++) {
                population[i] = categoryOfOption[i].some((c) => touched.has(c)) ? 1 : 0
            }
            return population
        }
    }
}
