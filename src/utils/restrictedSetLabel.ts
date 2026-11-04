import i18n from '@dhis2/d2-i18n'
import { interpolate } from '@/utils/interpolate'

/**
 * Why a group set the user can see cannot be checked: some of its groups
 * are not shared with them. Whole sentences, chosen on the count (see
 * groupsLabel.ts for why there is no pluralising i18n.t call). Shared by
 * the dashboard card and the group set page's notice so the two say the
 * same thing.
 */
export const restrictedSetLabel = (hidden: number, total: number): string => {
    const values = {
        hidden: hidden.toLocaleString(),
        total: total.toLocaleString(),
    }
    if (hidden >= total) {
        return i18n.t(
            'You cannot see any of the groups in this set, so the tool cannot check it. Ask an administrator to share all the groups with you.'
        )
    }
    if (hidden === 1) {
        return interpolate(
            i18n.t(
                'You cannot see 1 of the {total} groups in this set, so the tool cannot check it. Ask an administrator to share all the groups with you.'
            ),
            values
        )
    }
    return interpolate(
        i18n.t(
            'You cannot see {hidden} of the {total} groups in this set, so the tool cannot check it. Ask an administrator to share all the groups with you.'
        ),
        values
    )
}
