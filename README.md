# Classroom Hub (prototype)

A teacher dashboard that shows, at a glance, whether each pupil's Amazon Fire
tablet is **on task**, and lets the teacher send links to the class.

> **Status: prototype for a feasibility test.** Use it with test tablets and
> made-up pupil names until the school's Data Protection Officer has approved
> it (see [docs/decision-log.md](docs/decision-log.md)). It has not yet been
> run on a real Fire tablet.

```
 Teacher laptop (web browser)            Hub server (internet, HTTPS)          Pupil Fire tablets
 ┌──────────────────────────┐   wss    ┌─────────────────────────────┐  wss   ┌──────────────────────┐
 │ Dashboard: pupil cards,  │◄────────►│ Node.js                     │◄──────►│ Classroom Hub app     │
 │ start lesson, send link  │          │ classes/pupils: JSON file   │        │ works out on/off task │
 └──────────────────────────┘          │ live activity: memory only  │        │ on the tablet itself  │
                                       └─────────────────────────────┘        └──────────────────────┘
```

Tablets on public Wi-Fi usually can't talk directly to a laptop in the same
room, so everything goes through a server on the internet. All three parts only
make outgoing connections over the normal secure web port (443).

## What it does

| Feature | How |
|---|---|
| Class grid with connection status | Each tablet keeps a live connection; no message for 45 s means "Not connected" |
| On task / off task | The teacher picks the allowed sites when starting a lesson; links they send are added automatically |
| Which app is in use | Android's *Usage access* permission (`UsageStatsManager`) |
| Which website (Silk) | **Experimental.** An accessibility service reads Silk's address bar. Only the domain is kept (e.g. `bbc.co.uk`) |
| Send link to class or selected pupils | The tablet shows a notification; tapping it opens Silk |
| Received / opened ticks | The tablet confirms when the notification arrives and when it's tapped |

### Privacy by design
- Nothing is monitored outside a lesson the teacher has started.
- The tablet decides on-task/off-task itself. A site is named to the server only when it is **off** the lesson list.
- Pupil activity is held in server memory only and cleared when the lesson ends. Nothing about what pupils did is written to disk.
- The audit log (`data/audit.log`) records teacher actions: log in, start or end a lesson, send a link.
- The tablet shows a permanent notification saying when activity is being shared.

## Folders

```
server/    Hub server + teacher dashboard (Node.js, plain HTML/JS)
android/   Pupil app for Fire tablets (Kotlin)
docs/      Decision log and the tablet test plan
.github/   Automatic build: runs tests and produces the APK
```

## Try the dashboard on your computer (no tablets needed)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd server
npm install
TEACHER_PASSWORD=demo npm start               # dashboard at http://localhost:3000
# in a second terminal: 22 pretend tablets
TEACHER_PASSWORD=demo npm run simulate
```

Log in with `demo`, choose **Demo class**, tick some sites and press **Start lesson**.
On Windows PowerShell, set the password first with `$env:TEACHER_PASSWORD="demo"`.

Run the automated tests with `npm test`.

## Get the pupil app (APK)

GitHub builds it automatically on every push: **Actions → Build and test →
latest run → Artifacts → `classroom-hub-pupil-apk`**.

To build it yourself, install Android Studio, open the `android` folder, then
choose **Build → Build APK(s)**.

**Use the same signing key for every build.** Otherwise each new version has
to be uninstalled first, and the permissions set up again. Create a key once
and add it as repository secrets: `HUB_KEYSTORE_BASE64`, `HUB_KEYSTORE_PASSWORD`,
`HUB_KEY_ALIAS` and `HUB_KEY_PASSWORD`.

## Set up a Fire tablet

The full checklist is in [docs/tablet-test-plan.md](docs/tablet-test-plan.md). In short:

1. **Settings → Security & Privacy → Apps from Unknown Sources**: allow Silk (or Files) to install apps.
2. Copy the APK to the tablet, or download it in Silk, then install it.
3. On the dashboard, open **Classes & tablets**, press **Get setup code** next to the pupil, and enter the hub address and code on the tablet.
4. In the app, press **Open settings** for each checklist item:
   - **Usage access**: if Fire OS hides this screen, connect the tablet to a laptop by USB (needs *Developer options → USB debugging*) and run:
     `adb shell appops set uk.school.classroomhub GET_USAGE_STATS allow`
   - **Website check**: Settings → Accessibility → *Classroom Hub website check* → On.

## Host the hub

The tablets are on public Wi-Fi, so the hub must be reachable on the internet
over **HTTPS**. Any host that can run a Docker container with a small
persistent disk works (`server/Dockerfile`):

- Set `TEACHER_PASSWORD` to a long password, and `COOKIE_SECURE=true`.
- Mount persistent storage at `/data`.
- Pick a UK or EU data-centre region, and confirm the host with the DPO.

`http://` only works for local testing. Never use it with real pupils.

## Known limitations (prototype)

- **Silk website detection is unproven.** Amazon doesn't document Silk's screen layout. The app's *Technical details* screen shows what it can detect; see the test plan.
- **Pupils can switch monitoring off** (force-stop, remove permissions, airplane mode). Without device-management control, this can't be prevented. The dashboard shows it as *Not connected* or *Can't tell*.
- **One shared teacher password**, no individual staff accounts yet. Glow/Microsoft sign-in is a later step.
- **Domain-level only**: allowing `bbc.co.uk` allows all of the BBC site.
- Opening a link needs a tap from the pupil. Android doesn't let apps push pages onto the screen.
- No screen view, app blocking or locking. These are out of scope for the MVP.
