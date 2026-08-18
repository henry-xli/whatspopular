import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <a className="brand" href="/" aria-label="what’s popular? home">
          <span aria-hidden="true" className="brand-mark">w?</span>
          <span>what’s popular?</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="/explore">Explore</a>
          <a href="/about">About</a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
