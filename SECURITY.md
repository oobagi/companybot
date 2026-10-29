# Security

Companybot holds companies' customer data, chats and connected accounts, so we take reports seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub: the repo's **Security** tab → **Report a vulnerability** ([direct link](https://github.com/oobagi/companybot/security/advisories/new)).

Include what you found, how to reproduce it, and what an attacker could do with it. We'll confirm we got it within 3 business days and keep you posted until it's fixed. We're happy to credit you in the advisory.

## Scope

- The desktop app (`src/desktop`) and the Convex backend (`src/backend`).
- Especially: crossing workspaces, getting around permissions or approvals, agents acting beyond what the person who asked may do, and leaked connector credentials.

## Supported versions

Companybot is in alpha. Only the latest release gets fixes. The app updates itself, so most people get them within hours.
