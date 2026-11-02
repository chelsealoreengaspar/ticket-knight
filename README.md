# Ticket Knight: Secured Concert Event Ticketing System

CPE304L Software Design, CpE 3A Group 3 (G1). A web implementation of the Mini-SRS, UML and ERD in the midterm paper, built with plain **HTML, CSS and JavaScript**, **Supabase** (Postgres database, Auth, Edge Function) and deployed on **Vercel** from **GitHub**.

There are three apps in one project:

| Page | Who uses it | What it does |
|---|---|---|
| `index.html` | Ticket buyers (Account Owners) | Sign up with OTP + ID, choose concert / tier / seats, register one holder per ticket, get signed QR tickets, transfer a ticket |
| `scanner.html` | Gate Security | Validates tickets **offline**: signature, event, gate, revocation list, local ledger. GRANT / DENY with reason. Syncs when back online |
| `admin.html` | Event Administrator | Flagged transfer activity, revoke barcodes, transfers, hash-chain integrity check, scans and SMS log |

---

## Contents

- [Part 0. What you need](#part-0-what-you-need)
- [Part 1. Open the project in VS Code](#part-1-open-the-project-in-vs-code)
- [Part 2. Set up Supabase](#part-2-set-up-supabase)
- [Part 3. Create the ticket signing keys](#part-3-create-the-ticket-signing-keys)
- [Part 4. Deploy the sign-tickets Edge Function](#part-4-deploy-the-sign-tickets-edge-function)
- [Part 5. Create the admin and gate staff accounts](#part-5-create-the-admin-and-gate-staff-accounts)
- [Part 6. Run it locally](#part-6-run-it-locally)
- [Part 7. Put it on GitHub](#part-7-put-it-on-github)
- [Part 8. Deploy on Vercel](#part-8-deploy-on-vercel)
- [Part 9. Test plan (matches the paper's "Verify by" tests)](#part-9-test-plan)
- [Part 10. How the paper maps to the code](#part-10-how-the-paper-maps-to-the-code)
- [Troubleshooting](#troubleshooting)

---

## Part 0. What you need

Free accounts:
- **GitHub**: https://github.com
- **Supabase**: https://supabase.com (sign in with GitHub)
- **Vercel**: https://vercel.com (sign in with GitHub)

On your computer:
- **VS Code**: https://code.visualstudio.com
- **Git**: https://git-scm.com/downloads (Windows: keep the default options while installing)
- VS Code extension **Live Server** by Ritwick Dey (Extensions panel, search "Live Server")

Optional: Node.js (only if you want the Supabase CLI method in Part 4B).

---

## Part 1. Open the project in VS Code

1. Unzip `ticket-knight.zip` somewhere simple, like `Documents/ticket-knight`.
2. VS Code > **File > Open Folder...** > select the `ticket-knight` folder.
3. You should see:

```
ticket-knight/
├── index.html              buyer app (screens 1 to 6)
├── scanner.html            offline gate scanner
├── admin.html              administrator dashboard
├── sw.js                   lets the scanner reopen with no internet
├── vercel.json             Vercel headers (camera permission, caching)
├── css/style.css           shared UI style (from the Figma prototype)
├── js/
│   ├── config.js           <-- YOU EDIT THIS (Supabase URL + keys)
│   ├── common.js           shared helpers (API calls, ticket card, QR)
│   ├── app.js              buyer app logic
│   ├── scanner.js          scanner logic (offline validation)
│   └── admin.js            dashboard logic
├── supabase/
│   ├── schema.sql          <-- run in Supabase SQL Editor
│   ├── reset.sql           wipes the schema if you need to start over
│   └── functions/sign-tickets/index.ts   <-- Edge Function code
└── tools/keygen.html       generates the signing key pair
```

---

## Part 2. Set up Supabase

### 2.1 Create the project
1. Go to https://supabase.com/dashboard > **New project**.
2. Name: `ticket-knight`. Set a database password (save it somewhere). Region: **Southeast Asia (Singapore)** is closest to the Philippines.
3. Click **Create new project** and wait about 2 minutes.

### 2.2 Create the database (tables, rules, functions)
1. Left sidebar > **SQL Editor** > **New query**.
2. In VS Code, open `supabase/schema.sql`, select all (Ctrl+A), copy, and paste it into the SQL Editor.
3. Click **Run**. You should see "Success. No rows returned".
4. Check: left sidebar > **Table Editor**. You should see `accounts`, `events`, `tickets`, `ticket_history` and the other tables, and `events` should have 2 rows.

> If you ran it twice by mistake and get "already exists" errors: run `supabase/reset.sql` first, then `schema.sql` again.

### 2.3 Turn off email confirmation (for this project)
By default Supabase emails a confirmation link before a new user can sign in. Our system already verifies people with OTP + ID, and the free email sender is heavily rate-limited, so turn it off:

**Authentication > Sign In / Providers > Email** > switch off **Confirm email** > **Save**.

(If you keep it on, users must click the email link and then Sign In to finish verification. The app handles both.)

### 2.4 Copy your project URL and publishable key
1. Click the **Connect** button at the top of the dashboard (or **Project Settings > API Keys**).
2. Copy the **Project URL** (looks like `https://abcdefghijk.supabase.co`).
3. Copy the **Publishable key** (`sb_publishable_...`). If your project only shows legacy keys, copy the **anon public** key instead. Both work.
4. In VS Code open `js/config.js` and paste them:

```js
SUPABASE_URL: "https://abcdefghijk.supabase.co",
SUPABASE_ANON_KEY: "sb_publishable_xxxxxxxxxxxxxxxx",
```

> The publishable / anon key is **meant** to be public. It can only do what the Row Level Security rules in `schema.sql` allow. **Never** paste the `service_role` or `sb_secret_` key into any file in this project.

---

## Part 3. Create the ticket signing keys

Tickets are signed with an **Ed25519** key pair (NFR-003). The **secret** key stays on Supabase and signs tickets. The **public** key goes to the scanner so it can check signatures offline but can never make a ticket.

1. In VS Code, right-click `tools/keygen.html` > **Open with Live Server** (or just double-click the file in your file explorer).
2. Click **Generate key pair**. You should see "Self-test passed".
3. Copy the **PUBLIC key** into `js/config.js`:

```js
TK_PUBLIC_KEY: "paste-the-public-key-here",
```

4. Keep the page open. You need the **SECRET key** in the next part. Do not save it in any project file.

---

## Part 4. Deploy the sign-tickets Edge Function

### 4A. From the dashboard (easiest, no installs)
1. Supabase > left sidebar > **Edge Functions** > **Deploy a new function** > **Via Editor**.
2. Name it exactly: `sign-tickets`
3. Delete the template code. Paste everything from `supabase/functions/sign-tickets/index.ts`.
4. Click **Deploy function** and wait for the success message.
5. Add the secret: **Edge Functions > Secrets** (or Project Settings > Edge Functions) > **Add new secret**
   - Name: `TK_SIGNING_KEY`
   - Value: the **SECRET key** from keygen.html
   - Save.
6. Open the `sign-tickets` function > **Details / Settings**. If you see a **Verify JWT** / **Enforce JWT verification** toggle, you can leave it on. If ticket generation later fails with *401 Invalid JWT*, turn it **off** and save: the function already checks the signed-in user itself.

`SUPABASE_URL` and the service key are provided to Edge Functions automatically, so you do not add those.

### 4B. With the Supabase CLI (alternative)
```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase secrets set TK_SIGNING_KEY=PASTE_SECRET_KEY
npx supabase functions deploy sign-tickets --use-api
```

---

## Part 5. Create the admin and gate staff accounts

Staff do not register through the buyer app. Create them in Supabase:

1. **Authentication > Users > Add user > Create new user**. Enter an email and password and tick **Auto Confirm User**. Make one for the admin (example `admin@ticketknight.test`) and one for the gate (example `gate1@ticketknight.test`).
2. **SQL Editor > New query**, change the emails, and run:

```sql
insert into public.staff (user_id, role)
select id, 'ADMIN' from auth.users where email = 'admin@ticketknight.test';

insert into public.staff (user_id, role)
select id, 'GATE' from auth.users where email = 'gate1@ticketknight.test';
```

ADMIN can use both `admin.html` and `scanner.html`. GATE can use only the scanner.

---

## Part 6. Run it locally

1. In VS Code, right-click `index.html` > **Open with Live Server**. It opens `http://127.0.0.1:5500/index.html`.
2. The yellow "Setup needed" box means `js/config.js` still has placeholders.
3. Try the full flow:
   1. **Sign Up**: fill every field, tap **Send OTP**. The code appears in the *SMS (simulated)* banner at the top (an SMS gateway is out of scope in the paper). Type it, chip turns **Verified**, tap **Register**.
   2. Tap an event card or **Buy Tickets**. Choose a tier. Best adjacent seats are assigned and **held for 10 minutes**. Tap other empty seats in your tier to change them. Use + / - for quantity (max 6 per account per event).
   3. **Next**: enter one holder per ticket (**Use my details** fills yours). **View Summary** > **Generate Ticket**.
   4. Your signed tickets appear with QR codes.
4. Open `http://127.0.0.1:5500/scanner.html` in another tab (or on your phone, see Part 8). Sign in as the gate account, choose the event and the **gate printed on the ticket**, tap **Download offline data & start**. Start the camera and point it at the QR, or paste the code.
5. Open `http://127.0.0.1:5500/admin.html` and sign in as admin.

Tip: to paste a ticket code without a camera, on the buyer page right-click the QR > Inspect, and copy the `data-qr` attribute of the `.qr` box. Or just use your phone's camera on the deployed site.

---

## Part 7. Put it on GitHub

### Using VS Code (no typing commands)
1. First time only, open the VS Code terminal (**Terminal > New Terminal**) and set your name and email:
   ```bash
   git config --global user.name "Jan Denver Damasin"
   git config --global user.email "you@example.com"
   ```
2. Click the **Source Control** icon (left bar, the branch icon) > **Initialize Repository**.
3. Type a message like `Initial Ticket Knight system` > click **Commit** (choose **Yes** if asked to stage all changes).
4. Click **Publish Branch** > **Publish to GitHub** > sign in when asked > choose **private** or **public** repository.

### Or using the terminal
Create an empty repo on GitHub named `ticket-knight` first (no README), then:
```bash
git init
git add .
git commit -m "Initial Ticket Knight system"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/ticket-knight.git
git push -u origin main
```

### Working as a group
Add your groupmates: GitHub repo > **Settings > Collaborators > Add people**. Each member then clones it (`git clone https://github.com/YOUR-USERNAME/ticket-knight.git`), opens it in VS Code, and uses **Pull** before working and **Commit + Push** after.

> `.gitignore` already blocks `.env` files. The secret signing key must only live in Supabase secrets.

---

## Part 8. Deploy on Vercel

1. https://vercel.com/new > **Import Git Repository** > pick `ticket-knight` (click **Adjust GitHub App Permissions** if it is not listed).
2. Settings:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./`
   - **Build Command / Output Directory:** leave empty (it is a static site, nothing to build)
3. Click **Deploy**. After about 30 seconds you get a URL like `https://ticket-knight-xxxx.vercel.app`.
4. In Supabase: **Authentication > URL Configuration** > set **Site URL** to your Vercel URL and add it under **Redirect URLs**. (Needed only for emails such as confirmation or password reset.)
5. Every `git push` to `main` now redeploys automatically.

Pages:
- `https://YOUR-APP.vercel.app/` buyer app
- `https://YOUR-APP.vercel.app/scanner.html` gate scanner (use on a phone: the camera works because Vercel is HTTPS)
- `https://YOUR-APP.vercel.app/admin.html` admin dashboard

**Offline demo:** on the phone, open the scanner, sign in, download offline data, then turn on **airplane mode**. Scanning still works (FR-003, NFR-001). Admit a ticket, turn airplane mode off, and within 30 seconds the scan appears in the admin dashboard under **Scans & SMS**, with the SMS logged (FR-004).

---

## Part 9. Test plan

These follow the "Verify by" tests in the Mini-SRS.

| Req | Test | How to do it | Expected |
|---|---|---|---|
| FR-001 | Duplicate contact / email / ID rejected | Register a 2nd account using the same number, email or ID number | Field error: already registered / linked |
| FR-001 | No purchase without OTP + ID | Try Register before entering the OTP | Register stays disabled; server also refuses `hold_seats` for unverified accounts |
| FR-001 | 7th ticket rejected | Buy 6 for one event, then try 1 more | "+" disabled, "limit reached"; server returns the 6-ticket message |
| FR-002 | Unpaid seat released after 10 min | Hold seats and wait 10 min (or edit `interval '10 minutes'` to `'1 minute'` for the demo) | "Seat hold expired" and the seats become available |
| FR-002 | No ticket without holder details | Leave a holder blank and press View Summary | Blocked; Generate stays disabled |
| FR-002 | Under-age holder rejected | Holder younger than 12 for The Midnight Band | "Holder must be at least 12 years old" |
| FR-002 / NFR-003 | Altered barcode fails | Scanner > **Run tamper test** after one valid scan | 1000 of 1000 altered barcodes rejected |
| FR-003 | Offline GRANT / DENY | Airplane mode on: scan valid, already used, wrong gate, revoked, and an edited code | GRANT, or DENY with the specific reason |
| FR-003 | Wrong gate | Set scanner to GATE 1, scan a VIP ticket (GATE 3) | DENY: Wrong gate, send to GATE 3 |
| FR-003 | ID confirmation before entry | Scan a valid ticket | Shows holder name, waits for **ID matches / Admit** |
| FR-003 | Sync within 5 min | Reconnect after offline scans | Appears in admin within ~30 s |
| FR-004 | SMS on admit and on duplicate deny | Admit, then scan again | Two rows in admin > Scans & SMS |
| FR-004 | Entry never depends on SMS | Scanner works in airplane mode | GRANT still shown |
| FR-005 | Transfer revokes original | My Tickets > Transfer to a 2nd verified account, accept on that account, sync scanner, scan the old QR | DENY: Revoked barcode |
| FR-005 | Second transfer refused + flagged | Try to transfer another ticket for the same event | Refused; appears in admin > Flagged activity |
| FR-005 | Recipient over 6 refused + flagged | Transfer to someone already holding 6 | Refused and flagged |
| FR-005 | History tampering detected | SQL Editor: `update ticket_history set details = '{"hacked":true}' where chain_no = 2;` then admin > Ticket history > **Verify chain integrity** | "Integrity check FAILED at record #2" |
| FR-005 | Transfers close 24 h before event | Edit an event's `starts_at` to tomorrow, try to transfer | "Transfers close 24 hours before the event starts"; pending ones become VOIDED |

---

## Part 10. How the paper maps to the code

| Paper (class / requirement) | Implementation |
|---|---|
| Account, verifyIdentity() | `accounts` table; `request_otp`, `verify_otp`, `complete_registration` (OTP 5-minute expiry, simulated ID verification service). Password hashing by Supabase Auth; government ID stored only as SHA-256 hash |
| PurchaseOrder, validateQuantityLimit() | `purchase_orders`; 6-per-event check in `hold_seats` and `finalize_order` (counts tickets received by transfer) |
| Event, getAvailableTiers(), assignGate() | `events`, `event_tiers` (price, rows, section, gate) |
| TicketHolder, validateMinimumAge() | `ticket_holders` (one per ticket, unique FK); age checked against the event date |
| Ticket, generateSignature(), revoke() | `tickets`; Edge Function `sign-tickets` (Ed25519, private key only on server); `admin_revoke_ticket` |
| GateScanner, scanTicket(), checkLocalLedger(), syncLedger() | `scanner.html` + `js/scanner.js` (public key only, local ledger in browser storage, `sync_scans` + `get_scanner_bundle`) |
| TicketHistory, generateHash(), verifyChainIntegrity() | `ticket_history` with `previous_hash` / `current_hash` trigger; `admin_verify_history` |
| EventAdministrator, revokeCredential(), monitorDashboard() | `staff` table (role ADMIN), `admin.html` |
| TicketTransfer (FR-005) | `ticket_transfers`, `request_transfer`, `respond_transfer`, `cancel_transfer`, `activity_flags` |
| SMS on scan (FR-004) | `sms_outbox`, filled by `sync_scans` (gateway out of scope, logged as SIMULATED_SENT) |
| NFR-002 security | Row Level Security on every table; all writes go through checked database functions; only the publishable key is in the browser |

Notes on choices:
- The ticket "barcode" is a **QR code** (a 2D barcode) because a 1D barcode cannot hold the holder details plus a 64-byte digital signature.
- The paper's `age` column is stored as **birthday** so age is always correct on the event date.
- Payment, the SMS gateway and the government ID database are **out of scope** in the paper, so they are simulated and clearly labelled in the UI.

### Customizing
- **Events:** Table Editor > `events` (add `image_url` to use a real poster). Add 4 rows in `event_tiers` per event.
- **Seat map size:** rows A to H, 12 seats each. Tier rows are set by `row_letters` (e.g. `AB`).
- **Colors:** top of `css/style.css` (`--navy`, `--bg`, ...).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Yellow "Setup needed" box | `js/config.js` still has `YOUR-...` placeholders |
| "Could not load events" | `schema.sql` was not run, or the URL / key in `config.js` is wrong |
| `relation "... " already exists` when running schema | Run `reset.sql`, then `schema.sql` |
| Register says "Confirm your email first" | Turn off **Confirm email** (Part 2.3), or click the link in the email, then Sign In |
| "Tickets saved, but signing failed" | Edge Function not deployed, wrong name (must be `sign-tickets`), or `TK_SIGNING_KEY` secret missing. Fix it, then My Tickets > **Retry signing** |
| Signing fails with 401 / Invalid JWT | Turn off JWT verification on the function (Part 4A step 6) |
| Scanner says every ticket has an invalid signature | `TK_PUBLIC_KEY` in `config.js` is not the pair of the secret key in Supabase. Generate a new pair, update both, re-issue tickets |
| Scanner: "Gate staff only" | Add the account to the `staff` table (Part 5) |
| Camera does not start | Needs HTTPS (Vercel) or `127.0.0.1` / `localhost`, and browser camera permission |
| Revoked ticket still admitted offline | The scanner only knows about revocations from its last sync. Tap **Sync now** before doors open |
| Changes not showing on Vercel | Did you commit **and push**? Check the Vercel dashboard for the latest deployment |
