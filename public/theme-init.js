try {
  const saved = window.localStorage.getItem("whatspopular-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }
} catch {}
