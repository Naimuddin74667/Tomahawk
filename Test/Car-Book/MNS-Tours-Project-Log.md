# MNS Tours & Travels — Project Log

*Conversation and build history up to 23 Oct 2026*

---

## 1. What the app is

A standalone app for the MNS Tours & Travels taxi business. It has nothing to do with Tomahawk and only borrows its repo for hosting. It tracks every rupee in the business:

- rent collected from the driver
- expenses, including self-use, where the owner pays the business back for the hours he uses the car
- EMIs and the loan
- the car's full cost including interest
- the 50/50 partner split with Uncle
- the available account balance

It is built for phones, since about 99% of use is on a phone. It has its own light theme with a teal accent and a teal "MNS" car logo, and it installs from Chrome like a normal app (PWA).

| Item | Value |
|---|---|
| Live app (owner / partner) | https://naimuddin74667.github.io/Tomahawk/Test/Car-Book/ |
| Driver screen | …/Test/Car-Book/driver.html (opens automatically after a driver logs in) |
| Repo folder | `Naimuddin74667/Tomahawk` → `Test/Car-Book/` (temporary home) |
| Backend | Cloudflare Worker `mns-enterprises` on a **separate** Cloudflare account (not Tomahawk's bullet.co.in account) |
| Worker URL | https://mns-enterprises.naimuddinshaikh74667.workers.dev |
| Database | Cloudflare D1 `mns_enterprises`, bound as `DB` |
| Worker secret | `ADMIN_KEY` (used only for the first-ever owner login) |

---

## 2. Business data captured

**Vehicle 1 — Maruti Dzire Tour S CNG**

| Field | Value |
|---|---|
| Dealer | Aher Autoprime LLP |
| Registered name | MNS TOURS AND TRAVELS |
| Ex-showroom | ₹7,25,799 |
| On-road if paid in cash | about ₹8,30,000 |
| Upfront paid | ₹2,00,000 (down payment + tax + permit + registration + insurance), **paid by Uncle** |
| Financier | KMPL |
| Loan amount | ₹6,16,000 + loan protection ₹6,128 = **₹6,22,128** |
| Charges | ₹13,000 |
| Net disbursed | ₹6,03,000 |
| IRR | 14.01% |
| EMI | ₹21,314 × 36 months, starting 05 Nov 2026 |
| Car value in app | Upfront + all EMIs (interest included) + accessories |

**Partner arrangement**
- Owner and Uncle split 50/50.
- Uncle paid the ₹2 lakh upfront, so the owner owes him ₹1 lakh. The owner can log money he gives Uncle from his salary to settle this.
- Profit taken out for personal use can be logged as a withdrawal.

**Rent rules**
- Rent is ₹1,200 per day, due at **8 PM**, and is always paid online.
- One rent period covers the **previous night plus the current day**. It is shown as, for example, "16–17 Oct", meaning the 16th night and the 17th day.
- Half-day car-off: the night or the day can be marked off separately. Each half is worth ₹600.
- Payments fill the oldest unpaid days first.
- Rent goes to the **business account**. It is not logged to the owner's or Uncle's name, unless one of them used the car (self-use).

**EMI rules**
- EMIs are auto-marked paid on the **6th of each month**.
- Each EMI's payer can be **Rent / Me / Uncle**. EMIs paid from rent create no partner share.

---

## 3. How the conversation went (chronological)

1. **Idea.** A new, fully independent app for the rented car, covering every expense and every earning from A to Z, with view access for the driver. It started on localStorage, using the Test folder.
2. **Theme and name.** Given its own look. Named **MNS Tours & Travels**. Made phone-first. Claude was allowed to push without asking.
3. **Car cost.** Loan details entered. Total car cost now includes interest. The ₹2 lakh upfront was confirmed as **Uncle's** money. The extras category was narrowed to "Accessories" only.
4. **Daily rent popup.** Each morning a simple "Did you receive rent?" confirm appears, and confirming adds the rent.
5. **Self-use expense type** added, so the owner's own trips are paid back to the business and the rent figures stay clean.
6. **EMI auto-paid on the 6th**, with a payer choice (Rent / Me / Uncle).
7. **Partner settlement.** Added "paid Uncle from my salary" (toward the ₹1 lakh) and "personal withdrawal of profit".
8. **Real data vs testing.** Existing entries were declared real. A **Testing mode** snapshot was added: when the owner says "testing completed", one tap restores the real entries.
9. **Available balance card.** Shows rent coming in, EMIs and expenses going out, and what should be in the account.
10. **Logo.** First attempt was skipped. Later the owner supplied his own logo image, which was adapted to teal and used for the app and web icons. The icon was renamed to `logo-*.png` so phones pick up the new one (reinstall needed). The white outline was kept and the extra white space was being trimmed.
11. **Rent pattern** set to 8 PM, previous night plus day, always online. Example handled: 15th night paid, 16th day and night paid, 17th day car off, 17th night pending.
12. **Driver app** built (driver.html).
13. **Backend.** The old "MNS Collection" app had used Cloudflare, so the owner chose Cloudflare again on a **different account** and set it up by hand with Claude's step-by-step guidance (Claude in Chrome was off). Created: Worker, D1 database, binding, secret.
14. **Live sync.** Auto-save about every second, and polling every 5 seconds while the app is open. An incognito window showed no data at first, so the cloud URL was **hard-coded** and removed from Settings. The cloud copy now always wins on a new device.
15. **Logins.**
    - First design: mobile + password.
    - Then reworked into **owner-created users**: the owner enters a mobile number, the server generates a 6-digit PIN, and the owner shares it on WhatsApp.
    - Roles:
      - **Owner** has full access.
      - **Viewer** (Uncle) can see everything and change nothing.
      - **Driver** sees only his own rent.
    - 5 wrong PINs lock that mobile number for 15 minutes. Resetting a PIN logs out old sessions.
16. **Installable PWA.** Manifest and service worker added. An "Install app" button appears in Chrome.
17. **Driver payments.**
    - First try: UPI pay links with the note "Rent for 16–17 Oct" and a "pay other amount" option.
    - These failed with an **"exceeded limit"** error, because UPI apps block person-to-person intent links.
    - A copy-paste UPI box replaced them, but was rejected as too much effort.
    - **Final flow:** the driver pays by UPI himself, then taps **"I've paid"**. The owner gets a popup: **Yes received / Not received / Later**. Until the owner answers, those days show **"In process"** on the driver's screen.
18. **Multi-vehicle.** Vehicle number and registration added. Supports more cars later, with a vehicle switcher, per-vehicle EMI and cost, and an "All vehicles" total.
19. **One-tap ₹1,200.** "I've paid" always means a full day (₹1,200). A small link handled the rare half day (₹600).
20. **Partner view is silent.** Uncle's view-only login gets no popups, no banners and no notifications.
21. **Half-day claim options (still pending).** See section 6.
22. **Wrong "received" taps (23 Oct).** Two rent entries were saved by mistake from the Car off / half day screen. They were removed directly in D1 (Console) with a JSON UPDATE on `app_state`; Time Travel confirmed nothing older was lost. The owner then added the missing ₹3,600 so the app matches the ₹6,600 actually received.
23. **Undo bar.** After "Received", "Received all" or "Save & received", a bar with **Undo** shows at the top for 10 seconds. Taps made while it shows are undone together.
24. **Change log (Setup).** Every change is recorded automatically (one entry per action) in `DB.log` inside the cloud data, last 60 days / 400 entries. Each row has **Undo**: added → removed, deleted → restored, edited → old values back. An undo is its own entry, so it can be undone. An older entry is blocked if the same record was changed later and that change is still in effect. Owner only; Uncle doesn't see it.
25. **Setup reorganized.** One column of collapsible sections, all closed each time you open Setup, with a one-line summary on each: Vehicle & loan · Drivers · Partners · Logins & users · Change log · Backup & testing.
26. **No automatic popups.** The rent popup no longer opens on app start or at 8 PM, and the driver "I've paid" popup no longer opens by itself. Confirm from the banners ("rent pending → Confirm" on Dashboard and Rent, "Review" for driver claims).

---

## 4. Files (in `Test/Car-Book/`)

| File | Purpose |
|---|---|
| `index.html` | Owner + partner app: dashboard, rent, expenses, EMIs, vehicles, partner settlement, users & logins, claim popups, testing mode |
| `driver.html` | Driver screen: his own rent days, paid/pending/"In process", "I've paid" button, waiting and not-received cards |
| `mns-worker.js` | Cloudflare Worker code. The owner **pastes it by hand** into Cloudflare (Edit code → Deploy). Named this way so Tomahawk's auto-deploy workflow (which watches root `worker.js`) never touches it |
| `manifest.json`, `sw.js` | PWA install + offline cache (`mns-tours-v9`) |
| `logo-192.png`, `logo-512.png`, `*-maskable.png`, `logo.png`, `favicon.png` | Icons |

### Worker endpoints
| Endpoint | Who | What |
|---|---|---|
| `POST /login`, `/logout`, `GET /me` | all | Mobile + PIN login (Bearer token) |
| `GET/POST/DELETE /users`, `/users/reset-pin`, `/users/password` | owner | Create users, generate a PIN, reset or remove |
| `GET /state` | owner, viewer | Full data + pending claims |
| `PUT /state` | owner | Save (rejected with 409 if the copy is older) |
| `POST /claims/resolve` | owner | Accept or reject a driver's "I've paid" |
| `GET /driver` | driver | Only his vehicle, payments, offs and claims |
| `POST /driver/claim`, `/driver/claim/cancel` | driver | Send or cancel "I've paid" (max 5 pending) |

### D1 tables
- `app_state`: one JSON blob holding all business data
- `users`: mobile, name, hashed PIN (PBKDF2), role, driver_id, lockout fields
- `sessions`: login tokens
- `claims`: driver "I've paid" requests with status pending / accepted / rejected / cancelled

---

## 5. Problems hit and fixed

| Problem | Fix |
|---|---|
| Blank login screen after an update (a variable was used before it was declared) | Fixed and pushed. Owner told to hard-refresh |
| Mobile field cut off "+91 98765 43210" | Removed the length limit |
| Incognito showed empty data | Cloud URL hard-coded. The cloud copy always wins |
| A new device could overwrite cloud data | The cloud copy now wins on first connect |
| Partner's view could try to save | Viewer never pushes. It always pulls |
| Pending banner double-counted claimed amounts | Claimed amounts are subtracted |
| Loan charges showed the whole loan when net disbursed was blank | Shows 0 |
| Phone icon stayed as the ₹ symbol | Renamed icon files. Reinstall the app |
| UPI "exceeded limit" error | Dropped UPI links. Driver now just marks "I've paid" |
| Owner saw an old screen after updates | Close and reopen, or reinstall |

---

## 6. Current status and pending work

**Latest pushed commits**
- 23 Oct: change log with Undo in Setup, collapsible Setup sections, no automatic popups
- `84be9f7`: Undo bar after "Received" in the rent popup
- `bfd3cce`: one-tap "I've paid ₹1,200" + half-day link
- `915efd1`: view-only partner gets no popups, banners or notifications
- Earlier: `da5386a` claims flow · `b4a80a6` multi-vehicle · `5c5915c` PIN logins

**In progress: the latest request**
> "Show driver only the 1200 button; when clicked show a popup to confirm with a small checkbox for half-day payment. Owner should be able to convert a full payment confirmation into half paid + half pending, or mark half day vehicle off."

- [x] Worker updated **locally**. Each claim now stores which rent day it is for (new `day` column, added automatically). Not yet pushed and not yet pasted into Cloudflare.
- [ ] Driver screen: a single ₹1,200 button opens a confirm popup with a "Half day only (₹600)" checkbox, then Confirm.
- [ ] Owner popup gets new choices:
  - **Yes, received ₹1,200**
  - **Received only half (₹600), rest pending**
  - **Half day, vehicle was off** (pick night or day; marks that half off)
  - **Not received** / **Later**
- [ ] Test on the local mock server, then push.
- [ ] Owner pastes the new `mns-worker.js` into Cloudflare and deploys.

**Other open items**
- App icon: make the logo fill more of the white tile (preview shown, waiting for the owner's yes).
- Confirm the claims-version Worker is deployed in Cloudflare.
- **Testing mode is still ON.** When testing is finished, say "testing completed" and tap the restore button to return to the real entries.

---

## 7. How updates are made

1. Edit the files locally and run a JavaScript syntax check on every `<script>` block.
2. Test end-to-end on a local mock of the Worker (Node + SQLite) with browser scripts covering owner, viewer and driver.
3. Push to `Test/Car-Book/` with a plain push (never force). GitHub Pages updates in about a minute.
4. If `mns-worker.js` changed, the owner pastes it into Cloudflare → Worker `mns-enterprises` → Edit code → Deploy.
5. On the phone: close and reopen the app (or hard-refresh) to get the new version.
