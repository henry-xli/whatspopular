export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div>
          <a className="brand footer-brand" href="/">
            <span aria-hidden="true" className="brand-mark">w?</span>
            <span>what’s popular?</span>
          </a>
          <p>Keep the context. Lose the feed.</p>
        </div>
        <div>
          <strong>Explore</strong>
          <a href="/explore">Today’s boards</a>
          <a href="/about">How it works</a>
          <a href="https://buymeacoffee.com/0wtynrfutb" target="_blank" rel="noopener noreferrer">Support the site</a>
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
