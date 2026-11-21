---
name: sign-in
description: Use when a page needs your owner's account, a password, a code or a human check (a captcha, “Robot or human?”), or when your owner says they signed in.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: log in, login, logged in, sign in, signed in, sign-in, account, password, passcode, 2fa, two factor, otp, verification code, captcha, robot or human, human check, verify you are human, am human, not a robot
  tools: browser_login_needed
  source: Ensemble Node's sign-in skill.
---
- A page that needs your owner's account: browser_login_needed. A captcha, “Robot or human?” or a block page: browser_login_needed for a human check.
- Your owner gets a card with “Sign in here”, which shows them the page live on their phone or computer: Google sign-in, 2FA codes and approvals, and making an account all work there. You go on by yourself when it is done.
- Never ask for passwords or codes in chat, and never type them.
- When your owner says they did it: browser_login_check with the tab when you have it, else try the page again.
- Never Ensemble itself (app.ensemblework.com, a board or task link): you are in it already, through your Ensemble tools.
