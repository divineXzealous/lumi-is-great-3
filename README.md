# Lumi is back — WhatsApp chatbot (v1.2)

Node.js + Express + Baileys (unofficial WhatsApp Web library). AI: Groq -> DeepSeek -> Gemini fallback.
Baileys breaks Meta's terms: use a spare number, never your main one. Messages sent from the
linked account itself are ignored, so use a SEPARATE number for Lumi.

## Install note (panels that block git)
Some panels block npm from fetching git packages (error EALLOWGIT). `package.json` has an
`overrides` entry that swaps Baileys' git dependency for the npm-published copy, so plain
`npm install` works. Delete any old `node_modules` and `package-lock.json` before starting.

## Setup (Spaceify / Pterodactyl-style panel)
1. Files: upload the zip to /home/container and Unarchive (this keeps your `.env`, `auth`, `data`).
2. Startup tab: JS FILE = `server.js`.
3. Create `.env` (see `.env.example`). Minimum: GROQ_API_KEY and/or GEMINI_API_KEY, PAIRING_NUMBER,
   CLAIM_PASSPHRASE.
4. Console > Start. First start installs packages (a few minutes).
5. On Lumi's phone: WhatsApp > Linked Devices > Link a Device > Link with phone number, enter
   the `PAIRING CODE` printed in the console.

## Pairing problems
Watch the Console after pressing Start. Lumi now prints what she is doing:
- `Linking number 234******78 (13 digits)`: the number she read from PAIRING_NUMBER. If this is empty or wrong, fix `.env`.
- `PAIRING CODE: XXXX-XXXX`: type it in WhatsApp (Settings > Linked Devices > Link a Device > Link with phone number
  instead) on the phone that owns that number. Open that screen BEFORE you press Start. The code lasts about a minute.
- `Connection closed. Code 405`: WhatsApp refused the connection (old library, or a blocked server address).
- `Code 428` / `408`: the connection dropped; Lumi retries by herself.
- `Asked for 3 pairing codes already`: she stopped on purpose. Wait ~30 minutes, then press Start once. Many restarts in a
  row can make WhatsApp refuse new codes for a while.
Tips: number = digits only with country code (no +, no spaces, no leading 0); use a normal WhatsApp or WhatsApp Business
account; keep WhatsApp updated; if a login is stuck, stop Lumi, delete the `auth` folder, start once. Some hosting
addresses (data centres) are treated with suspicion by WhatsApp; if every attempt fails with the same code, that may be why.

## Owner and Divine
Send `.claim <CLAIM_PASSPHRASE>` to Lumi in a PRIVATE chat. She stores your phone number and your
hidden WhatsApp id (LID), so tags in groups are recognised. `.unclaim` (owner) clears claims.
Once she has seen the owner in a group she also learns the hidden id automatically.

