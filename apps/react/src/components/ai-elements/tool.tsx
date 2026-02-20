"use client";

import type { DynamicToolUIPart, ToolUIPart } from "./types";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { isValidElement, useRef, useEffect } from "react";

import { CodeBlock } from "./code-block";
import { ShellOutput } from "./shell-output";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3 text-muted-foreground" />,
  "approval-responded": <CheckCircleIcon className="size-3 text-muted-foreground" />,
  "input-available": <ClockIcon className="size-3 animate-pulse text-muted-foreground" />,
  "input-streaming": <CircleIcon className="size-3 text-muted-foreground" />,
  "output-available": <CheckCircleIcon className="size-3 text-muted-foreground" />,
  "output-denied": <XCircleIcon className="size-3 text-muted-foreground" />,
  "output-error": <XCircleIcon className="size-3 text-muted-foreground" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1 rounded-full px-2 py-0.5 text-xs font-normal bg-transparent text-muted-foreground border-0 transition-colors [&>svg]:transition-colors hover:text-foreground hover:[&>svg]:text-foreground" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <CaretDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const handleAnimationStart = () => {
      element.dataset.animating = "true";
    };

    const handleAnimationEnd = () => {
      element.dataset.animating = "false";
    };

    element.addEventListener("animationstart", handleAnimationStart);
    element.addEventListener("animationend", handleAnimationEnd);

    return () => {
      element.removeEventListener("animationstart", handleAnimationStart);
      element.removeEventListener("animationend", handleAnimationEnd);
    };
  }, []);

  return (
    <CollapsibleContent
      ref={contentRef}
      className={cn(
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    />
  );
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

// ── Unified ToolCard ─────────────────────────────────────────────────────────

export interface ToolCardProps {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  className?: string;
}

export const ToolCard = ({ name, args, result, isError, className }: ToolCardProps) => {
  const state: ToolPart["state"] = result != null
    ? (isError ? "output-error" : "output-available")
    : "input-available";

  return (
    <Collapsible className={cn("group/tool not-prose mb-0", className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <WrenchIcon className="size-4" />
        <span className="font-mono text-[11px] tracking-wide">{name}</span>
        {getStatusBadge(state)}
        <CaretDownIcon className="size-4 ml-auto transition-transform group-data-[state=open]/tool:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 pl-6 space-y-3 data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in">
        {name === "shell" && result != null ? (
          <ShellOutput
            command={(args as { command?: string }).command ?? ""}
            result={result}
          />
        ) : (
          <>
            {Object.keys(args).length > 0 && <ToolInput input={args} />}
            {result != null && (
              <ToolOutput output={result} errorText={isError ? result : undefined} />
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};

// ── ToolOutput ───────────────────────────────────────────────────────────────

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
