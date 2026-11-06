# Project decision log

Labels: **[Confirmed]** fact or agreed requirement · **[Assumption]** ·
**[Unverified]** to be tested · **[Rejected]**

## v0.4 – shared tablets and join codes (current)

### Device confirmed
- **Fire HD 10 (13th Generation, 2023)** [Confirmed by the school]. Amazon lists it as **Fire OS 8, based on Android 11 (API 30)**, with security updates committed to at least 31 Dec 2029 [Confirmed, Amazon docs]. To be double-checked on a real tablet via the app's *Technical details* screen.
- The app's `targetSdk 30` matches this exactly. Android 13's restriction on accessibility services in sideloaded apps doesn't apply on Android 11.
- **Every school tablet is this model** [Confirmed by the school], so there's one Fire OS version to support.
- A spare tablet (not used by pupils) is available for the feasibility test.

### Pre-install checks on the spare tablet (5 Nov 2026)
| Check | Result |
|---|---|
| Fire OS version | **8.3.3.8**, the same on every tablet [Confirmed] |
| Install from unknown sources | **Allowed**, via Silk [Confirmed] |
| Usage access settings screen | **Visible in Settings** [Confirmed]. No USB/adb step should be needed for app tracking. |
| Developer options | Available [Confirmed] (fallback only) |
| School public Wi-Fi | **No sign-in page**; it just connects [Confirmed] |
| Existing app with Usage access | **"System Status Manager"** v1.0727.0 (9.63 MB) already has Usage access. It has **no Uninstall option**, so it's part of the system software. Almost certainly Amazon's own, since a school-installed app could always be uninstalled without MDM [Reasonable assumption]. Amazon doesn't document it publicly. The app's *Technical details* will show its package name to confirm. |

### Hosting for the trial
- **Render**, Starter plan + 1 GB disk, **Frankfurt (EU)** region [Chosen: the easiest option]. Render has no UK region; EU hosting needs DPO sign-off.
- **Deployed and working** (5 Nov 2026): health check, teacher login and tablet setup codes all checked by the school. The address is kept out of this public repository.
- Rejected the free plan: it sleeps after about 15 minutes idle and has no persistent disk.
- **Automatic deploys are off**: an update restarts the hub and ends running lessons, so deploy manually outside lesson times.
- Behind Render's proxy, login/setup lockouts use the client address the proxy records, so one person's wrong passwords don't lock out every teacher.

### Distribution for the trial
- Each build is published as a **public GitHub Release**, so tablets can install it from Silk without a GitHub account [Agreed, trial only]. A move to a locked-down, private distribution is required if the project goes commercial.
- Builds are signed with a **permanent school key** held in GitHub secrets (from Test build 6), so updates install over older versions. The key holder must keep a backup [Confirmed].

### v0.5 – messages, freezing screens, auto-opening links, in-app updates (agreed)
- **Messages to pupils** [Agreed]: one-tap or typed, to everyone or selected pupils. They show as a **pop-up card with an OK button** over any app, with ✓ received / ✓✓ seen ticks. One-way only (no replies), for safeguarding.
- **Freeze screens** [Agreed]: a full-screen “Eyes on your teacher” cover. Ends on its own after **5 minutes** (1–10 allowed), when the teacher unfreezes, when the lesson ends, or if the tablet loses the hub for a minute.
- **Links open automatically** [Agreed], with a notification as the fallback.
- **In-app updates** [Agreed]: the tablet offers “Install update” outside lessons. Android 11 still needs one confirm tap per tablet.
- How: the pop-ups and the freeze use the website-check accessibility service's overlay window. **Freeze tested on the school's tablets and worked** (Test build 13, hub deployed) [Confirmed by the school]. It isn't a true device lock: a forced restart or holding the power button still works.
- **Changed decision:** device locking was "outside the MVP" in v0.3. It's now in, as a trial feature, at the school's request.
- **For the DPO:** the audit log records the **text** of staff-to-pupil messages, for safeguarding accountability; confirm or change. Freezing is a new kind of control over pupil devices, so add it to the DPIA and to the pupils' "what your teacher can see" information.

