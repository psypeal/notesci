# Handoff: notesci · sign in / sign up

## Overview
Invite-only authentication flow for **notesci**, a research notebook tool in early access. Covers the canonical sign-in, the invite-redeem path, the public waitlist for non-invitees, the password-reset trio, post-claim onboarding, in-app invite sharing, and three transactional emails.

## About the Design Files
The HTML files in this bundle are **design references** built as a React prototype loaded via Babel. They are NOT production code to copy directly. Recreate these designs in your codebase using its existing patterns (React + your component library, Next.js, etc.). If no environment exists yet, pick what fits the team — the layout primitives are plain CSS grid/flex.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, copy, and interactions are settled. Recreate pixel-faithfully.

## Updated · May 2026
Primary CTAs no longer use the trailing "→" arrow (e.g. "Sign in", "Claim my account", "Save and continue"). Buttons should render the label only. Navigational text links (e.g. "How invites work →", "Back to sign in") may still use arrows where appropriate.

## Direction
The chosen visual direction is **V1 "Editorial"** — a split layout with the form on the left and a paper-textured hero panel on the right. Calm, scholarly, modern. Two earlier directions (V2 lab-instrument, V3 knowledge-graph) were explored and rejected — they're not in this bundle.

## Screens
All desktop frames are **1440 × 900**, tablet **834 × 1112**, mobile **390 × 844**. Every page uses CSS `box-sizing: border-box` globally.

### Core auth (3 modes × 3 devices)
1. **Sign in** — email + password, with "Forgot?" link, plus 4 social/SSO buttons (Google, GitHub, ORCID, Institution).
2. **Claim invite (sign up)** — invite-code field (`NS-XXXX`, monospace, 0.15em letter-spacing, uppercased), then email + password. Shows "✓ invite valid" hint under the code field when valid.
3. **Waitlist** — email, field of research, freeform "what would you do with notesci" textarea.

### Adjacent (desktop + mobile)
4. **Invite-link landing** — when URL contains `?c=NS-XXXX`. Shows the code in a chip with VALID badge; a "Claim" CTA pre-fills the next screen.
5. **Forgot password** — email field, "Send reset link" CTA. Hero on right uses pull-quote treatment.
6. **Reset sent** — centered status frame, info icon, "Open mail app" / "Use a different email" buttons.
7. **Set new password** — new + confirm fields, 4-segment strength meter (3/4 = Strong is the default rendered state).
8. **Verify email** — centered status frame, "Resend verification" CTA.
9. **Already claimed (error)** — warn icon, "Go to sign in" / "Join waitlist instead".
10. **Expired invite (error)** — error icon, "Request a new invite" / "Join the waitlist".
11. **Post-claim onboarding** — single skippable step. Top-right global SKIP, plus per-field SKIP labels. Fields: name, affiliation, ORCID, field of research, topics. Two CTAs: "Save and continue" / "Skip everything for now".
12. **In-app · Invite friends** — each member is allocated **5 invite codes**. Left column: total-remaining headline + invite-link card with Copy + Share. Right column: table of 5 codes with statuses (`available`, `sent`, `claimed`).

### Loading + inline-error states
13. **Sign in · loading** — disabled inputs and disabled CTA with inline spinner ("Signing in…").
14. **Sign in · wrong password** — top-of-form red alert banner + red field highlight on the password field.
15. **Sign up · invalid code** — red field highlight + helper "That code isn't valid…"
16. **Sign up · email already in use** — red helper with inline "Sign in instead?" link.
17. **Invites · empty** — illustration of the envelope dot, "5 invites to share" headline.
18. **Invites · sent toast** — dark pill at the bottom-center: "✓ Invite sent · Code reserved for 14 days · Undo".

### Transactional emails (600px content width)
19. **Invite email** — `hello@notesci.com` · "You're invited to notesci" · code chip + Claim CTA + plain-link fallback.
20. **Reset email** — `security@notesci.com` · 30-min expiry, request-IP/location footer.
21. **Verify email** — `hello@notesci.com` · 24-hr expiry.

## Interactions & Behavior

- **Submit:** disable all inputs + replace CTA label with spinner + "…ing" verb.
- **Inline error:** red 1px border + 3px box-shadow halo (color-mix red @ 18% alpha), helper text below the field with a small ! badge. Top-of-form banner only when the error is non-field-specific (e.g. wrong-password is shown both at top and on the field).
- **Invite-code field:** validates on blur; shows ✓ in success-green when valid. Case-insensitive. Visually it's always rendered uppercase via CSS.
- **Forgot link:** lives in the password field's label row (right-aligned).
- **Onboarding:** every field is optional — "Save and continue" submits whatever's filled; "Skip everything" creates the account with no profile data.
- **Invite-friends Copy button:** copies link to clipboard, shows transient "Copied" state.
- **Invite-friends Send button:** opens an email-compose modal (not designed yet — flag this to the designer).
- **Toast:** auto-dismiss after 6s, with Undo for the first 4s.
- **Responsive:** desktop split collapses to tablet (hero stacks above form, height 360px) → mobile (hero hidden, single column, full-bleed).

