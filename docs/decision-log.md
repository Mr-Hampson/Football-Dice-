# Project decision log

Labels: **[Confirmed]** fact or agreed requirement · **[Assumption]** ·
**[Unverified]** to be tested · **[Rejected]**

## v0.3 – prototype built (current)

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
1. Exact tablet model(s) and Fire OS version(s). **Still unanswered and still the most important.**
2. Does Fire OS show the Usage access screen, or is USB/adb needed for every tablet? (Test plan §2)
3. Can Silk's address bar be read reliably? (Test plan §3)
4. Does the connection survive sleep, Wi-Fi drops and reboots? (Test plan §4)
5. Does the public Wi-Fi have a sign-in page, or block WebSockets? (Test plan §6)
6. Who hosts the hub, and where? Local authority approval of a cloud host in a UK or EU region.
7. DPO: lawful basis, DPIA, transparency to pupils and parents, and whether an accessibility service is acceptable.
8. Staff sign-in: individual accounts via Glow / Microsoft Entra ID?
9. Who owns the school Amazon account and installs apps on tablets?

### Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Silk's address bar can't be read, or breaks after an update | No website info | Domain-level fallback (a local VPN logging DNS) or a custom browser; *Can't tell* is shown honestly |
| Pupils disable the app or permissions | Gaps in visibility | Can't be prevented without MDM; shown as *Not connected* or *Can't tell* |
| Setting up every tablet by hand (permissions, possibly USB) | Time per class | Measure in the test; consider an MDM with Fire OS support |
| Fire OS power management closes the connection | Unreliable status | Foreground service plus reconnect on screen-on or network change; measure in the test |
| Amazon tablet roadmap (Vega OS / Android tablets) | App stranded | Keep the server and dashboard device-agnostic; only the pupil app is Fire-specific |
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
