# Ideas

Candidate userscripts, not yet built.

- **YouTube — sponsor segment skip**: SponsorBlock already does this well, probably not worth
  reinventing.
- **YouTube — force max quality / skip end-screen cards.**
- **X — hide clutter, per-item toggles**: one script, each item independently on/off via
  `GM_registerMenuCommand` + `GM_getValue`/`GM_setValue` (default: hidden). Items: "Live on X",
  "Today's News", "What's Happening" (right-sidebar widgets, matched by heading text — X has no
  stable class names), "Creator Studio", "Subscribe to Premium", "Grok" (left-nav items, matched
  by `href` fragment). Design sketch: heading-text match walks up the DOM to the widget's wrapper
  div and hides it; nav items matched by `a[href*=...]` walked up ~3 levels to the row wrapper.
  MutationObserver + a 1s interval sweep for X's virtualized re-renders. Toggling reloads the page
  to refresh both DOM state and menu labels.
- **X — force chronological timeline**, hide "For you" tab.
- **Universal — strip tracking params** (`utm_*`, `si`, `fbclid`, etc.) from links on any page.
- **Universal — auto-decline cookie banners** — self-hosted slimmed version of lists like
  "I don't care about cookies".
- **Amazon/shopping — hide sponsored listings.**
- **GitHub — auto-expand "Files changed" diffs, hide Copilot nudges.**
- **cf-x-archive UI — random single-kind buttons**: current "Random 5" button
  (`public/index.html`, `showRandom()`) always draws from bookmarks+likes combined. Idea: separate
  "Random bookmark" / "Random like" (and maybe per any kind) buttons, either via a `kind` query
  param on the existing `/api/random` endpoint or one button per tab that only randomizes within
  the active tab's kind.
