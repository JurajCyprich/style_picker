'use strict';

// Lokálne spustenie (alebo vlastný server). Na Verceli sa použije api/index.js.
const { app, ready } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
ready()
  .then(() => app.listen(PORT, () => console.log(`Style Picker beží na http://localhost:${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });
