import { useState, type ComponentProps } from 'react'
import { RuntimeContext, useLocalState, useRuntime, useSyncState } from '../sync/context'
import { creationEditorSelection } from '../lib/unified-task'
import { TaskCreationFlow } from './TaskCreationFlow'
import { RecurringCreationFlow } from './RecurringCreationFlow'
import { UnifiedTaskFlow } from './UnifiedTaskForm'
export function NewTaskFlow(props: ComponentProps<typeof TaskCreationFlow>) {
  const context = useRuntime()
  const local = useLocalState(), sync = useSyncState()
  const [selection] = useState(() => creationEditorSelection(context.restore, local.drafts, sync.projection))
  return <RuntimeContext.Provider value={{ ...context, restore: selection.restore }}>
    {selection.route === 'oneOff' ? <TaskCreationFlow {...props} /> : selection.route === 'recurring' ? <RecurringCreationFlow {...props} /> : <UnifiedTaskFlow {...props} />}
  </RuntimeContext.Provider>
}
