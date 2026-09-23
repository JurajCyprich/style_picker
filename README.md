# Style Picker

Webová appka, v ktorej **admin vyberá, čo si pozvané osoby oblečú**, a to z ich vlastného šatníka.

## Ako to funguje

**Admin** (`/admin`)
- **Pozvánky**: vytvoríš jednorazový odkaz a pošleš ho osobe.
- **Ľudia**: prehľad všetkých a ich stav na zajtra. Po kliknutí na osobu sa otvorí editor outfitu:
  fotky osoby v T-póze (spredu aj zozadu), na ktoré **ťaháš oblečenie** (drag & drop alebo klik).
  Kúsky vieš posúvať, zväčšovať (koliesko alebo posuvník), otáčať, zrkadliť a vieš skryť biele pozadie fotky.
  Kúsky, ktoré osoba ponúkla, majú zelený okraj. Môžeš pridať poznámku. Tu tiež pridávaš a odoberáš tokeny.
- **Úlohy**: zadávaš úlohy s odmenou v tokenoch a vyhodnocuješ videá:
  *Splnené*, *Výnimka – uznať* (keď to nebolo úplne podľa zadania) alebo *Nesplnené*, s možnosťou pridať extra tokeny.
- **Nastavenia**: deadline (predvolene 19:00), týždenné tokeny (5), cena za oneskorenie (1), kategórie, heslo.

**Osoba** (príde cez pozvánku, potom sa vracia cez osobný odkaz `/me/…`)
- Pri registrácii zadá meno a nahrá fotku **spredu a zozadu v T-póze**.
- **Môj šatník**: odfotí kúsok, pomenuje ho a vyberie kategóriu (tričko, nohavice, …). Všetko sa uloží.
- **Outfit**: každý deň do **19:00** označí, z ktorých kúskov sa má zajtra vyberať, a odošle ponuku.
  Ak deadline nestihne, buď si zajtra **vyberie sama/sám**, alebo **zaplatí tokenom** a admin jej vyberie.
  Keď admin vyberie, osoba vidí outfit nasadený na svojej postave.
- **Tokeny**: každý pondelok +5. Keď sa minú, zarobí si ich v záložke **Úlohy** (nahrá video, na ktorom úlohu robí).

## Nasadenie na Vercel

1. Na [vercel.com/new](https://vercel.com/new) importuj repozitár `style_picker`. Nastavenia nechaj tak, ako sú (všetko je v `vercel.json`).
2. Pred prvým nasadením pridaj v **Environment Variables** premennú `ADMIN_PASSWORD`, teda tvoje admin heslo.
3. Klikni **Deploy**. Prvé nasadenie ešte nebude fungovať, lebo chýba databáza a úložisko.
4. V projekte otvor záložku **Storage**:
   - **Create Database → Turso** (databáza, bezplatný plán stačí) a pripoj ju k projektu.
     Tým sa nastavia `TURSO_DATABASE_URL` a `TURSO_AUTH_TOKEN`.
   - **Create → Blob** (fotky a videá) a pripoj ho k projektu. Tým sa nastaví `BLOB_READ_WRITE_TOKEN`.
5. **Deployments → … → Redeploy**. Hotovo: otvor adresu projektu a prihlás sa heslom.

Fotky a videá nahráva prehliadač priamo do Vercel Blob, takže limit 4,5 MB pre požiadavky na Verceli sa ich netýka
(fotka max 15 MB, video max 300 MB). Adresy súborov sú náhodné a nedajú sa uhádnuť, ale nie sú chránené heslom.

## Lokálne spustenie

Treba Node.js 20 alebo novší.

```bash
npm install
ADMIN_PASSWORD=mojeheslo npm start      # http://localhost:3000
```

Lokálne sa databáza aj súbory ukladajú do priečinka `data/`. Bez `ADMIN_PASSWORD` sa heslo pri prvom štarte vygeneruje a vypíše do konzoly.

| Premenná | Predvolené | Význam |
|---|---|---|
| `ADMIN_PASSWORD` | – | heslo admina (na Verceli povinné) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | lokálny súbor `data/style_picker.db` | databáza (Turso / libSQL) |
| `BLOB_READ_WRITE_TOKEN` | – (súbory sa ukladajú do `data/uploads`) | Vercel Blob úložisko |
| `APP_TIMEZONE` | `Europe/Bratislava` | časové pásmo pre deadline |
| `PORT`, `DATA_DIR` | `3000`, `./data` | len pre lokálne spustenie |

Testy: `npm test`. Prehliadačový klient pre Vercel Blob (`public/vendor/`) sa pregeneruje príkazom `npm run build:vendor`.
