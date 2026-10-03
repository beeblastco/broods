---
title: Privacy Policy
description: What Broods stores, where, for how long, and who else touches it.
---

# Privacy Policy

Last updated: 3 October 2026

This policy covers the hosted Broods service operated by BeeBlast B.V., Amsterdam, the Netherlands (KvK 98814737), which is the controller of the data described here. Reach us at [business@beeblast.co](mailto:business@beeblast.co). It is written to be read, not skimmed: every section says what we store and why.

## What we store

| Data                                                                          | Why                                             | Where it comes from                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| Your name, email and sign-in identity                                         | To run your account and contact you             | WorkOS, when you sign in                                           |
| Organization members and roles                                                | Access control                                  | You                                                                |
| Agent configuration, environment variables, channel tokens, provider API keys | To run your agents                              | You. Secrets are encrypted with AES-256-GCM before they are stored |
| Conversations, messages and attachments your agents process                   | So agents keep context and you can inspect runs | Your users, through the API and connected channels                 |
| Workspace files, skills, hook and MCP bundles                                 | Your agents' code and files                     | You                                                                |
| Traces, logs and usage records                                                | Debugging, allowances and billing               | Generated as agents run                                            |
| Plan and payment status                                                       | Billing                                         | Stripe. We never see your card number                              |

We do not sell data and we do not use your conversations to train models.

## Where it lives

- Configuration, conversations and usage records live in our database on servers hosted by Hetzner in the European Union.
- Files, bundles and attachments live in private AWS S3 buckets in `eu-west-1` (Ireland). Hosted MCP servers and MicroVM sandboxes run on AWS Lambda in the same region.
- Traces and logs stay on our own observability stack. They carry your tenant id so only your organization can read them.

## Who else touches it

| Service                                             | Role                                        | What they get                                                                      |
| --------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| WorkOS                                              | Sign-in and organizations                   | Email, name, sign-in identity                                                      |
| Stripe                                              | Payments                                    | Email and billing details you enter on Stripe's pages                              |
| AWS                                                 | File storage, hosted MCP, MicroVM sandboxes | Files, bundles and whatever your code sends                                        |
| Hetzner                                             | Hosting for the core, gateway and database  | Everything in the first table, encrypted at rest                                   |
| Your model providers                                | Answering your agents                       | The conversation context, sent with your own API key under your contract with them |
| Channels you connect                                | Delivering messages                         | The messages your agents send and receive on that channel                          |
| Sandbox providers you choose (E2B, Daytona, Vercel) | Running commands outside AWS                | The workspace files and environment variables you declare for that sandbox         |

Model providers, channels and third-party sandboxes only receive data when you connect them.

## How long we keep it

- Everything stays until you delete it. Deleting a project removes everything under it on every stage. Deleting an organization removes all of its data. Neither can be undone.
- Nightly database backups are kept for 30 days and then expire. Deleted data can still be in a backup until then.
- Usage records needed for invoices are kept for as long as tax law requires.

## Your rights

You can see and change your data in the dashboard, export it through the API, and delete it yourself. For anything the dashboard does not cover, including a full export or a correction, email [business@beeblast.co](mailto:business@beeblast.co) or use the [Support](/support) page and we answer within 30 days. If you are in the EU or UK you can also complain to your data protection authority.

## Security

Secrets are encrypted at rest, API responses never return them, and uploaded code runs outside the core with the least access we can give it. The [security guide](/guides/security) has the details. Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/beeblastco/broods/security).

## Cookies

The dashboard sets only the cookies it needs to keep you signed in. There is no advertising or cross-site tracking.

## Changes

We post changes here and email organization owners about material ones at least 14 days in advance.
