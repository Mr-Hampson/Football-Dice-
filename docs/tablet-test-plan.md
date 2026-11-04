# Fire tablet feasibility test

The prototype is built so the first real-tablet session answers the open
questions in the decision log. Use **one or two spare tablets**, test names
(not real pupils), and a hub you control.

Record the results in the table at the bottom and update
[decision-log.md](decision-log.md).

## 0. Record the tablet

In the app, open **Technical details**. It shows the model, Android API
level and Fire OS build. Note them down.
(Fire OS 8 = API 30, Fire OS 7 = API 28, Fire OS 5 = API 22.)

## 1. Install

- [ ] Settings → Security & Privacy → **Apps from Unknown Sources**: allow the app you'll install from (Silk or Files).
- [ ] Install the APK. Does Fire OS show any extra warning? Does it install?
- [ ] On the dashboard, create a test class, add a test pupil, press **Get setup code**, and pair the tablet.
- [ ] Is the card on the dashboard **Connected** within a few seconds?

## 2. Foreground app (Usage access) – the core MVP question

- [ ] In the app, press **Open settings** next to *App tracking*. Does a Usage access screen open?
  - If not, the app explains the USB route. Enable Developer options (Settings → Device Options → About Fire Tablet → tap **Serial Number** seven times; check this on your model), then USB debugging, then run
    `adb shell appops set uk.school.classroomhub GET_USAGE_STATS allow`
- [ ] Start a lesson on the dashboard. Open Kindle, the home screen and Silk in turn. Does the card follow within about 5–10 seconds?

## 3. Website in Silk (accessibility) – the riskiest part

- [ ] Settings → Accessibility → **Classroom Hub website check** → On. Note exactly what Fire OS shows when it's switched on.
- [ ] With a lesson running and `bbc.co.uk` allowed, visit BBC Bitesize, then another site, in Silk.
- [ ] Open **Technical details** and record:
  - `domain`: was the right site detected?
  - `read from`: which element ID it came from
  - `address-bar candidates`: the list of IDs seen
- [ ] Scroll down a page so Silk hides its address bar. Does detection still work?
- [ ] Try a new tab, a Google search results page and a YouTube video page in Silk.

If `read from` shows an ID other than `com.amazon.cloud9:id/url_bar`, add it
to `KNOWN_URL_BAR_IDS` in `WebsiteCheckService.kt`.

## 4. Staying connected

- [ ] Let the screen turn off for 2 minutes, then wake it. How long until the card returns to **Connected** or **On task**?
- [ ] Turn Wi-Fi off and on again. Does it reconnect without opening the app?
- [ ] Restart the tablet. Does it reconnect without opening the app?
- [ ] Swipe the app away from recent apps. Does the connection survive?
- [ ] Leave it connected for a full lesson (about 50 minutes). Is it still connected? What happened to the battery?
- [ ] Settings → Apps → Classroom Hub → Force stop. Does the dashboard show **Not connected** within about 1 minute? (It should. It can't be prevented.)

## 5. Links

- [ ] Send a link to the whole class. Does a notification appear? Does the card show ✓ received?
- [ ] Tap it. Does Silk open the page, and does the card show ✓✓ opened?
- [ ] Send a link while the tablet is asleep or offline, then wake it. Does the notification arrive?

## 6. School Wi-Fi

- [ ] Do all of the above on the **school's public Wi-Fi** (not a home network). Is there a sign-in page the tablets must accept first? Does anything get blocked?

## Results

| Test | Tablet model / Fire OS | Result | Notes |
|---|---|---|---|
| Install | | | |
| Usage access (settings screen or adb) | | | |
| Foreground app accuracy | | | |
| Silk domain detected | | | `read from` = |
| Survives sleep / Wi-Fi drop / reboot | | | |
| Link received / opened | | | |
| School Wi-Fi | | | |
