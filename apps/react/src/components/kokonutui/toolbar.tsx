/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

/**
 * @author: @dorianbaffier
 * @description: Toolbar
 * @version: 1.0.0
 * @date: 2025-06-26
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 */

import BellOffIcon from "@/components/ui/bell-off-icon";
import LayersIcon from "@/components/ui/layers-icon";
import LockIcon from "@/components/ui/lock-icon";
import MousePointer2Icon from "@/components/ui/mouse-pointer-2-icon";
import PaintIcon from "@/components/ui/paint-icon";
import SlidersHorizontalIcon from "@/components/ui/sliders-horizontal-icon";
import UserIcon from "@/components/ui/user-icon";
import { PencilSimple, ShareNetwork } from "@phosphor-icons/react";
import { AnimatePresence, motion, type Variants, type Transition } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

// Inline SVG icons for toolbar items with no itshover/phosphor equivalent
const MoveIcon: IconComponent = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" /><polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" />
  </svg>
);
const ShapesIcon: IconComponent = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" /><rect x="3" y="14" width="7" height="7" rx="1" /><circle cx="17.5" cy="17.5" r="3.5" />
  </svg>
);
const FrameIcon: IconComponent = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <line x1="22" y1="6" x2="2" y2="6" /><line x1="22" y1="18" x2="2" y2="18" /><line x1="6" y1="2" x2="6" y2="22" /><line x1="18" y1="2" x2="18" y2="22" />
  </svg>
);
const FileDownIcon: IconComponent = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><polyline points="14 2 14 8 20 8" /><polyline points="12 18 15 15 12 12 9 15 12 18" /><line x1="12" y1="12" x2="12" y2="18" />
  </svg>
);

interface ToolbarItem {
  id: string;
  title: string;
  icon: IconComponent;
  type?: never;
}

interface ToolbarProps {
  className?: string;
  activeColor?: string;
  onSearch?: (value: string) => void;
}

const buttonVariants = {
  initial: {
    gap: 0,
    paddingLeft: ".5rem",
    paddingRight: ".5rem",
  },
  animate: (isSelected: boolean) => ({
    gap: isSelected ? ".5rem" : 0,
    paddingLeft: isSelected ? "1rem" : ".5rem",
    paddingRight: isSelected ? "1rem" : ".5rem",
  }),
};

const spanVariants = {
  initial: { width: 0, opacity: 0 },
  animate: { width: "auto", opacity: 1 },
  exit: { width: 0, opacity: 0 },
};

const notificationVariants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: -10 },
  exit: { opacity: 0, y: -20 },
};

const lineVariants = {
  initial: { scaleX: 0, x: "-50%" },
  animate: {
    scaleX: 1,
    x: "0%",
    transition: { duration: 0.2, ease: "easeOut" },
  },
  exit: {
    scaleX: 0,
    x: "50%",
    transition: { duration: 0.2, ease: "easeIn" },
  },
};

const transition = { type: "spring", bounce: 0, duration: 0.4 };

export function Toolbar({
  className,
  activeColor: _activeColor = "text-primary",
  onSearch: _onSearch,
}: ToolbarProps) {
  const [selected, setSelected] = React.useState<string | null>("select");
  const [isToggled, setIsToggled] = React.useState(false);
  const [activeNotification, setActiveNotification] = React.useState<
    string | null
  >(null);
  const outsideClickRef = React.useRef(null);

  const toolbarItems: ToolbarItem[] = [
    { id: "select", title: "Select", icon: MousePointer2Icon },
    { id: "move", title: "Move", icon: MoveIcon },
    { id: "shapes", title: "Shapes", icon: ShapesIcon },
    { id: "layers", title: "Layers", icon: LayersIcon },
    { id: "frame", title: "Frame", icon: FrameIcon },
    { id: "properties", title: "Properties", icon: SlidersHorizontalIcon },
    { id: "export", title: "Export", icon: FileDownIcon },
    { id: "share", title: "Share", icon: ShareNetwork },
    { id: "notifications", title: "Notifications", icon: BellOffIcon },
    { id: "profile", title: "Profile", icon: UserIcon },
    { id: "appearance", title: "Appearance", icon: PaintIcon },
  ];

  const handleItemClick = (itemId: string) => {
    setSelected(selected === itemId ? null : itemId);
    setActiveNotification(itemId);
    setTimeout(() => setActiveNotification(null), 1500);
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "relative flex items-center gap-3 p-2",
          "bg-background",
          "rounded-xl border",
          "transition-all duration-200",
          className
        )}
        ref={outsideClickRef}
      >
        <AnimatePresence>
          {activeNotification && (
            <motion.div
              animate="animate"
              className="-top-8 -translate-x-1/2 absolute left-1/2 z-50 transform"
              exit="exit"
              initial="initial"
              transition={{ duration: 0.3 }}
              variants={notificationVariants as Variants}
            >
              <div className="rounded-full bg-primary px-3 py-1 text-primary-foreground text-xs">
                {
                  toolbarItems.find((item) => item.id === activeNotification)
                    ?.title
                }{" "}
                clicked!
              </div>
              <motion.div
                animate="animate"
                className="-bottom-1 absolute left-1/2 h-[2px] w-full origin-left bg-primary"
                exit="exit"
                initial="initial"
                variants={lineVariants as Variants}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-2">
          {toolbarItems.map((item) => (
            <motion.button
              animate="animate"
              className={cn(
                "relative flex items-center rounded-none px-3 py-2",
                "font-medium text-sm transition-colors duration-300",
                selected === item.id
                  ? "rounded-lg bg-[#1F9CFE] text-white"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              custom={selected === item.id}
              initial={false}
              key={item.id}
              onClick={() => handleItemClick(item.id)}
              transition={transition as Transition}
              variants={buttonVariants as Variants}
            >
              <item.icon
                className={cn(selected === item.id && "text-white")}
                size={16}
              />
              <AnimatePresence initial={false}>
                {selected === item.id && (
                  <motion.span
                    animate="animate"
                    className="overflow-hidden"
                    exit="exit"
                    initial="initial"
                    transition={transition as Transition}
                    variants={spanVariants as Variants}
                  >
                    {item.title}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          ))}

          <motion.button
            className={cn(
              "flex items-center gap-2 px-4 py-2",
              "rounded-xl border shadow-sm transition-all duration-200",
              "hover:shadow-md active:border-primary/50",
              isToggled
                ? [
                  "bg-[#1F9CFE] text-white",
                  "border-[#1F9CFE]/30",
                  "hover:bg-[#1F9CFE]/90",
                  "hover:border-[#1F9CFE]/40",
                ]
                : [
                  "bg-background text-muted-foreground",
                  "border-border/30",
                  "hover:bg-muted",
                  "hover:text-foreground",
                  "hover:border-border/40",
                ]
            )}
            onClick={() => setIsToggled(!isToggled)}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            {isToggled ? (
              <PencilSimple size={14} />
            ) : (
              <LockIcon size={14} />
            )}
            <span className="font-medium text-sm">
              {isToggled ? "On" : "Off"}
            </span>
          </motion.button>
        </div>
      </div>
    </div>
  );
}

export default Toolbar;
