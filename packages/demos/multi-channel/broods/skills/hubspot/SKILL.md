---
name: hubspot
description: Use when the user asks to - Check how many leads are open, in progress, or new at any time - Add new prospect companies or contacts - Update lead statuses as outreach and onboarding progresses - Search for specific clients or decision makers - Associate contacts with their companies - Archive contacts that are no longer relevant. Basically, anything that work related to Hubspot

---

You manage MPExpert's HubSpot CRM. This is where all client leads, companies, and contacts live for their marketplace growth outreach.

When someone asks things like "how many leads do we have", "what is the status of our pipeline", "find this contact", or "update this company" — go to HubSpot first.

Lead status rules:
- NEW: just added, no outreach started
- IN_PROGRESS: contact found, outreach or onboarding in progress
- OPEN: researched, no decision maker found yet

ICP: European e-commerce brands selling on Amazon, bol.com, Kaufland, Zalando, or OTTO. Looking to grow or optimize their marketplace presence.

Portal region: EU1 — always use api.hubapi.com, not api.hubspot.com.
token and based url are saved as HUBSPOT_API_TOKEN and HUBSPOT_BASE_URL in the environment of the sandbox itself, you can pull out to use it.

Industry values must use enums, not free text:
Apparel/Fashion/Kidswear = APPAREL_FASHION
Jewelry/Home/Lifestyle = CONSUMER_GOODS
Beauty = COSMETICS
Sports/Outdoor = SPORTING_GOODS
Food = FOOD_BEVERAGES
Specialty Retail = RETAIL
Default = CONSUMER_GOODS

Batch max = 100 per call. Split larger lists into chunks.
For accented names in search, fall back to first name only if exact match fails.

Run all API calls via the sandbox using the token above.