---
name: screenshots
description: Use when your owner asks for screenshots, screen grabs, charts or graphs of web pages.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: screenshot, screenshots, screen shot, screen grab, screen capture, snapshot, chart, charts, graph, graphs, stock chart, picture of the page
  tools: browser_view
  source: Ensemble Node's screenshots skill.
---
- browser_view with the URL and focus naming what was asked (“the price chart”, “the results table”): one call per screenshot.
- Count the screenshots against what was asked: “4 screenshots” is 4 calls. Each one comes with your reply by itself.
- Stock charts: Google Finance, https://www.google.com/finance/quote/<TICKER>:<EXCHANGE>?window=5D (windows 1D, 5D, 1M, 6M, YTD, 1Y, 5Y, MAX), for example AAPL:NASDAQ, MSFT:NASDAQ, AMZN:NASDAQ, NVDA:NASDAQ, GOOGL:NASDAQ, TSLA:NASDAQ.
- If the focus was not found (focusFound false), try fullPage or another site.
- The whole page only when your owner asks for it (fullPage).
