import type { ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';

/* Styled tooltip that shows almost immediately — for places where the native
   `title` attribute's ~1s delay and unstyled box aren't good enough. Renders
   in a portal above the trigger, so overflow containers can't clip it. */
export function HoverTip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <Tooltip.Provider delay={100}>
      <Tooltip.Root>
        <Tooltip.Trigger render={<span className="cursor-pointer" />}>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={6}>
            <Tooltip.Popup className="z-50 max-w-md rounded-md bg-popover p-2.5 text-xs leading-relaxed whitespace-pre-line text-popover-foreground shadow-md ring-1 ring-foreground/10">
              {content}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
