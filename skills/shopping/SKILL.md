---
name: shopping
description: Use when your owner asks about prices, costs, deals or where to buy something, or wants a product compared across stores.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: price, prices, pricing, priced, cost, costs, how much, going rate, cheap, cheapest, cheaper, deal, deals, discount, discounts, on sale, for sale, buy, buying, purchase, shop, shopping, in stock, out of stock, msrp, retailer, retailers, store, stores, amazon, walmart, target, best buy, costco
  tools: browser_shop
  source: Ensemble Node's shopping skill.
---
- One call: browser_shop with the product (query), the stores your owner named (else leave stores out: Amazon, Walmart, Target, Best Buy, Costco) and the location (a US state is enough; the tool picks a ZIP there).
- Reply with a Markdown table: Store | Product | Price | Availability/delivery | Link. Then one line on the best deal.
- Say which stores blocked automated browsing or showed a human check. Offer to open the check for your owner only if they want that store.
- A store browser_shop could not read, when you have hub_web_search and browser_extract: one hub_web_search for the product at that store, then browser_extract on its product page (url), whose structured data carries the price. Never retry a page that blocked you.
- Never invent a price: write “not shown” when a store gave none.
- The stores' screenshots come with your reply by themselves.
- Never buy anything unless your owner asks for exactly that.
