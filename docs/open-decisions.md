# Open decisions — required before staging

| Decision                                           | Current development behaviour                                                     | Required confirmation/work                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Customer/partner fee VAT and inclusive advertising | Explicit rate; zero/unconfirmed test fixtures; draft-only billing                 | Accountant-approved tax categories, rates, invoice wording and net/gross calculation   |
| Connect liability and processing fees              | Provisional Standard direct charges; controller checks fail closed                | Current Stripe documentation, contract/country review and real test-account allocation |
| Refund of customer service fee                     | Explicit boolean per refund; proportional Stripe application-fee refund requested | Product/legal/accountant decision; exact fee allocation and partial-refund policy      |
| Disputes/negative balances                         | Not implemented                                                                   | Liability confirmation, event handling, accounting and recovery                        |
| Invoice collection                                 | Disabled; no auto-charge endpoint                                                 | Explicit approved method, mandate and reconciliation                                   |
| Scheduled authorisation windows/capacity           | Scheduled checkout explicitly rejected                                            | Provider limits, partner windows/capacity, just-in-time authorisation and recovery     |
| Loyalty funding/liability                          | Not implemented or enabled                                                        | Funding source, expiry, accounting, abuse controls                                     |
| Address lookup providers                           | Manual addresses and outward postcode validation only                             | Apple/Google/OSM credentials, terms, caching/limits and attribution                    |
| Partner business calendars                         | Not implemented                                                                   | Hours, closures and timezone policy before real operations                             |
| Administrative MFA                                 | Private development bootstrap secret                                              | Per-user enrolment, recovery, secret encryption and enrolment audit                    |
| Native payments/push                               | Not implemented/tested                                                            | Native secure sessions, payment SDK/provider and push permissions/device tests         |
| Security dependencies                              | Two unpatched high Expo development advisories                                    | Compatible patched toolchain or upstream fixes; no audit suppression                   |

Additional missing capabilities are enumerated in requirements-coverage.md. These are explicit unfinished work, not implied implemented features.
