export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div>
          <a className="brand footer-brand" href="/">
            <span aria-hidden="true" className="brand-mark">
              <img src="/icon.png" alt="" width="34" height="34" />
            </span>
            <span>what’s popular?</span>
          </a>
          <p>Keep the context. Lose the feed.</p>
        </div>
        <div>
          <strong>Explore</strong>
          <a href="/">Home</a>
          <a href="/explore">Today’s boards</a>
          <a href="https://buymeacoffee.com/0wtynrfutb" target="_blank" rel="noopener noreferrer">Support the site</a>
        </div>
        <div>
          <strong>Principles</strong>
          <span>Pre-built weekly signals</span>
          <span>Local feed assembly</span>
          <span>One snapshot for everyone</span>
        </div>
      </div>
      <div className="wrap footer-bottom">
        <span>© {new Date().getUTCFullYear()} whatspopular.com</span>
        <span>Built for the pleasantly offline.</span>
      </div>
    </footer>
  );
}
