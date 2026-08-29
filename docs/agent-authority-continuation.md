# Durable Agent authority across browser sessions

AgentWeb authenticates a browser with a revocable cookie-backed session. That
login session is deliberately short-lived and remains the key for HTTP stream
admission and per-session rate limits. It is not the ownership key for durable
AgInTi resources.

The cloud index now gives each account one opaque 64-hex Agent authority scope.
New threads, runs, and artifacts use that durable scope. A fresh login, another
device, Safari, or an installed PWA can therefore address the same Agent state
after it authenticates as the same account. The scope is never returned to the
browser and is never accepted as authentication.

## Upgrade adoption

Schema version 2 copies the bounded set of existing browser-session digests into
`legacy_session` discovery scopes and creates a pending random default. The
first authenticated Agent request after the upgrade may atomically promote its
copied pre-upgrade scope. This preserves the live thread visible in the browser
used for guarded acceptance. The first committed promotion wins; later logins
cannot rebind the account.

AgentWeb probes only account-owned legacy scopes with read-only RPCs. A found
thread, run, or artifact is recorded as an opaque resource-to-scope binding
before later mutations are admitted. Mutations are sent once to that exact
scope with their original idempotency key. Empty legacy scopes are retired
after a complete successful probe. Discovery is bounded to the browser-session
cap plus one default and to 200 threads per legacy scope.

Session rows that were already deleted before the upgrade cannot be reconstructed
from AgentWeb state. Their AgInTi resources require an explicit operator-owned
recovery mapping; AgentWeb never scans another account or guesses a scope.

## Rollout and rollback

The migration is additive and transactional: it creates two authority tables
and does not rewrite or drop any version 1 table. A guarded deployment must:

1. close new-work admission and drain active mutations;
2. stop the sole AgentWeb writer;
3. create and verify a private SQLite backup;
4. start the candidate and let migration version 2 finish;
5. issue the first Agent request from the authenticated browser whose live
   pre-upgrade thread must be retained; and
6. verify same-thread follow-up from a second login before reopening admission.

Rollback stops the candidate and restores the verified version 1 backup before
starting the previous binary. The previous binary intentionally rejects a
newer schema instead of trying to interpret it.

Revoking or expiring a login prevents all Agent RPC and artifact access before
the authority resolver runs. The durable scope does not weaken that boundary;
it only selects account-owned state after authentication succeeds.
