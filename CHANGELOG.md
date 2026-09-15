# Changelog

All notable versions of **Vespera (VSP)**. Tag `vX.Y.Z` to cut a build.

## 0.1.1 — 2026-09-15

- Paper: Stop does not kill an open virtual bet; it settles on the next close.
- Paper: Start does not fire on the already-closed last candle.
- Paper: missed 15m bars are processed in order; poll ticks no longer overlap.
- Paper: 6 losses halt until Confirm lot + Start. Skip does not change the series.
- Paper: restart restores an open paper bet from the journal.

## 0.1.0 — 2026-09-15

- First desktop shell (Windows + macOS).
- Glass UI from the frosted-panel references (~70% TradingView viewport).
- **Paper** mode: MA200 / MA20 rules, martingale ×2 to 6, halt until Start + lot confirm.
- Auto is visible but cannot send live orders (Preddy has no public trading API).
- Settings: API key + OK ping, theme, EN/RU.
- App icon (evening star) and installer shortcuts.
