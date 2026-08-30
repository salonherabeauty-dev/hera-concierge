# Preview AI connectivity repair

This branch repairs only the private Hera Concierge Preview runtime:

- retain OpenAI GPT-5.6 Sol with maximum reasoning and OpenAI-only routing;
- remove the unverified forced priority service tier;
- allow one bounded SDK transport retry for retryable Gateway failures;
- expose privacy-safe Gateway error metadata without prompts, client text or credentials;
- make retry availability truthful after the single human retry is consumed;
- stop the Reset v3 browser from issuing an invalid GET request to the POST-only bootstrap route;
- provide an authenticated synthetic non-client connectivity proof;
- retain Tanglin-only context, human-only delivery, and zero automatic WhatsApp sends or Timely writes.

No `main` or Production change is permitted by this branch.
