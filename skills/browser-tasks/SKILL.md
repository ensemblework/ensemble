---
name: browser-tasks
description: Use when you work on a website in the browser: opening pages, searching a site, clicking, filling forms, filtering results or reading a site that needs more than one page.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: browser, website, site, web page, webpage, open the page, click, button, form, fill, search box, filter, sort, navigate, go to, book, booking, tickets, checkout, add to cart, dropdown, url, link
  tools: browser_open
  source: Ensemble. The operating rules are the Node lab's browser skill, in Ensemble's own words.
---
One action at a time, and look after each one.

- Go straight to the most specific address you know (a search results page, a product page) rather than clicking down from the home page.
- Read the page (browser_snapshot) before you click. After every click, typing or navigation, read it again: the page may have changed, and old element refs go stale.
- Use the site's own search, filters and sorting before you scroll through results. For an autocomplete field: type, wait for the list, then pick from it.
- Close cookie banners and pop-ups that cover the page. When a click opens a new tab (a payment window), that tab is where you are now.
- Wait for the text you expect to appear, not for a fixed time.
- A 403, a block page or a human check: do not retry the same thing. A sign-in or a check needs your owner (browser_login_needed).
- Three steps with no progress: change the approach (another page, the site's own search, web_task, or ask).
- Never buy, pay, book, send, delete or post unless your owner's words ask for exactly that; stop before the final button and ask on a card.
- Before you answer, check the result against the request and give the page's address.
