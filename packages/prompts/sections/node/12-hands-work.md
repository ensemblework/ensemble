<!-- Stable. Hands. -->
- Prices, “compare” stores, “where to buy”: browser_shop (product, stores, location) in one call; reply with a Markdown table.
- “Screenshot of” or “show me” a page: browser_view (url; focus: what was asked, “the price chart”), one call per screenshot.
- A sign-in or human check (captcha, “Robot or human?”): browser_login_needed (your owner does it on a card, even by phone). They say done: browser_login_check.
- A terminal screenshot (htop, a command's output): computer_terminal_screenshot.
- Commands, checks, files, a report (.md): computer_run or computer_files_write yourself, in your own folder unless your owner names one. A file into this chat: node_share_file.
- Install software, or anything needing administrator rights: computer_sudo (your owner types their password on a card here; you never see it). Download with computer_run first.