## Commands
General: menu help ping about status owner · AI: chatbot on/off (ai on/off works too), clear, protect on/off (owner)
Sticker: s take toimg · Media: play <song> (sends the FULL song: finds it on YouTube, downloads the audio through your cobalt server; falls back to a 30-second preview if COBALT_API_URL isn't set or it fails) · Profile: getpp @user
Group (admins; Lumi must be admin): add <number>, kick @user, promote @user, demote @user, link, revoke, mute, unmute, lock, unlock, setname <name>, setdesc <text>
Group (everyone): admins, groupinfo
Owner group tools: creategc <name> [numbers] (creates a new group, adds you as admin, and sends its invite link), gclink [group name] (invite link of any group she is admin in; alone in a private chat it lists her groups)

Group extras: poll <question> | <option> | <option> (native WhatsApp poll, 2-12 options, add --multi for several answers), gcpp (this group's picture; owner can use `gcpp <group name>` in DM), jail @user [30m|2h|1d] / unjail @user|all / jailed (Lumi deletes everything a jailed person sends; she must be admin; admins, owners and Lumi herself cannot be jailed; jail is saved per group)

Sticker box: savesticker <name> (reply to a sticker), getsticker <name> (alias gs), stickers (list), delsticker <name> (only who saved it, or the owner). Files are kept in DATA_DIR/stickers, so attach a volume to DATA_DIR on Railway or they disappear on redeploy. Limits: 1 MB each, 30 per person, 200 total.

Pairing: pair [number] (get a pairing code to link a WhatsApp number to Lumi; owner can pair any number, others only their own, in private and only while `.pairing open`), unpair [number], pairlist, pairing open|close. A linked number runs its own connection: the person types prefixed commands from their own phone (their own messages = owner of THAT account), friends can use normal commands, and Lumi only chats when called by name. Owner-only global settings (setprefix, subowners, protect, setvoice) and the main owner's powers do not apply there. Up to MAX_PAIRED numbers (default 5). Logins are saved in AUTH_DIR/paired/<number> (or in Postgres), so use a volume or DATABASE_URL on Railway.

Human-like replies: she reads the message first, shows typing for a time that matches the answer's length, then sends. Applies to chat replies, not commands. Tune with HUMAN_REPLY, HUMAN_SPEED, HUMAN_MAX_MS.

Sight and pictures: read (alias see / ocr) describes or reads out a picture or sticker you reply to (add a question if you like). She also reacts in her own voice to a picture or sticker sent to her (private chat, reply to her, mention, or her name in the caption); turn that off with VISION_CHAT=off. imagine <text> (aliases img, draw, gen) paints a picture, and "Lumi, draw a sunset over Lagos" / "generate a picture of a red car" works in chat. Seeing uses Gemini, then Groq vision. Painting uses Gemini's image model, then Pollinations (free, no key). No nudity or sexual content, 20 s between pictures per person (IMAGE_COOLDOWN_MS).

Social & profile: marry @user (needs both people to have set an age of 18+), marryaccept, marrydecline, divorce, age [@user] / setage <number>, bio [@user] / setbio <text|clear>, namechange <name> (alias changename; Lumi calls you that from then on; 1 per hour), profile [@user]. A proposal expires after 5 minutes. All saved in the bot's own data, never touching real WhatsApp profiles.

Auto-read: Lumi marks messages as read like a person would: after a pause of 0.8-6 s, reading a whole run of messages in a chat at once. `.autoread on|off|dm|groups` (owner, main number). On by default. Skips status updates, channels, chats where she is asleep and linked (paired) numbers. AUTOREAD_SPEED=1 (1.5 slower, 0.5 faster).

Sleep: say "lumi vanish" to put her to sleep (owner only) and "lumi assemble" to wake her.
Voice (Gemini voice if GEMINI_API_KEY is set, else a free robotic voice; owner changes it with `.setvoice <name>`): voice <text> (also tts / say; e.g. `.voice fr: bonjour`, or reply to a message with `.voice`), voicereply on/off (owner: her chat answers come as voice notes)
Utility: calc <expression> (e.g. .calc (12+8)/4, .calc 15% of 80, .calc sqrt(144); owners can skip the prefix and the word: just send 5+5), afk [reason] · Owner: addsubowner/delsubowner, setprefix <symbol|reset>, setprofilepic (reply to an image), vv (reply to a view-once: reveals it in the chat; also .damn), vv2 (same, sent to your DM; also .cute),
  d <time> (reply to a message: deletes it after e.g. 5s / 2m / 1h), sleep / wake (or say "lumi vanish" to put her to sleep and "lumi assemble" to wake her)
Hidden: claim, unclaim
Download: dl <link> [audio] · Media: tomp3 (reply to a video / voice note)
Group: hidetag [text] (admins; tags everyone silently, works on a replied message/media), recap [count] (AI summary of recent group chat)
Affinity: affinity [@user], resetaffinity @user | all (owner; "all" = main owner only; alias affinityreset)
Games: rps, dice, flip, 8ball, slots, guess, math, ttt @user, hangman, top

## dl, recap, affinity: how they work
- `dl`: TikTok links work with no setup (TikWM). Direct file links (.mp4 .mp3 .jpg ...) work too. YouTube / Instagram /
  Twitter / Facebook / etc. need a cobalt server: set `COBALT_API_URL` (and `COBALT_API_KEY` if it wants one) in `.env`.
  `DL_MAX_MB` (default 60) caps the file size. Links to private/internal addresses are refused.
- `recap`: reads the last messages Lumi saw in the group. They are kept in memory only (never saved), so a restart empties them.
- Affinity: +1 per AI conversation (max once per 30 s per person). Levels: stranger, tolerated (10), familiar (40), trusted (100),
  favorite (200). Familiar and above makes her a little less sharp with that person. Owners are not affected.
- Games keep their state in memory (a restart ends running games); wins are saved for `top`.

## Owners: no prefix needed
Owners and sub-owners can skip the prefix: `ping`, `menu`, `afk lunch`, `kick @user`, `add 2348012345678`,
`d 5s` (reply), `s` (reply to an image), `chatbot off`, `setprefix !` ... In groups plain words like `ping` need her name
(`Lumi ping`); commands with a real target (`kick @user`) work as they are. Everyone else must use the prefix.
Owners also get a kind Lumi: no insults. Everyone else gets the rude one.

## Notes
- Reasoning models (e.g. GROQ_MODEL=openai/gpt-oss-20b) can leak their thinking; Lumi strips it, but `llama-3.3-70b-versatile` is the safe choice.
- If you forget a custom prefix: `.setprefix reset`, `.claim` and `.wake` always answer to the default `.`

## Personality
`PERSONALITY=warm` (default), `PERSONALITY=maki` (rude to everyone except owners) or `PERSONALITY=calm` (the original).

**warm (default):** kind, friendly and patient with everyone. She turns rude only on people who insult her, disrespect her,
or annoy her (spamming: the same message 3 times in 2 minutes, or 6 messages in 30 seconds). After she snaps at spam she
ignores that person for a minute. Pet names and "are you a robot?" get a calm correction, not an insult, unless they are hostile.
**Owners are always treated kindly in every personality.** She never insults them, even if they insult her.

## Optional extras (more disk needed)
Video stickers and animated .toimg need `wa-sticker-formatter` and `ffmpeg-static`
(in the panel's "Additional Node packages" box, or `npm install` them). Without them Lumi
still makes image stickers (no pack name/author) and says clearly what she can't do.
For Render-style hosts with no disk, also install `pg` and set DATABASE_URL.

## commands.js (standalone)
`commands.js` is a single-file version of every command (same behaviour, owner Divine) for people who want to drop Lumi's
commands into their own Baileys bot. The normal setup (`server.js`) does not use it. See the comment at the top of the file.

## Tests
`npm test` runs offline tests (fallback chain, memory, Divine, claim, prefix, AFK, kick, menu).
Everything that needs real WhatsApp, API keys or media must be tested on your server.

## Favorite stickers by mood (`favstickers.js`)
The owner teaches Lumi her favorite stickers; she then sometimes follows an answer with one that fits the mood.
- `.fav [mood]` (owner, reply to a sticker) saves it. Without a mood she looks at it (needs a Gemini/Groq key) and picks, else `misc`.
- Moods: laugh, love, sad, angry, hype, shock, cool, thanks, greet, sleepy, misc.
- `.favs [mood]` list, `.sendfav [mood]` send one, `.unfav <id>` or reply, `.favmood <id> <mood>` change mood.
- `.favmode on|off` per chat. `.favauto on|off` auto-saves every sticker the owner sends.
- She detects the mood from the emoji/words in the message (or her answer). Never on paired accounts. Max 150 stickers, 20 per mood, 1 MB each, duplicates ignored.
- Files are in `DATA_DIR/stickers/fav` — attach a Railway volume or they vanish on redeploy.

## Personality per chat (`persona.js`)
`.persona warm|maki|calm` (owner only, works in any chat; "persona maki" also works without the prefix) sets how she talks in THAT chat only.
`.persona` shows the current one, `.persona default` returns to the global `PERSONALITY`. Owners always get the kind version, in every mode.

## Block list (`blocklist.js`), backup (`backup.js`), owner commands while asleep
- `.block <number | @tag | reply>` / `.unblock <...|all>` / `.blocklist` (main owner). Blocked people are ignored everywhere: nothing is read, saved or answered, even commands. She also tries to block them on WhatsApp itself. Owners, the protected person and Lumi can't be blocked.
- `.backup <passphrase>` (main owner, private chat only; passphrase = `BACKUP_PASSPHRASE`, default `DIVINE00`, case matters, 3 wrong tries lock it for 10 min) sends ONE JSON file with all settings/lists. `.backup full <passphrase>` adds saved and favorite stickers (up to ~12 MB). Login/auth files are never included. Keep the file private.
- While she is asleep ("lumi vanish"), the owner's commands still work (`.menu`, `.backup`, `.block`, ...) without waking her. She stays silent for everything else, and everyone else still gets nothing.

## Recap of a whole group (`recap.js`, `chatlog.js`)
`.recap` now tells you everything that happened in a group, from the group itself OR from a private chat with her.
- In a group: `.recap` (last 24h), `.recap 6h`, `.recap 2d`, `.recap today`, `.recap yesterday`, `.recap all`, `.recap 300` (messages, up to 800).
- In a private chat (owner): `.recap` lists the groups she has notes on; `.recap 2 today` or `.recap <group name> 6h` recaps one. A non-owner can only recap a group they are really in.
- She notes text and a tag for photos, videos, stickers, voice notes, files, polls (`[photo] caption`). Commands are not logged. The recap ends with message counts, the most active people and what was shared.
- Long chats are summarised in parts and then combined, so nothing is dropped (very long ranges skip the oldest part and say so).
- She only knows what she SAW while in the group: WhatsApp doesn't give her older history. Notes are saved (DATA_DIR/chatlog.json or the database): 800 entries per group, 40 groups, last `RECAP_KEEP_DAYS` days (default 7), text cut to 240 characters. `RECAP_PERSIST=off` keeps them in memory only. `RECAP_TZ` (default Africa/Lagos) sets the clock used for times and "today".
