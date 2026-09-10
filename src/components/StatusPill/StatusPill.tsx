import i18n from '@dhis2/d2-i18n'
import { Tag } from '@dhis2/ui'
import React from 'react'
import styles from './StatusPill.module.css'
import { Status } from '@/engine/types'

// `@dhis2/ui`'s `Tag` only offers `positive` (green), `negative` (red) and
// `neutral` (blue) -- there is no yellow variant (checked
// node_modules/.pnpm/@dhis2-ui+tag@10.17.0.../src/tag.js: its propTypes and
// styled-jsx block enumerate exactly those three plus the unstyled
// default). The brief calls for yellow specifically to keep a soft
// "missing, but only a warning" apart from a hard "missing, an error" --
// so the warning case renders as a small pill styled directly against the
// yellow design tokens instead of `Tag`, matching `Tag`'s own sizing so it
// sits at the same height inline with the others.
export const StatusPill = ({ status }: { status: Status }) => {
    switch (status) {
        case Status.Ok:
            return <Tag positive>{i18n.t('OK')}</Tag>
        case Status.MissingError:
            return <Tag negative>{i18n.t('Missing')}</Tag>
        case Status.MissingWarning:
            return (
                <span className={styles.warning}>
                    {i18n.t('Missing (warning)')}
                </span>
            )
        case Status.Conflict:
            return <Tag negative>{i18n.t('Conflict')}</Tag>
        default:
            return <Tag neutral>{i18n.t('Not applicable')}</Tag>
    }
}
