import { act, renderHook } from '@testing-library/react'
import { useCatchAllCreation } from './useCatchAllCreation'
import type { Fetcher } from '@/data/sources/DataSource'
import type { GroupSetMeta } from '@/engine/types'

const mockCreateCatchAllGroup = jest.fn()
jest.mock('@/data/metadataWrites', () => ({
    ...jest.requireActual('@/data/metadataWrites'),
    createCatchAllGroup: (...args: unknown[]) =>
        mockCreateCatchAllGroup(...args),
}))

const set: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [],
}
const fetcher = jest.fn() as unknown as Fetcher

const renderCreation = (
    onCreated = jest.fn(),
    reload = jest.fn(() => Promise.resolve(undefined))
) => renderHook(() => useCatchAllCreation({ set, fetcher, reload, onCreated }))

beforeEach(() => {
    mockCreateCatchAllGroup.mockReset()
})

test('seeds both names from the generated catch-all names for the set', () => {
    const { result } = renderCreation()
    expect(result.current.names.displayName).toMatch(/Ownership/)
    expect(result.current.names.shortName.length).toBeGreaterThan(0)
    expect(result.current.namesValid).toBe(true)
})

test('flags a short name over 50 characters and refuses to create', async () => {
    const { result } = renderCreation()
    act(() => {
        result.current.setNames((n) => ({ ...n, shortName: 'x'.repeat(51) }))
    })
    expect(result.current.nameTooLong).toBe(true)
    expect(result.current.namesValid).toBe(false)
    await act(async () => {
        await result.current.create()
    })
    expect(mockCreateCatchAllGroup).not.toHaveBeenCalled()
})

test('creates with trimmed names, reports the group, reloads, and tells the caller', async () => {
    const created = { id: 'new1', displayName: 'Other' }
    mockCreateCatchAllGroup.mockResolvedValue(created)
    const onCreated = jest.fn()
    const reload = jest.fn(() => Promise.resolve(undefined))
    const { result } = renderCreation(onCreated, reload)
    act(() => {
        result.current.setNames({
            displayName: '  Other  ',
            shortName: ' Oth ',
        })
    })
    await act(async () => {
        await result.current.create()
    })
    expect(mockCreateCatchAllGroup).toHaveBeenCalledWith(fetcher, set, {
        displayName: 'Other',
        shortName: 'Oth',
    })
    expect(result.current.createdGroup).toEqual(created)
    expect(onCreated).toHaveBeenCalledWith(created)
    expect(reload).toHaveBeenCalledWith(false)
    expect(result.current.creating).toBe(false)
})

test('turns the cross-set name token into the translated sentence', async () => {
    const { NAME_OWNED_BY_ANOTHER_SET } = jest.requireActual(
        '@/data/metadataWrites'
    )
    mockCreateCatchAllGroup.mockRejectedValue(
        new Error(NAME_OWNED_BY_ANOTHER_SET)
    )
    const { result } = renderCreation()
    await act(async () => {
        await result.current.create()
    })
    expect(result.current.error).toMatch(
        /already belongs to a different group set/
    )
})
