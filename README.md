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

## Spustenie

Treba Node.js 22.13 alebo novší (databáza je vstavaný `node:sqlite`, nič ďalšie netreba inštalovať).

```bash
npm install
ADMIN_PASSWORD=mojeheslo npm start      # http://localhost:3000
```

Bez `ADMIN_PASSWORD` sa heslo pri prvom štarte vygeneruje a vypíše do konzoly.

| Premenná | Predvolené | Význam |
|---|---|---|
| `PORT` | `3000` | port servera |
| `DATA_DIR` | `./data` | databáza a nahraté fotky a videá |
| `ADMIN_PASSWORD` | – | heslo admina |
| `TZ` | `Europe/Bratislava` | časové pásmo pre deadline |

Aby sa ľudia dostali na appku z mobilu, musí bežať na verejnej adrese (napr. VPS, Render, Fly.io, Railway)
s trvalým diskom pre `DATA_DIR`. Odkazy na fotky sú náhodné a nedajú sa uhádnuť, ale nie sú chránené heslom.

Testy: `npm test`
