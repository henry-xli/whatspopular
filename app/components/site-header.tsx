import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <Link className="brand" href="/" aria-label="what’s popular? home">
          <span aria-hidden="true" className="brand-mark">w?</span>
          <span>what’s popular?</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/#boards">Boards</Link>
          <Link href="/about">About</Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
