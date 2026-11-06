// Full-screen join code for the classroom projector. Opened from the
// dashboard's "Show on the board" button; the lesson id is in the address
// after the #. Shows only the code, the lesson name and how many have joined:
// nothing about individual pupils, since the whole class can see it.

const $ = (id) => document.getElementById(id);
const lessonId = location.hash.slice(1);

async function refresh() {
  try {
    const res = await fetch(`/api/state?lessonId=${encodeURIComponent(lessonId)}`, { credentials: 'same-origin' });
    if (res.status === 401) {
      $('boardCode').textContent = '';
      $('boardCount').textContent = 'Log in on the dashboard in this browser first.';
      return;
    }
    const snap = await res.json();
    if (!snap.lesson) {
      $('boardCode').textContent = '';
      $('boardCount').textContent = snap.ended ? 'This lesson has ended.' : 'Start a lesson on the dashboard first.';
      return;
    }
    $('boardTitle').textContent = snap.lesson.title;
    $('boardCode').textContent = snap.lesson.joinCode;
    const n = snap.pupils.length;
    $('boardCount').textContent = `${n} joined`;
    document.title = `Join code ${snap.lesson.joinCode} – Classroom Hub`;
  } catch {
    $('boardCount').textContent = 'Reconnecting…';
  }
}

refresh();
setInterval(refresh, 4000);
