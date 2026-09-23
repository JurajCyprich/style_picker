# Style Picker

Webová appka, v ktorej **admin vyberá, čo si pozvané osoby oblečú**, a to z ich vlastného šatníka.

## Ako to funguje

**Admin** (`/admin`)
- **Ľudia**: prehľad so štatistikami a fotkami v outfite, ktoré čakajú na kontrolu. Po kliknutí na osobu:
  - **kalendár na 2 týždne** s farebným stavom dní (outfit vybraný, ponuka poslaná, vyberá si sama),
  - **editor outfitu**: oblečenie ťaháš na fotku osoby v T-póze (spredu aj zozadu). Kúsky posúvaš, zväčšuješ a otáčaš myšou aj dvoma prstami,
  - **šablóny**: uložené kombinácie, ktoré použiješ jedným klikom,
  - **fotka v outfite**: schváliš ju, alebo zamietneš a strhneš tokeny,
  - **správy k outfitu** s možnosťou povoliť výnimku za tokeny,
  - **štatistiky**: čo vyberáš najčastejšie, čo ešte nikdy nemala na sebe, meškania, splnené úlohy.
- **Pozvánky**: jednorazové odkazy na registráciu.
- **Úlohy**: odmena v tokenoch, pre všetkých alebo pre vybraných ľudí. Úloha sa dá splniť koľkokrát chce osoba, len raz, alebo raz týždenne. Videá vyhodnocuješ ako *Splnené*, *Výnimka* alebo *Nesplnené*.
- **Nastavenia**: deadline, tokeny, kategórie, heslo, upozornenia, **záloha dát (.json)** a diagnostika.

**Osoba** (príde cez pozvánku, potom sa vracia cez osobný odkaz `/me/…`)
- **Registrácia po krokoch**: meno a fotka spredu a zozadu v T-póze.
- **Šatník**: odfotí kúsok, jedným ťuknutím **odstráni pozadie**, pomenuje ho a vyberie kategóriu. Kúsok vie označiť ako *v prádle* alebo *požičaný*.
- **Outfit**: každý deň do **19:00** pošle ponuku, z čoho sa má vyberať. Ak to nestihne, vyberie si sama alebo zaplatí tokenom.
  Vybraný outfit vidí na svojej postave, **odfotí sa v ňom** a môže adminovi **napísať správu**.
- **História**: galéria všetkých outfitov, aj tých naplánovaných dopredu.
- **Tokeny**: každý pondelok +5. Keď sa minú, zarobí si ich **úlohami** s video dôkazom.
- **Upozornenia na telefón**: outfit vybraný, odpoveď od admina, vyhodnotená úloha, pripomienka ponuky pred uzávierkou.
  Na iPhone fungujú, až keď si osoba appku pridá na plochu (Safari → Zdieľať → Pridať na plochu).

## Nasadenie na Vercel

1. Na [vercel.com/new](https://vercel.com/new) importuj repozitár `style_picker`. Nastavenia nechaj tak, ako sú (všetko je v `vercel.json`).
2. V **Environment Variables** pridaj `ADMIN_PASSWORD`, teda tvoje admin heslo.
3. Klikni **Deploy**.
4. V projekte otvor záložku **Storage** a pripoj k projektu:
   - **Turso** (databáza, bezplatný plán stačí),
   - **Blob** (fotky a videá; verejný aj súkromný funguje, appka si typ zistí sama).
5. **Deployments → ⋯ → Redeploy**. V appke potom v **Nastaveniach → Diagnostika** skontroluj, či je všetko zelené.

Fotky a videá nahráva prehliadač priamo do Vercel Blob (fotka max 15 MB, video max 300 MB). Blob funguje s kľúčom
`BLOB_READ_WRITE_TOKEN` aj bez neho (nové úložiská: `BLOB_STORE_ID` a prihlásenie cez Vercel OIDC).

**Pripomienky** spúšťa Vercel Cron (`vercel.json`): večer o 16:00 UTC (18:00 letný čas, 17:00 zimný) tým, ktorí ešte
neposlali ponuku, a ráno o 6:00 UTC tým, ktorí sa ešte neodfotili v dnešnom outfite. Ak nastavíš premennú
`CRON_SECRET`, Vercel ju posiela automaticky a nikto iný pripomienky nespustí.

## Lokálne spustenie

Treba Node.js 20 alebo novší.

```bash
npm install
ADMIN_PASSWORD=mojeheslo npm start      # http://localhost:3000
```

Lokálne sa databáza aj súbory ukladajú do priečinka `data/` a pripomienky kontroluje server každých 10 minút.
Bez `ADMIN_PASSWORD` sa heslo pri prvom štarte vygeneruje a vypíše do konzoly.

| Premenná | Predvolené | Význam |
|---|---|---|
| `ADMIN_PASSWORD` | – | heslo admina (na Verceli povinné) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | lokálny súbor `data/style_picker.db` | databáza (Turso / libSQL) |
| `BLOB_READ_WRITE_TOKEN` alebo `BLOB_STORE_ID` | – (súbory sa ukladajú do `data/uploads`) | Vercel Blob úložisko |
| `CRON_SECRET` | – | ochrana pripomienok (nepovinné) |
| `APP_TIMEZONE` | `Europe/Bratislava` | časové pásmo pre deadline |
| `PORT`, `DATA_DIR` | `3000`, `./data` | len pre lokálne spustenie |

Kľúče pre push notifikácie (VAPID) sa vygenerujú samy pri prvom použití a uložia do databázy.

Testy: `npm test`. Prehliadačový klient pre Vercel Blob (`public/vendor/`) sa pregeneruje príkazom `npm run build:vendor`.
