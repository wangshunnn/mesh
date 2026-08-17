import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Check, ChevronDown } from "lucide-react";
import * as SelectPrimitive from "radix-ui/select";
import * as SlotPrimitive from "radix-ui/slot";
import * as SwitchPrimitive from "radix-ui/switch";
import * as TabsPrimitive from "radix-ui/tabs";
import * as TooltipPrimitive from "radix-ui/tooltip";

import { cn } from "./cn.js";

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

const buttonToneClasses: Readonly<Record<ButtonTone, string>> = Object.freeze({
  primary: "bg-foreground text-white hover:bg-[#343434]",
  secondary: "border border-line-strong bg-white text-foreground-soft hover:bg-sidebar",
  ghost: "bg-transparent text-muted hover:bg-subtle hover:text-foreground",
  danger: "bg-transparent text-danger hover:bg-[#fff0f0]",
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone;
  readonly compact?: boolean;
  readonly asChild?: boolean;
}

export function Button({
  tone = "secondary",
  compact = false,
  asChild = false,
  className,
  type = "button",
  ...props
}: ButtonProps): React.JSX.Element {
  const Component = asChild ? SlotPrimitive.Slot : "button";
  return (
    <Component
      type={asChild ? undefined : type}
      className={cn(
        "app-no-drag inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6b8dc5]/55",
        "disabled:pointer-events-none disabled:opacity-40",
        compact ? "h-7 px-2.5 text-caption" : "h-[34px] px-3 text-meta",
        buttonToneClasses[tone],
        className,
      )}
      {...props}
    />
  );
}

export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  readonly label: string;
  readonly children: ReactNode;
}>(function IconButton({ label, children, className, ...props }, ref): React.JSX.Element {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          className={cn(
            "app-no-drag grid size-[30px] shrink-0 place-items-center rounded-control border-0 bg-transparent",
            "text-muted transition-colors hover:bg-subtle hover:text-foreground focus-visible:outline-2",
            "focus-visible:outline-offset-1 focus-visible:outline-[#6b8dc5]/55 disabled:pointer-events-none disabled:opacity-40",
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-[120] rounded-md bg-[#292929] px-2 py-1 text-caption text-white shadow-popover"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
});

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "success" | "warning" | "danger" | "info";
  readonly className?: string;
}): React.JSX.Element {
  const tones = {
    neutral: "bg-subtle text-foreground-soft",
    success: "bg-success-soft text-success",
    warning: "bg-[#fff8ed] text-warning",
    danger: "bg-[#fff0f0] text-danger",
    info: "bg-info-soft text-info",
  } as const;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-caption", tones[tone], className)}>{children}</span>;
}

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export function SelectControl<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly onValueChange: (value: T) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "app-no-drag flex h-[34px] min-w-0 items-center justify-between gap-2 rounded-row border border-line-strong",
          "bg-white px-2.5 text-left text-meta text-foreground-soft outline-none transition-colors",
          "hover:border-[#c9c9c9] focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/15",
          "disabled:pointer-events-none disabled:opacity-40",
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon><ChevronDown className="size-4 text-muted" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={5}
          className="z-[110] max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-popover border border-line bg-white p-1 shadow-popover"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                className="relative flex h-8 select-none items-center rounded-control py-0 pl-8 pr-2 text-meta text-foreground-soft outline-none data-[disabled]:opacity-35 data-[highlighted]:bg-subtle data-[highlighted]:text-foreground"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2.5 grid place-items-center">
                  <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function SwitchControl({
  checked,
  onCheckedChange,
  ariaLabel,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      disabled={disabled}
      className="relative h-5 w-9 shrink-0 rounded-full bg-subtle-strong outline-none transition-colors data-[state=checked]:bg-foreground focus-visible:ring-2 focus-visible:ring-info/25 disabled:opacity-40"
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

export function TabList<T extends string>({
  value,
  onValueChange,
  items,
  ariaLabel,
  className,
}: {
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly items: readonly { readonly value: T; readonly label: ReactNode }[];
  readonly ariaLabel: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
      <TabsPrimitive.List aria-label={ariaLabel} className={cn("flex items-stretch gap-6", className)}>
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            onClick={() => onValueChange(item.value)}
            className="relative h-view-tabs border-0 bg-transparent px-0 text-meta font-medium text-muted outline-none transition-colors hover:text-foreground-soft data-[state=active]:font-semibold data-[state=active]:text-info after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t after:bg-transparent data-[state=active]:after:bg-[#547ce4] focus-visible:ring-2 focus-visible:ring-info/20"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
