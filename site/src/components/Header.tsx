"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { MenuToggleIcon } from "@/components/ui/menu-toggle-icon";
import { useScroll } from "@/components/ui/use-scroll";
import { cn } from "@/lib/utils";
import TripwireMark from "./TripwireMark";
import ButtonLink from "./ButtonLink";
import { DASHBOARD_URL } from "@/lib/links";

const NAV = [
  { label: "Home", href: "/" },
  { label: "Docs", href: "/docs" },
  { label: "Support", href: "/support" },
];

/** Matches the mobile panel's exit animation so it finishes before unmount. */
const EXIT_MS = 200;

export default function Header() {
  const [open, setOpen] = React.useState(false);
  const [panelMounted, setPanelMounted] = React.useState(false);
  const scrolled = useScroll(10);
  const pathname = usePathname();

  const toggle = () => {
    const next = !open;
    if (next) setPanelMounted(true);
    setOpen(next);
  };

  // The upstream component toggled `block`/`hidden`, which sets display:none the
  // instant it closes — so its exit animation never played. Keep the panel
  // mounted for the length of the animation instead.
  React.useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setPanelMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  React.useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 mx-auto w-full max-w-7xl border-b border-transparent md:rounded-md md:border md:transition-all md:ease-out",
        {
          "bg-background/95 supports-[backdrop-filter]:bg-background/50 border-border backdrop-blur-lg md:top-4 md:max-w-5xl md:shadow":
            scrolled && !open,
          "bg-background/90": open,
        },
      )}
    >
      <nav
        className={cn(
          "flex h-16 w-full items-center justify-between px-6 md:h-14 md:transition-all md:ease-out",
          { "md:px-4": scrolled },
        )}
      >
        <Link href="/" aria-label="Tripwire" className="flex items-center gap-2.5">
          <TripwireMark className="size-6 text-white" />
          <span className="text-white text-lg font-medium -tracking-[0.4px]">
            Tripwire
          </span>
        </Link>

        <div className="hidden items-center gap-2 md:flex">
          {NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "font-normal transition-colors",
                pathname === link.href ? "text-white" : "text-white/60",
              )}
            >
              {link.label}
            </Link>
          ))}
          <ButtonLink
            href={DASHBOARD_URL}
            text="View Dashboard"
            className={cn(
              buttonVariants(),
              "font-mono -tracking-[0.2px] rounded-none",
            )}
          />
        </div>

        <Button
          size="icon"
          variant="outline"
          onClick={toggle}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="md:hidden"
        >
          <MenuToggleIcon open={open} className="size-5" duration={300} />
        </Button>
      </nav>

      {panelMounted && (
        <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed top-16 right-0 bottom-0 left-0 z-50 flex flex-col overflow-hidden border-y border-border backdrop-blur-lg md:hidden">
          <div
            data-slot={open ? "open" : "closed"}
            className={cn(
              "data-[slot=open]:animate-in data-[slot=open]:zoom-in-95 data-[slot=closed]:animate-out data-[slot=closed]:zoom-out-95 ease-out",
              "flex h-full w-full flex-col justify-between gap-y-2 p-6",
            )}
          >
            <div className="grid gap-y-2">
              {NAV.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    buttonVariants({
                      variant: "ghost",
                      className: "justify-start",
                    }),
                    "font-normal",
                    pathname === link.href ? "text-white" : "text-white/60",
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <div className="flex flex-col gap-3">
              <ButtonLink
                href={DASHBOARD_URL}
                text="View Dashboard"
                onClick={() => setOpen(false)}
                className={cn(
                  buttonVariants(),
                  "w-full font-mono -tracking-[0.2px] rounded-none",
                )}
              />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
