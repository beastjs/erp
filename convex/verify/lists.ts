/*
 * The two lists structural verification judges an address by. THEY ARE LOGIC, not configuration: a domain added to
 * DISPOSABLE_DOMAINS changes what `verifyEmailStructure` returns for an input it has already answered. So the verify
 * stage's input hash includes `STRUCTURAL_LOGIC` (verify/structural.ts), which is DERIVED from these lists' contents
 * and `STRUCTURAL_RULES_REVISION`: editing a list changes the hash and forces a re-run, with nobody having to
 * remember to bump a number. A change to the matching CODE (not the lists) bumps the revision by hand.
 *
 * Entries are lowercase. Domains are registrable domains: a subdomain of a listed domain matches too.
 */

/** Throwaway-inbox providers. A deliberately short, well-known core; a provider-backed verifier is a later plan. */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  "10minutemail.com",
  "33mail.net",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.org",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.net",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "yopmail.net",
];

/** Mailbox names that reach a team or a function, not a person. Matched on the local part before any `+tag`. */
export const ROLE_LOCAL_PARTS: readonly string[] = [
  "abuse",
  "accounts",
  "admin",
  "billing",
  "careers",
  "contact",
  "customerservice",
  "donotreply",
  "enquiries",
  "finance",
  "help",
  "hello",
  "hr",
  "info",
  "inquiries",
  "jobs",
  "legal",
  "mail",
  "marketing",
  "media",
  "no-reply",
  "noreply",
  "office",
  "orders",
  "postmaster",
  "press",
  "privacy",
  "sales",
  "security",
  "service",
  "support",
  "team",
  "webmaster",
];
