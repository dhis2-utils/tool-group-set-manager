import React, { useEffect, useState } from 'react'
import { MAX_SHORT_NAME_LENGTH } from './constants'
import { catchAllCreationErrorMessage } from '@/data/metadataWriteMessages'
import {
    createCatchAllGroup,
    generateCatchAllNames,
} from '@/data/metadataWrites'
import type { Fetcher } from '@/data/sources/DataSource'
import type { GroupSetMeta } from '@/engine/types'

export interface CatchAllNames {
    displayName: string
    shortName: string
}

export interface CatchAllCreation {
    names: CatchAllNames
    setNames: React.Dispatch<React.SetStateAction<CatchAllNames>>
    nameTooLong: boolean
    namesValid: boolean
    creating: boolean
    error: string | null
    createdGroup: { id: string; displayName: string } | null
    create: () => Promise<void>
}

export function useCatchAllCreation({
    set,
    fetcher,
    reload,
    onCreated,
}: {
    set: GroupSetMeta
    fetcher: Fetcher
    reload: (force: boolean) => Promise<void>
    onCreated: (group: { id: string; displayName: string }) => void
}): CatchAllCreation {
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)
    // Spec 5.2: the user names the catch-all group. Seeded with exactly what
    // the server would otherwise have generated (`generateCatchAllNames` is
    // the single source of that rule, shared with the data layer rather than
    // reimplemented here), and re-seeded if the dialog is pointed at a
    // different set, which would make the previous set's name wrong.
    const [catchAllNames, setCatchAllNames] = useState(() =>
        generateCatchAllNames(set)
    )
    useEffect(() => {
        // oxlint-disable-next-line react/no-deriving-state-in-effects -- the names are user-edited state, seeded from `set` and re-seeded only when `set` changes
        setCatchAllNames(generateCatchAllNames(set))
    }, [set])
    // A group `createCatchAllGroup` just created is not yet part of
    // `set.groups` -- that prop only updates when the parent reloads the
    // engine's group sets, which this dialog does not do for itself. Held
    // here so the target SingleSelect has an option for it immediately
    // (@dhis2/ui's SingleSelect throws if `selected` names no option at
    // all), rather than waiting on a reload this dialog does not trigger.
    //
    // M6 caveats carried forward for the task that adds Apply: (1) the
    // reload must actually happen once Apply confirms the write, or this
    // locally-tracked option is all this dialog will ever show, even after
    // the group is genuinely part of `set.groups` server-side; (2)
    // `createdGroup` has no `canWrite` of its own -- the engine's own
    // `GroupMeta` for it (once loaded) is the only authority a plan can
    // trust for whether it is writable.
    const [createdGroup, setCreatedGroup] = useState<{
        id: string
        displayName: string
    } | null>(null)

    // I7: the new group's id changes the set, and per the cache contract
    // (CLAUDE.md 4.4) the IndexedDB snapshot is only reused when the group
    // ids match the server -- so a non-forced reload here is guaranteed to
    // re-fetch rather than serve the stale snapshot that lacks the new
    // group. Without this, `planAssignment` throws "Unknown target group"
    // the moment the dialog tries to plan against a group it only knows
    // about locally (`createdGroup`), and the app's headline remedy --
    // create a catch-all, then bulk-move into it -- dead-ends in the same
    // session it was created. `createdGroup` stays as the belt-and-braces
    // path for a reload that itself fails.
    // Validated here rather than only on the server: both are required, and
    // DHIS2 caps shortName at 50 characters. Catching it before the request
    // turns a 409/400 whose body this module would have to translate into a
    // field the user can see is wrong while they are still typing.
    const trimmedNames = {
        displayName: catchAllNames.displayName.trim(),
        shortName: catchAllNames.shortName.trim(),
    }
    const nameTooLong = trimmedNames.shortName.length > MAX_SHORT_NAME_LENGTH
    const namesValid =
        trimmedNames.displayName.length > 0 &&
        trimmedNames.shortName.length > 0 &&
        !nameTooLong

    const handleCreateCatchAll = async () => {
        if (!namesValid) {
            return
        }
        setCreating(true)
        setCreateError(null)
        try {
            const created = await createCatchAllGroup(
                fetcher,
                set,
                trimmedNames
            )
            setCreatedGroup(created)
            onCreated(created)
            await reload(false)
        } catch (e) {
            // The data layer has no i18n.t and must not build user-facing
            // prose, so it throws a sentinel or a structured error, and
            // this is where it becomes one translated sentence.
            setCreateError(catchAllCreationErrorMessage(e))
        } finally {
            setCreating(false)
        }
    }

    return {
        names: catchAllNames,
        setNames: setCatchAllNames,
        nameTooLong,
        namesValid,
        creating,
        error: createError,
        createdGroup,
        create: handleCreateCatchAll,
    }
}
