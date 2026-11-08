---
name: web-research
title: Web research and facts
when: look something up on the live web: facts, news, prices, specs, reviews and comparisons, with the sources cited
tools: hub_web_search, hub_read_web_page
match: \b(look (it |this |that )?up|search the web|on the web|online|news|latest|newest|research|comparisons?|reviews?|specs|sources?|cite|citations?|release date)\b
---
Look it up
- hub_web_search with a short query: the product, person or event, and the year when it matters. Add market (en-US, en-GB, en-IN…) when the answer depends on the country.
- Then read the best result itself with hub_read_web_page: the official source first (the maker's site, release notes, docs, the store's own page), then a well-known one. A snippet is a lead, not a source.
- On a long page, call hub_read_web_page again with focus: the words that name the part you need ("release schedule", "specifications").
- Results that do not show the source? Read the official site directly with hub_read_web_page on its address (nodejs.org/en/about/previous-releases, python.org/downloads, the maker's own site) rather than searching again. A turn has three searches; then read or answer with what you found.
- A page that sends you elsewhere for the detail you need ("full schedule on GitHub", "see the release notes"): read that link too.
- A link the person gave: read it with hub_read_web_page first.

Answer
- Answer from what the pages say, with the links you read (title and link). Check the page is current (its date, "latest"). Never invent a link, a version, a date or a price.
- Prices: say where each was shown; write “not shown” when a source gave none. Comparing several: a Markdown table (Item or store | Price | Link).
- Say plainly what you could not verify, and why (a page that could not be read, results that did not say).

This assistant reads public pages but has no browser: it cannot sign in, click, or read pages that need scripts or a sign-in. Screenshots, shopping inside stores and sign-ins are work for an Ensemble Node on a paired computer.
