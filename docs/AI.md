# Advisory AI — OpenRouter and local model

The assistant proposes **new setup candidates**, never trading actions.
It has no signing keys, wallet credentials, order tools, execution-owner controls
or access to clearing unknown orders/halted series. Allowed recommendation fields
are indicator/entry parameters only; sizing and money/risk limits remain pinned.

## Configuration and consent

AI is disabled until explicitly configured and enabled. OpenRouter uses its
fixed HTTPS API; enter the separate API key in the password field. Stored keys
use the existing secure secret store and are never returned to the renderer,
included in model context or exported with setups.

Select a model, request/token/timeout limits and daily budget. Before a paid
request the application reserves its maximum permitted charge. An unknown or
lost response does not reset that reservation or blindly retry the request.
Provider-reported usage may reconcile charges; unknown prices fail closed.
Use an independently restricted OpenRouter key/account budget as an additional
provider-side control. A local ledger cannot guarantee the behavior of a billing
provider outside this application's requests.

Only an allowlisted setup definition is sent to the provider, not account state,
private journals or credentials. Cloud model requests disclose those setup
parameters to OpenRouter/providers; enabling them is a deliberate user choice.

## Local model

Local mode targets an already-installed Ollama service on loopback only.
It is desktop-only in this integration, not a server failover path. Remote
addresses, embedded credentials, redirects and arbitrary executable paths are
not accepted. If Ollama is unavailable, the assistant reports that fact and does
not affect trading. Closing the desktop never sends server Stop.

The optional curated model pull asks the local daemon to download a model only
after explicit confirmation and memory/disk checks. License, size and daemon
digest metadata are checked/recorded. The model runner is a separate dependency;
this does not install arbitrary binaries or disable the Electron sandbox.
A daemon-reported SHA-256 digest is **not** independent verification of every
downloaded model blob. The curated model is accepted only with valid size metadata
up to 2 GiB and a confirmed Apache-2.0 license. The pre-pull free-space threshold
is an estimate, not a hard quota imposed on the separate Ollama daemon; an upstream
tag change can still consume space before post-download validation refuses use.
Model hardware requirements are estimates, not performance guarantees.
No production model download/inference is claimed by mock tests.

## Recommendation lifecycle

Responses must be bounded structured JSON matching the allowed schema and the
shared settings validator. Unknown fields, risk-limit changes, invalid parameters,
timeouts and malformed responses never update trading settings. Valid proposals
are journaled with their source setup identity/model and explanation.

Creating a candidate requires an explicit approval; it creates a **new** setup
identity and does not apply it, change mode/dry run or start trading. Validate it
in the research lab first. Historical tests retain the Binance/0.50 approximate
label. Testing on the same data used to choose a proposal is not proof of predictive
quality; use held-out chronological data and compare risk/sample size to the base.
The built-in candidate check uses the last 30% of a chronological dataset and
compares the original version on the same held-out window. No performance history
or candle data is sent in the model prompt. This is still an approximate replay,
not evidence that a model is profitable outside this sample.
No claim that AI increases profit is made.

References: [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[usage accounting](https://openrouter.ai/docs/guides/guides/usage-accounting),
[Ollama pull API](https://docs.ollama.com/api/pull),
[local structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
