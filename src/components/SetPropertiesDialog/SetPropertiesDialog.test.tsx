import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { SetPropertiesDialog } from './SetPropertiesDialog'
import { MetadataWriteError } from '@/data/metadataWrites'
import type { GroupSetMeta } from '@/engine/types'
import { actAndFlush } from '@/testing/actAndFlush'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 42 }),
}))

const mockSetGroupSetProperties = jest.fn()
jest.mock('@/data/metadataWrites', () => ({
    ...jest.requireActual('@/data/metadataWrites'),
    setGroupSetProperties: (...args: unknown[]) =>
        mockSetGroupSetProperties(...args),
}))

const mockSaveChangeSet = jest.fn()
jest.mock('@/data/datastore', () => ({
    saveChangeSet: (...args: unknown[]) => mockSaveChangeSet(...args),
}))

jest.mock('@/utils/useApiDataQuery', () => ({
    useApiDataQuery: () => ({ data: { id: 'me1', displayName: 'Me' } }),
}))

const set: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: false,
    canWrite: true,
    groups: [{ id: 'g1', displayName: 'Alpha', canWrite: true }],
}

const onClose = jest.fn()
const onApplied = jest.fn()

const renderDialog = (override: Partial<GroupSetMeta> = {}) =>
    render(
        <SetPropertiesDialog
            set={{ ...set, ...override }}
            onClose={onClose}
            onApplied={onApplied}
        />
    )

const toggle = (name: RegExp) =>
    fireEvent.click(screen.getByRole('checkbox', { name }))

beforeEach(() => {
    jest.clearAllMocks()
    mockSetGroupSetProperties.mockResolvedValue(undefined)
    mockSaveChangeSet.mockReset()
    mockSaveChangeSet.mockResolvedValue(undefined)
})

describe('SetPropertiesDialog', () => {
    it('shows the group set’s current properties', () => {
        renderDialog()
        expect(
            screen.getByRole('checkbox', { name: /compulsory/i })
        ).toBeChecked()
        expect(
            screen.getByRole('checkbox', { name: /data dimension/i })
        ).not.toBeChecked()
    })

    it('writes nothing until the change is confirmed', async () => {
        renderDialog()
        toggle(/data dimension/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(mockSetGroupSetProperties).not.toHaveBeenCalled()
        expect(
            await screen.findByRole('button', { name: /confirm/i })
        ).toBeInTheDocument()
    })

    it('patches only the properties that actually changed', async () => {
        renderDialog()
        toggle(/data dimension/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(mockSetGroupSetProperties).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                id: 'own',
                objectType: 'organisationUnit',
            }),
            { dataDimension: true }
        )
        await waitFor(() => expect(onApplied).toHaveBeenCalled())
    })

    it('reports the write and does not close itself on success', async () => {
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(await screen.findByText(/updated/i)).toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('reports a failed write rather than letting it vanish', async () => {
        mockSetGroupSetProperties.mockRejectedValue(
            new MetadataWriteError('updateSet', 403)
        )
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(
            await screen.findByText(
                'You do not have permission to change this group set.'
            )
        ).toBeInTheDocument()
        expect(onApplied).not.toHaveBeenCalled()
    })

    // M11: a property change is recorded in History with its before and
    // after values, so it can be reverted from there.
    it('records the change in History with the values before and after', async () => {
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        await waitFor(() => expect(mockSaveChangeSet).toHaveBeenCalled())
        expect(mockSaveChangeSet.mock.calls[0][1]).toMatchObject({
            action: 'properties',
            groupSetId: 'own',
            groupSetName: 'Ownership',
            objectType: 'organisationUnit',
            changes: [],
            properties: {
                before: { compulsory: true },
                after: { compulsory: false },
            },
            createdBy: { id: 'me1', displayName: 'Me' },
        })
    })

    it('says so when the change was made but could not be recorded in History', async () => {
        mockSaveChangeSet.mockRejectedValue(new Error('dataStore down'))
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(
            await screen.findByText('Not recorded in History')
        ).toBeInTheDocument()
        expect(onApplied).toHaveBeenCalled()
    })

    it('records nothing when the server refused the change', async () => {
        mockSetGroupSetProperties.mockRejectedValue(
            new MetadataWriteError('updateSet', 500)
        )
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })
        expect(
            await screen.findByText(
                'The group set could not be updated (HTTP 500).'
            )
        ).toBeInTheDocument()
        expect(mockSaveChangeSet).not.toHaveBeenCalled()
    })

    it('offers no write at all on a group set the user cannot write to', () => {
        renderDialog({ canWrite: false })

        expect(
            screen.getByRole('checkbox', { name: /compulsory/i })
        ).toBeDisabled()
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    })

    it('does not offer to save when nothing was changed', () => {
        renderDialog()
        expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    })
})
