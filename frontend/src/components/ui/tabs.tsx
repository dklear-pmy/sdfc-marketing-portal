import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

function Tabs({ className, orientation = 'horizontal', ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex items-center text-muted-foreground group-data-vertical/tabs:flex-col',
  {
    variants: {
      variant: {
        /* Real tabs — a rule across the container with the active tab
           underlined in orange. This is the DEFAULT so every page-level
           selector reads as navigation, matching the talent platform's
           event tabs; the two apps should look like one product. */
        default:
          'w-full justify-start gap-0 rounded-none border-b border-border bg-transparent p-0 group-data-vertical/tabs:w-fit group-data-vertical/tabs:items-start group-data-vertical/tabs:border-b-0',
        /* Segmented control. Reserve for floating/overlay controls that sit
           on top of other content (the stadium map), where an underline has
           no edge to sit on. Never for page navigation. */
        pill: 'w-fit justify-center rounded-lg bg-muted p-[3px] group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function TabsList({
  className,
  variant = 'default',
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex cursor-pointer items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        /* Underline tab: the -mb-px pulls its own border over the list's
           rule so the active tab reads as continuous with the panel. */
        'group-data-[variant=default]/tabs-list:-mb-px group-data-[variant=default]/tabs-list:rounded-none group-data-[variant=default]/tabs-list:border-b-2 group-data-[variant=default]/tabs-list:border-transparent group-data-[variant=default]/tabs-list:px-4 group-data-[variant=default]/tabs-list:py-3',
        'group-data-[variant=default]/tabs-list:hover:border-border group-data-[variant=default]/tabs-list:hover:text-foreground',
        'group-data-[variant=default]/tabs-list:data-active:border-sdfc-orange-medium group-data-[variant=default]/tabs-list:data-active:text-sdfc-orange-medium dark:group-data-[variant=default]/tabs-list:data-active:border-sdfc-orange dark:group-data-[variant=default]/tabs-list:data-active:text-sdfc-orange',
        /* Segmented pill (overlay only). */
        'group-data-[variant=pill]/tabs-list:h-[calc(100%-1px)] group-data-[variant=pill]/tabs-list:flex-1 group-data-[variant=pill]/tabs-list:rounded-md group-data-[variant=pill]/tabs-list:border group-data-[variant=pill]/tabs-list:border-transparent group-data-[variant=pill]/tabs-list:px-1.5 group-data-[variant=pill]/tabs-list:py-0.5 group-data-[variant=pill]/tabs-list:text-foreground/60',
        'group-data-[variant=pill]/tabs-list:hover:text-foreground',
        'group-data-[variant=pill]/tabs-list:data-active:bg-background group-data-[variant=pill]/tabs-list:data-active:text-foreground group-data-[variant=pill]/tabs-list:data-active:shadow-sm dark:group-data-[variant=pill]/tabs-list:data-active:border-input dark:group-data-[variant=pill]/tabs-list:data-active:bg-input/30',
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('flex-1 text-sm outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
