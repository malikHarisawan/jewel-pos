# Licensing & 7-day trial

Offline, per-machine licensing for Jewel POS. No server, no internet required.

## Goals & threat model

- A link/installer you send runs **free for 7 days**, then a **3-day grace** (with warnings), then **hard-locks** behind an activation wall. Data is never touched — activating unlocks it instantly.
- To continue past the trial, the shop gives you their **Machine ID** (shown on the lock screen); you generate a **license code** bound to that machine and send it back. They paste it in — unlocked forever (or until the code's own expiry, if you set one).
- **Realistic scope:** this stops casual copying, link-sharing, and "just install it on ten counters." It is *not* unbreakable — a determined, technical user on their own PC can tamper with the local DB or system clock. That is inherent to offline software with no server. The signed code means they **cannot forge a valid license for a new machine** without the private key, which is the property that actually matters for selling copies.

## Cryptography (Node built-in `crypto`, Ed25519 — no dependencies)

- You hold an **Ed25519 private key** (kept secret, never shipped). The app embeds only the **public key**.
- A license code is: `base64url( payloadJson ) + "." + base64url( signature )`, where `payload = { machineId, exp?: ISO date | null, iss: ISO date }` and `signature = Ed25519_sign(privateKey, payloadJson)`.
- The app verifies the signature with the embedded public key, then checks `payload.machineId === thisMachineId` and, if `exp` is set, that it's in the future. Verification is fully offline.
- Key generation & signing live in `scripts/license-keygen.mjs` (make keys once) and `scripts/license-sign.mjs` (mint a code per machine). The private key file stays on your machine only.

## Machine ID

A stable, opaque per-machine fingerprint:
1. Windows: read `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (stable across reboots/reinstalls of the app; changes only on OS reinstall).
2. Fallback (non-Windows / unreadable): hostname + platform + cpu model.
3. Hash the raw value with SHA-256 and take the first 16 bytes as hex → a 32-char ID like `9f3a...`. Shown to the user in short groups for easy dictation.

## Trial & clock-tamper handling

State lives in a single `license` table (one row):
- `trial_start` — set once, on first boot, from the system clock.
- `license_code` — the activated code (null during trial).
- `status` — derived, not stored: `TRIAL | GRACE | LICENSED | EXPIRED`.
- `high_water_mark` — the latest date the app has ever seen. On each boot, if `now < high_water_mark` by more than a small skew, the clock was rolled back → treat as `EXPIRED` (prevents "set the date back to extend the trial"). Otherwise advance the mark to `now`.

Timeline (defaults, configurable in code):
- **Days 0–7**: `TRIAL` — full app, a dismissable banner shows days left.
- **Days 7–10**: `GRACE` — full app, a persistent warning banner ("Trial ended, N days to activate").
- **Day 10+**: `EXPIRED` — hard lock. All screens replaced by the activation wall.
- A valid license code → `LICENSED` (banner gone). If the code has an `exp` and it passes → back to `EXPIRED`.

## Enforcement point

The license status is computed in the **main process** (same place as the DB and session — the renderer can't fake it) and exposed via `license.status`. The renderer's top-level gate:
- `EXPIRED` → render only the Activation screen (Machine ID + code box), nothing else.
- `TRIAL`/`GRACE` → render the app with a banner.
- `LICENSED` → render the app.

Because it's checked in main and the DB/clock checks run there, bypassing it requires editing the local machine — acceptable per the threat model.

## Your workflow to license a shop

```
# once: create your keypair (keep private key secret!)
node scripts/license-keygen.mjs        # writes license-private.pem + prints the public key

# per shop: they read you their Machine ID from the lock screen
node scripts/license-sign.mjs <machineId>              # perpetual code
node scripts/license-sign.mjs <machineId> 2027-01-01   # code that expires on a date
# → prints the license code; send it to the shop, they paste it in
```

The embedded public key is committed in `src/shared/license/publicKey.ts`. Replace its placeholder with the output of keygen before you ship — until you do, no code will verify (the app still runs the trial).
