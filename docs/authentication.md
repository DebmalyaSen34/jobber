# Authentication and ownership

M3 task 2 adds application-owned authentication to the Render API and first-party session handling through the Vercel frontend. Passwords and session credentials never enter the public Next.js bundle.

## Browser and API flow

The browser calls relative `/api/v1/*` URLs. Next.js rewrites those requests to the Render origin using `API_PROXY_TARGET` (or the existing `NEXT_PUBLIC_API_BASE_URL` fallback). This keeps the browser request and response on the frontend origin, so the host-only session cookie remains first-party even though Render owns the API and MongoDB data.

Routes:

| Route | Behavior |
| --- | --- |
| `POST /api/v1/auth/register` | Validate credentials, create a user, persist a session, set the cookie |
| `POST /api/v1/auth/login` | Apply email/IP throttles, verify the password, persist a session, set the cookie |
| `GET /api/v1/auth/session` | Return the public user, expiry, and session-bound CSRF token, or an unauthenticated result |
| `POST /api/v1/auth/logout` | Require the session, trusted origin, and CSRF token; delete the persisted session |
| `GET /api/v1/account` | Demonstrate direct-API session enforcement for the current owner |

The `/dashboard` proxy check provides an early redirect when no cookie exists. It is only a navigation optimization: the API remains authoritative and rejects missing, forged, deleted, or expired sessions.

## Security properties

- Passwords must contain at least 12 characters and at most 72 UTF-8 bytes. `bcryptjs` hashes them with a configurable work factor; only the hash is stored.
- The browser receives a random 32-byte opaque session token. MongoDB stores only its SHA-256 lookup digest, the user reference, expiry, and CSRF token.
- Production uses the `__Host-jobber_session` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; development uses `jobber_session` without `Secure`.
- Session expiry is absolute and defaults to seven days. MongoDB has a TTL index for cleanup, while request handling enforces expiry immediately without waiting for TTL deletion.
- Login throttling is enforced atomically in MongoDB by separately HMAC-keyed normalized-email and client-IP windows. Successful login clears both counters. Invalid email and invalid password share one response.
- Registration/login require an exact trusted `Origin`. Authenticated mutations additionally require the session's `X-CSRF-Token`. CORS remains an exact allowlist with credentials enabled.
- `assertOwner` compares the authenticated user ID to a resource owner and returns the same 404 used for absent data. Every future kit, job, mutation, and practice lookup must query by owner or call this guard before returning state.

Email verification, password reset, account recovery, multi-factor authentication, and global session revocation are outside the MVP scope.

## Persistence

MongoDB collections and indexes created at startup:

- `users`: unique normalized email and bcrypt password hash.
- `sessions`: token digest, user ID, CSRF token, timestamps, and expiry; indexed by user and expiry.
- `auth_rate_limits`: bounded attempt timestamps with TTL cleanup. Keys are HMAC digests, not raw email/IP values.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SESSION_SECRET` | required | At least 32 characters; HMAC key for rate-limit identifiers |
| `SESSION_TTL_HOURS` | `168` | Absolute persisted-session lifetime |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost, allowed range 4–14 |
| `LOGIN_WINDOW_MINUTES` | `15` | Fixed throttling window |
| `LOGIN_EMAIL_LIMIT` | `5` | Attempts per normalized email in the window |
| `LOGIN_IP_LIMIT` | `20` | Attempts per client IP in the window |
| `WEB_ORIGINS` | `http://localhost:3000` | Exact browser-origin allowlist |
| `API_PROXY_TARGET` | none | Preferred server-only Next.js rewrite target |

Changing `SESSION_SECRET` does not invalidate existing sessions because session tokens are stored by SHA-256 digest; it does reset the unlinkability of newly generated throttle keys. Delete the `sessions` collection entries when intentional global logout is required.

## Verification

Network-free service tests cover normalized registration, bcrypt hashes, duplicate and malformed credentials, generic login failures, email throttling, successful-counter clearing, CSRF comparison, expiry deletion, logout invalidation, and cross-owner denial. The loopback HTTP test covers trusted-origin enforcement, cookie flags, session/account reads, rejected logout without CSRF, successful logout, and rejection of the deleted session.

Production authentication remains unverified until this change is deployed to both Render and Vercel and a fresh account completes register → dashboard → logout → rejected old session.