## State Management
Per the auth feature you'll need:
- `session` — null | { user, token }
- `signupCode` — pre-filled from URL query `?c=`
- `signupCodeStatus` — idle | validating | valid | invalid | claimed | expired
- `submitState` — idle | submitting | error
- `fieldErrors` — { email?, password?, code? }
- `inviteAllocation` — { total: 5, codes: [{ code, status, to?, sentAt? }] }

## Design Tokens

### Colors (oklch + hex fallback)
```css
--ink:        #0e1116;            /* primary text */
--paper:      #f6f4ef;            /* page background */
--paper-2:    #efece5;            /* hero panel */
--rule:       rgba(14,17,22,.12); /* dividers, input borders */
--muted:      rgba(14,17,22,.55); /* secondary text */
--indigo:     oklch(0.52 0.22 274); /* brand primary */
--teal:       oklch(0.62 0.14 195); /* brand secondary */
--success:    var(--teal);
--warn:       oklch(0.72 0.16 60);
--error:      oklch(0.55 0.20 25);
```

### Type
- **Inter Tight** — UI sans (400/500/600/700)
- **Source Serif 4** — editorial headlines (400/500/600)
- **JetBrains Mono** — eyebrow labels, code fields, status pills (400/500)

### Type scale
| Use | Size | Weight | Letter-spacing | Line-height |
|---|---|---|---|---|
| Hero h1 (desktop) | 38px serif | 500 | -0.02em | 1.1 |
| Hero h1 (mobile)  | 30px serif | 500 | -0.02em | 1.1 |
| Editorial right h2 | 54px serif | 500 | -0.025em | 1.05 |
| Eyebrow label | 11px mono | 400 | 0.1em | — |
| Body | 14–15px sans | 400 | — | 1.55 |
| Field label | 10.5px mono | 400 | 0.1em uppercase | — |
| Invite code | 14–22px mono | 600 | 0.15–0.25em | — |

### Spacing
4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 22 / 24 / 32 / 36 / 40 / 44 / 48 / 56 / 64 / 72 px

### Radii
Inputs/buttons `10px` · cards `12–14px` · status icon circles half their dimension.

### Shadows
- Button hover: `0 4px 12px rgba(0,0,0,.12)`
- Toast: `0 16px 40px rgba(0,0,0,.18)`
- Glass card (V3 only, not used in V1): n/a

### Inputs
```css
.input { padding:12px 14px; border:1px solid var(--rule); border-radius:10px; background:#fff; }
.input:focus { border-color:var(--indigo); box-shadow:0 0 0 3px color-mix(in oklch, var(--indigo) 22%, transparent); }
.input.error { border-color:var(--error); box-shadow:0 0 0 3px color-mix(in oklch, var(--error) 18%, transparent); }
```

### Buttons
```css
.btn          { padding:12px 16px; border-radius:10px; background:var(--ink); color:var(--paper); font-weight:500; }
.btn.ghost    { background:transparent; border:1px solid var(--rule); color:var(--ink); }
.btn:hover    { transform:translateY(-1px); box-shadow:0 4px 12px rgba(0,0,0,.12); }
```

## Assets
- **Mark / wordmark** — see `mark.jsx`. Indigo + teal primary pairing. Don't recreate — port the SVG.
- **Auth provider icons** — Google, GitHub, ORCID, Institution. Inline SVGs in `signin.jsx` (`ICON` map) — copy them, or swap for your icon library.
- **Background paper texture** — pure CSS dot pattern (1px circles on 14px grid, 7% opacity). No image asset.

## Files
| File | Contents |
|---|---|
| `notesci-signin.html` | Page shell + design tokens in `<style>` |
| `signin.jsx` | V1 desktop/tablet/mobile, shared atoms, Hero panel |
| `flows.jsx` | Forgot, ResetSent, SetNewPassword, VerifyEmail, InviteLanding, AlreadyClaimed, ExpiredInvite, Onboarding, InviteFriends (desktop) |
| `flows-mobile.jsx` | Mobile versions of all of the above |
| `states.jsx` | Loading + inline-error stencils + invite empty state + sent toast |
| `emails.jsx` | 3 transactional email templates |
| `app-signin.jsx` | Design-canvas composition + Tweaks panel |

## Out-of-scope (flagged for future passes)
- Magic-link variant of sign-in
- 2FA prompt screen
- "Send invite" compose modal (in-app)
- Dark mode of V1
- Localization
