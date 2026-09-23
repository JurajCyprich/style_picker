'use strict';

// Lokálne spustenie (alebo vlastný server). Na Verceli sa použije api/index.js.
const { app, ready, currentCycle, runReminders } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;

// Pripomienky (na Verceli ich spúšťa Vercel Cron podľa vercel.json):
// večer 2 hodiny pred uzávierkou a ráno medzi 7:00 a 10:00. Každá sa pošle len raz.
async function reminderTick() {
  try {
    const cycle = await currentCycle();
    const now = Date.now();
    const deadline = new Date(cycle.deadline).getTime();
    if (now < deadline && now >= deadline - 2 * 3600 * 1000) await runReminders('evening');
    const hour = new Date().getHours();
    if (hour >= 7 && hour < 10) await runReminders('morning');
  } catch (e) {
    console.error('pripomienky', e);
  }
}

ready()
  .then(() => {
    app.listen(PORT, () => console.log(`Style Picker beží na http://localhost:${PORT}`));
    setInterval(reminderTick, 10 * 60 * 1000).unref();
  })
  .catch((e) => { console.error(e); process.exit(1); });
