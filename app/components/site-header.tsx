"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <a className="brand" href="/" aria-label="what’s popular? home">
          <span aria-hidden="true" className="brand-mark">w?</span>
          <span>what’s popular?</span>
        </a>
        <nav aria-label="Main navigation">
          <a className={pathname === "/" ? "is-active" : undefined} href="/" aria-current={pathname === "/" ? "page" : undefined}>Home</a>
          <a className={pathname === "/explore" ? "is-active" : undefined} href="/explore" aria-current={pathname === "/explore" ? "page" : undefined}>Explore</a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