### v0.6 – help button, needs attention, board code, tablet health, audit log, hub settings (agreed)
- **Teacher logins deferred** [Decided]: one shared password stays for now; individual logins if it scales.
- **"I need help"** button on the tablet (in the app and in its notification). The card shows ✋ until the teacher presses Done. A signal only, no free text (safeguarding).
- **Needs attention:** cards are highlighted when a pupil asks for help or has been off task for 2+ minutes, with an optional "Needs attention first" sort.
- **Join code on the board:** a full-screen projector page showing only the code, lesson name and number joined.
- **Tablet health page:** app version, battery, permissions and last seen per tablet, with problems flagged. This is about the tablet, not the pupil, so it's kept outside lessons too.
- **Audit log page**, with entries **deleted after 120 days** (`AUDIT_RETENTION_DAYS`). It's stored as a small file on the hub's disk; it adds no hosting cost. **For the DPO:** confirm the retention period.
- **Settings sent from the hub** (`server/config/device-config.json`): where Silk's address bar is. A Silk change is fixed with a hub deploy instead of an app update.
- **Lower data use:** live updates and larger replies are now compressed, to stay inside Render's free 5 GB a month.

### v0.7 – security tightened; hosting questions (agreed)
- **Correction:** HTTPS protects data **in transit only**, not where it's stored. The deck no longer presents it as sufficient (the "online banking" comparison was removed). The main protection is **data minimisation**: no pupil names or activity are ever written to disk.
- **Audit log encrypted at rest** (AES-256-GCM) when `AUDIT_KEY` is set. Limit: the key is held with the hub's settings, so it protects against a leaked disk or backup, not a compromised hosting account.
- **Optional dashboard IP allow-list** (`TEACHER_ALLOWED_IPS`), e.g. the school's public IP, so the shared password is useless outside school. Tablets are never restricted. **Not enabled for now** [Decided]: staff need access from home, e.g. testing at weekends.
- **Security headers** on every reply (HSTS, no framing, no sniffing, permissions policy).
- **The app only accepts https:// hub addresses**; unencrypted connections are refused.
- **Dependency checks:** `npm audit` in the build, and weekly Dependabot update checks for the hub, the app and the build.
- **Known gaps:** one shared teacher password (individual logins deferred); live lessons are held in server memory; the host's disk encryption and staff access are unconfirmed; the tablet's key is stored in app-private storage, not the Android Keystore.

- **Incident (6 Nov):** Dependabot's update branches briefly published unsigned "Test builds" 19, 20, 23 and 27 as the latest release. Tablets can't install them, because the signature doesn't match. Fixed: releases now come only from our branch, and only when signed with the school key (Test build 33 is the latest). The four stray releases should be deleted on GitHub. Dependabot's pull requests are proposals only: review them before merging.

