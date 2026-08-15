import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div>
          <Link className="brand footer-brand" href="/">
            <span aria-hidden="true" className="brand-mark">w?</span>
            <span>what’s popular?</span>
          </Link>
          <p>Keep the context. Lose the feed.</p>
        </div>
        <div>
          <strong>Explore</strong>
          <Link href="/#boards">Today’s boards</Link>
          <Link href="/about">How it works</Link>
        </div>
        <div>
          <strong>Principles</strong>
          <span>No accounts</span>
          <span>No personalization</span>
          <span>One update daily</span>
        </div>
      </div>
      <div className="wrap footer-bottom">
        <span>© {new Date().getUTCFullYear()} whatspopular.com</span>
        <span>Built for the pleasantly offline.</span>
      </div>
    </footer>
  );
}