### Hosting: stay on Render for now; questions for the council and DPO
- Render publishes **ISO 27001:2022** and **SOC 2 Type II**, a GDPR DPA covering **UK GDPR / DPA 2018** with UK transfer terms, and certification under the **EU-US Data Privacy Framework with the UK Extension** [From Render's own documents: confirm on dataprivacyframework.gov]. The full SOC 2 report and ISO certificate need a higher Render plan and an NDA.
- No Scottish rule requiring UK hosting was found. **Council policy may be stricter.**
- **Questions:** (1) Is EU hosting acceptable, or UK only? (2) Are US-owned providers acceptable with a DPA and the UK-US data bridge? (3) Is there an existing cloud agreement (e.g. Azure UK South)? (4) What supplier evidence is needed (ISO 27001, SOC 2, Cyber Essentials)? (5) Does Render encrypt disks at rest, and who on its staff can access servers?
- If UK-only is required: move the hub (it runs on any host via the Dockerfile; about a day of work) and re-set up each tablet with the new address (about a minute each, and permissions are kept).

### Before roll-out (deferred by the school until closer to the trial)
- Update the **walkthrough videos** and **teacher guide** to cover messages and freezing.
- Update the **pupil poster's** "what your teacher can see" box: the teacher can also send messages and freeze screens for up to 5 minutes. This is needed for transparency before pupils use those features.
- Fill in the trial details on the head teacher deck (names, trial length, staff and tablet numbers).

### First real-tablet test (6 Nov 2026) — passed
- On the spare Fire HD 10 (13th Gen) with the hosted hub: setup, joining with code + name, **foreground app tracking**, **Silk website detection (on/off task)**, links, and reconnecting all worked [Confirmed by the school]. The biggest technical unknown, reading Silk's address bar, works on this model.
- The teacher dashboard went blank on the school network because its live connection was blocked; it now falls back to refreshing every few seconds. Tablets connected without problems.

### Changed requirements (agreed)
- **Tablets are shared, not individual** [Confirmed]. They are **numbered**, and pupils don't use the same one each time. *Supersedes the v0.3 "individual tablets" requirement.*
- **Several lessons can run at the same time** in different rooms [Confirmed].

### New decisions
| Decision | Reason |
|---|---|
| Each tablet is set up once with its **number** (from its sticker) and a school setup code | The hub needs a stable identity for every tablet, so unjoined tablets can be seen |
| Pupils join each lesson with a **4-character join code** shown on the dashboard, plus their name | Works with simultaneous lessons; a familiar pattern (like Kahoot); avoids joining the wrong lesson |
| Pupils type **first name + surname initial** (e.g. "Amy K") | Enough to tell pupils apart; minimal personal data |
| **No class lists or pupil names stored** on the server; names exist only for the lesson | Less admin, less personal data |
| The teacher can **ask a pupil to retype their name** or **remove** them from the lesson | Handles typos and silly names |
| Duplicate names are flagged; **connected tablets not in any lesson are listed by number** | A pupil who never joins would otherwise be invisible |
| Lessons end automatically after 2 hours (configurable) | In case the teacher forgets to end the lesson |
| Pupils have no "leave lesson" button | Leaving would be an easy way to escape monitoring; the teacher removes them, or the lesson ends |

### New risks
- A pupil can type someone else's name. Mitigation: the teacher can see tablet numbers and ask for a retype.
- Shared Amazon account: logins and history in Silk carry over between pupils. **Needs a school policy** (sign out at the end of a lesson), and should be mentioned in the DPIA.

### Superseded from v0.3
- "Tablet identity: one-time setup code per pupil → permanent device token" is replaced by a per-tablet identity plus per-lesson join.
- Class and pupil management in the dashboard has been removed.

## v0.3 – prototype built

### Confirmed requirements
- Pupils have **individual** Fire tablets, which **stay in school**. Each is signed into a **school Amazon account**.
- No MDM; tablets are otherwise standalone. They connect to the school's **public Wi-Fi**.
- Pupils use **Amazon Silk**. Keep Silk; don't replace the browser.
- The teacher needs an **on task / off task** signal, not full browsing detail.
- The teacher dashboard is a website, used on a school laptop.
- Out of MVP scope: screen view, thumbnails, remote control, app blocking, locking.

### Technical decisions (prototype)
| Decision | Reason |
|---|---|
| Central hub server on the internet (HTTPS) | Public Wi-Fi normally blocks device-to-device traffic. Only outgoing port 443 is needed. |
| Web dashboard (plain HTML/JS) + Node.js server + WebSockets | Simplest stack to maintain; works on any school laptop without installing anything |
| Native Kotlin pupil app, sideloaded | Required for Usage access and accessibility. Cross-platform tools would need native code anyway. |
| Foreground app via `UsageStatsManager` | Standard Android API; no root needed |
| Website via an accessibility service, limited to browser apps | The only way found to read Silk's address bar while keeping Silk **[Unverified on Fire]** |
| On-task decided **on the tablet**; domain sent only when off task | Data minimisation, which supports the DPIA |
| Allowed list per lesson; links sent are allowed automatically | Least effort for teachers |
| No activity history stored; activity cleared at lesson end | Data minimisation |
| Monitoring only during a lesson the teacher starts | Proportionality; matches the "stay in school" use |
| Tablet identity: one-time setup code → permanent device token (only its hash is stored) | Individual tablets; simple and revocable |
| Single shared teacher password | Prototype only, to be replaced (see outstanding questions) |
| JSON file storage | Fine for one-school testing; move to a database before scaling |
| `targetSdk 30`, `minSdk 22` | Matches Fire OS 8 while still installing on older Fire OS |
| Rate limiting counts failed attempts only | All tablets share one public IP behind the Wi-Fi, so a per-request limit would block a whole class setting up |

### Rejected
- **Browser-only pupil page (Option D)** [Rejected]: it can't see other apps or tabs.
- **Desktop teacher app (Option B)** [Rejected]: needs installing on every laptop and direct device connections.
- **Custom school browser** [Rejected for now]: it would replace Silk. Reconsider if the Silk accessibility approach fails.
- **School network or web-filter logs** [Rejected]: the tablets are on public Wi-Fi with no filter logs we control.

### Outstanding questions
1. ~~Exact tablet model~~: Fire HD 10 (13th Gen), Fire OS 8 / API 30, the whole fleet. **Resolved.**
2. ~~Does Fire OS show the Usage access screen?~~ **Yes.** Still to check: does our app actually report the foreground app? (Test plan §2)
3. Can Silk's address bar be read reliably? (Test plan §3)
4. Does the connection survive sleep, Wi-Fi drops and reboots? (Test plan §4)
5. ~~Does the public Wi-Fi have a sign-in page?~~ **No.** ~~Are WebSockets to the hub allowed?~~ **Yes:** tablets on the school's public Wi-Fi work fully [Confirmed by the school].
6. Who hosts the hub, and where? Local authority approval of a cloud host in a UK or EU region.
7. DPO: lawful basis, DPIA, transparency to pupils and parents, and whether an accessibility service is acceptable.
8. Staff sign-in: individual accounts via Glow / Microsoft Entra ID?
9. Who owns the school Amazon account and installs apps on tablets?

### Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Silk's address bar can't be read, or breaks after an update | No website info | Domain-level fallback (a local VPN logging DNS) or a custom browser; *Can't tell* is shown honestly |
| Pupils disable the app or permissions | Gaps in visibility | Can't be prevented without MDM; shown as *Not connected* or *Can't tell* |
| Setting up every tablet by hand (permissions) | Time per tablet | Lower risk: no USB needed, since Usage access is in Settings. Measure the time in the test. |
| Fire OS power management closes the connection | Unreliable status | Foreground service plus reconnect on screen-on or network change; measure in the test |
| Amazon tablet roadmap (Vega OS / Android tablets) | App stranded (lower risk: this model is supported until at least 2029) | Keep the server and dashboard device-agnostic; only the pupil app is Fire-specific |
| Public Wi-Fi captive portal or filtering | Tablets can't connect | Test on site; use HTTPS on port 443 only |
| Data protection approval | Can't use with pupils | DPIA before any real pupil use; privacy-preserving design |

### Reserved for future versions
Screen thumbnails (needs pupil consent every session on Android), app
blocking or locking (needs MDM or device owner), individual staff accounts,
usage reports, file sending, teacher messages, and DNS-based website fallback.

## History
- **v0.1**: initial assessment; Option A (web dashboard + pupil app) recommended, subject to a feasibility test.
- **v0.2**: requirement changed to on-task / off-task; four dashboard states; status worked out on the tablet.
- **v0.3**: tablets confirmed in-school only, on a school Amazon account and public Wi-Fi. Network-log option rejected. Prototype built.
- **v0.4**: tablets confirmed shared and numbered, with simultaneous lessons. Changed to per-tablet identity, join codes and typed names.
