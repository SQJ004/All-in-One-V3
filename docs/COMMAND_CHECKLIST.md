# ZYTHERON command checklist

**187 subcommands across 54 commands.** Generated from the code, with Music and Utility added by hand.

## What the two columns mean

**Automated: Passed** means `tests/integration/everyCommand.test.ts` ran the command through the real router with a fake Discord, and it responded and did not crash in each of these cases:

1. Required options only
2. Every option filled in
3. Invalid text in every text option
4. A deleted or unknown channel
5. A user without the required permission, where one is required (refused before doing anything)
6. A bot without the required permission, where one is declared (explained before doing anything)

Missing required options are enforced by Discord itself, so they cannot reach the bot. There is no database server to fail: data is JSON files, and failed saves are logged and retried.

**On Discord: ✅** means a real message or action was confirmed on Discord itself.

**On Discord: ☐** means **NOT VERIFIED**. A fake Discord cannot prove the real one accepts a message or that a real action happened, and bots cannot press slash commands. Tick each one as you try it.

## Try these first

These are safe on a real server: replies are private, or they only post where you choose.

1. `/setup`: shows what is missing
2. `/embed preview title:Test color:#8B5CF6`: private, posts nothing
3. `/embed create title:Test description:Hello channel:<a private channel>`: should appear in that channel
4. `/embed edit message_link:<link>` with `title:Changed`: the same message should change
5. `/embed builder`: use the menus and buttons, then press Post
6. `/embed delete message_link:<link>`: the message should disappear

Do **not** try these on real members: `/moderation ban tempban kick timeout jail massban masskick purge`, `/security lockdown on`, or security in enforce mode. Use an alt account.

## Security

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/security setup` | **log_channel** | ManageGuild | Passed | ☐ |
| `/security config` | None | ManageGuild | Passed | ☐ |
| `/security events` | None | ManageGuild | Passed | ☐ |
| `/security limit` | **action** **count** **window** | ManageGuild | Passed | ☐ |
| `/security punishment` | **action** recover | ManageGuild | Passed | ☐ |
| `/security raid` | **joins** **window** action auto_lockdown | ManageGuild | Passed | ☐ |
| `/security accounts` | **min_age_days** **action** | ManageGuild | Passed | ☐ |
| `/security whitelist add` | **target** | ManageGuild | Passed | ☐ |
| `/security whitelist remove` | **target** | ManageGuild | Passed | ☐ |
| `/security whitelist list` | None | ManageGuild | Passed | ☐ |
| `/security trusted add` | **user** | ManageGuild | Passed | ☐ |
| `/security trusted remove` | **user** | ManageGuild | Passed | ☐ |
| `/security trusted list` | None | ManageGuild | Passed | ☐ |
| `/security lockdown on` | **reason** | ManageGuild | Passed | ☐ |
| `/security lockdown off` | None | ManageGuild | Passed | ☐ |
| `/security lockdown raid-end` | None | ManageGuild | Passed | ☐ |
| `/automod status` | None | ManageGuild | Passed | ☐ |
| `/automod word-add` | **word** | ManageGuild | Passed | ☐ |
| `/automod word-remove` | **word** | ManageGuild | Passed | ☐ |
| `/automod caps` | **percent** | ManageGuild | Passed | ☐ |
| `/automod invites` | **block** | ManageGuild | Passed | ☐ |
| `/automod domain` | **list** **domain** remove | ManageGuild | Passed | ☐ |
| `/automod exempt` | **channel** remove | ManageGuild | Passed | ☐ |

## Logging

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/logs setup` | **channel** | ManageGuild | Passed | ☐ |
| `/logs status` | None | ManageGuild | Passed | ☐ |
| `/logs route` | **category** **channel** | ManageGuild | Passed | ☐ |
| `/logs toggle` | **category** **enabled** | ManageGuild | Passed | ☐ |
| `/logs ignore` | **channel** remove | ManageGuild | Passed | ☐ |
| `/logs off` | None | ManageGuild | Passed | ☐ |

## Moderation

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/moderation ban` | **user** reason delete_days | BanMembers | Passed | ☐ |
| `/moderation tempban` | **user** **duration** reason | BanMembers | Passed | ☐ |
| `/moderation unban` | **user_id** reason | BanMembers | Passed | ☐ |
| `/moderation kick` | **user** reason | KickMembers | Passed | ☐ |
| `/moderation timeout` | **user** **duration** reason | ModerateMembers | Passed | ☐ |
| `/moderation untimeout` | **user** reason | ModerateMembers | Passed | ☐ |
| `/moderation warn` | **user** **reason** | ModerateMembers | Passed | ☐ |
| `/moderation warnings` | **user** | ModerateMembers | Passed | ☐ |
| `/moderation clearwarnings` | **user** reason | ModerateMembers | Passed | ☐ |
| `/moderation purge` | **amount** user contains bots | ManageMessages | Passed | ☐ |
| `/moderation slowmode` | **duration** channel | ManageChannels | Passed | ☐ |
| `/moderation lock` | channel reason | ManageChannels | Passed | ☐ |
| `/moderation unlock` | channel reason | ManageChannels | Passed | ☐ |
| `/moderation hide` | channel reason | ManageChannels | Passed | ☐ |
| `/moderation unhide` | channel reason | ManageChannels | Passed | ☐ |
| `/moderation nickname` | **user** nickname | ManageNicknames | Passed | ☐ |
| `/moderation voicemute` | **user** **muted** reason | MuteMembers | Passed | ☐ |
| `/moderation voicedeafen` | **user** **deafened** reason | DeafenMembers | Passed | ☐ |
| `/moderation jail` | **user** duration reason | ModerateMembers, ManageRoles | Passed | ☐ |
| `/moderation unjail` | **user** reason | ModerateMembers, ManageRoles | Passed | ☐ |
| `/moderation massban` | **users** reason | BanMembers | Passed | ☐ |
| `/moderation masskick` | **users** reason | KickMembers | Passed | ☐ |
| `/moderation history` | **user** | ModerateMembers | Passed | ☐ |
| `/moderation note` | **user** **text** | ModerateMembers | Passed | ☐ |
| `/moderation notes` | **user** | ModerateMembers | Passed | ☐ |
| `/modconfig modlog` | **channel** | ManageGuild | Passed | ☐ |
| `/modconfig dm` | **enabled** | ManageGuild | Passed | ☐ |
| `/modconfig jail-setup` | role jail_channel | ManageGuild | Passed | ☐ |
| `/modconfig warn-threshold` | **warnings** **action** minutes | ManageGuild | Passed | ☐ |

## Welcome

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/welcome setup` | **channel** | ManageGuild | Passed | ☐ |
| `/welcome test` | None | ManageGuild | Passed | ☐ |
| `/welcome preview` | template goodbye | ManageGuild | Passed | ☐ |
| `/welcome edit` | **template** | ManageGuild | Passed | ☐ |
| `/welcome edit-goodbye` | None | ManageGuild | Passed | ☐ |
| `/welcome use` | **template** | ManageGuild | Passed | ☐ |
| `/welcome remove` | **template** | ManageGuild | Passed | ☐ |
| `/welcome card` | **template** enabled background accent | ManageGuild | Passed | ☐ |
| `/welcome goodbye` | **enabled** channel | ManageGuild | Passed | ☐ |
| `/welcome dm` | **enabled** message | ManageGuild | Passed | ☐ |
| `/welcome status` | None | ManageGuild | Passed | ☐ |

## Embeds

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/embed create` | channel title description color image thumbnail footer footer_icon author author_icon url timestamp | ManageMessages | Passed | ✅ 2026-11-05 |
| `/embed preview` | template title description color image thumbnail footer footer_icon author author_icon url timestamp | ManageMessages | Passed | ☐ |
| `/embed edit` | **message_link** embed_number title description color image thumbnail footer footer_icon author author_icon url timestamp | ManageMessages | Passed | ☐ |
| `/embed delete` | **message_link** | ManageMessages | Passed | ☐ |
| `/embed duplicate` | message_link channel template new_name | ManageMessages | Passed | ☐ |
| `/embed list` | None | ManageMessages | Passed | ☐ |
| `/embed builder` | channel | ManageMessages | Passed | ☐ |
| `/embed library` | None | ManageMessages | Passed | ☐ |
| `/embed export` | name message_link | ManageMessages | Passed | ☐ |
| `/embed import` | **file** | ManageMessages | Passed | ☐ |
| `/embed template save` | **name** message_link | ManageMessages | Passed | ☐ |
| `/embed template load` | **name** channel publish | ManageMessages | Passed | ☐ |
| `/embed template delete` | **name** | ManageMessages | Passed | ☐ |
| `/embed template list` | None | ManageMessages | Passed | ☐ |

## Roles

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/rolepanel create` | **name** **kind** **title** description behavior temporary required_role | ManageRoles | Passed | ☐ |
| `/rolepanel add` | **panel** **role** label emoji description | ManageRoles | Passed | ☐ |
| `/rolepanel remove` | **panel** **role** | ManageRoles | Passed | ☐ |
| `/rolepanel publish` | **panel** channel | ManageRoles | Passed | ☐ |
| `/rolepanel delete` | **panel** | ManageRoles | Passed | ☐ |
| `/rolepanel list` | None | ManageRoles | Passed | ☐ |
| `/autorole setup` | **human** bot | ManageRoles | Passed | ☐ |
| `/autorole add` | **for** **role** | ManageRoles | Passed | ☐ |
| `/autorole remove` | **role** | ManageRoles | Passed | ☐ |
| `/autorole list` | None | ManageRoles | Passed | ☐ |
| `/temprole add` | **user** **role** **duration** | ManageRoles | Passed | ☐ |
| `/temprole remove` | **user** **role** | ManageRoles | Passed | ☐ |
| `/selfrole list` | None | None | Passed | ☐ |
| `/selfrole get` | **role** | None | Passed | ☐ |
| `/selfrole drop` | **role** | None | Passed | ☐ |
| `/selfrole allow` | **role** | ManageRoles | Passed | ☐ |
| `/selfrole deny` | **role** | ManageRoles | Passed | ☐ |

## Tickets

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/ticket setup` | **staff** category transcripts notify max_open ratings | ManageGuild | Passed | ☐ |
| `/ticket panel-create` | **name** **title** description style color | ManageGuild | Passed | ☐ |
| `/ticket panel-category` | **panel** **label** description emoji staff discord_category welcome | ManageGuild | Passed | ☐ |
| `/ticket panel-publish` | **panel** channel | ManageGuild | Passed | ☐ |
| `/ticket add` | **user** | None | Passed | ☐ |
| `/ticket remove` | **user** | None | Passed | ☐ |
| `/ticket claim` | None | None | Passed | ☐ |
| `/ticket close` | None | None | Passed | ☐ |
| `/ticket reopen` | None | None | Passed | ☐ |
| `/ticket stats` | None | ManageGuild | Passed | ☐ |

## Automation

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/cc create` | **name** embed_template role | ManageGuild | Passed | ☐ |
| `/cc edit` | **name** | ManageGuild | Passed | ☐ |
| `/cc delete` | **name** | ManageGuild | Passed | ☐ |
| `/cc list` | None | None | Passed | ☐ |
| `/cc run` | **name** | None | Passed | ☐ |
| `/cc prefix` | **prefix** | ManageGuild | Passed | ☐ |
| `/autoresponse add` | **trigger** **response** match channel cooldown delete_trigger | ManageGuild | Passed | ☐ |
| `/autoresponse remove` | **trigger** | ManageGuild | Passed | ☐ |
| `/autoresponse list` | None | ManageGuild | Passed | ☐ |
| `/schedule recurring` | **name** **channel** **cron** message embed_template timezone | ManageGuild | Passed | ☐ |
| `/schedule once` | **name** **channel** **in** message embed_template | ManageGuild | Passed | ☐ |
| `/schedule list` | None | ManageGuild | Passed | ☐ |
| `/schedule toggle` | **name** | ManageGuild | Passed | ☐ |
| `/schedule delete` | **name** | ManageGuild | Passed | ☐ |
| `/rule create` | **name** **trigger** **action** keyword trigger_role text role channel minutes | ManageGuild | Passed | ☐ |
| `/rule add-action` | **name** **action** text role channel minutes | ManageGuild | Passed | ☐ |
| `/rule list` | None | ManageGuild | Passed | ☐ |
| `/rule toggle` | **name** | ManageGuild | Passed | ☐ |
| `/rule delete` | **name** | ManageGuild | Passed | ☐ |

## Community

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/level setup` | **enabled** announce_channel announce cooldown multiplier | ManageGuild | Passed | ☐ |
| `/level rank` | user | None | Passed | ☐ |
| `/level leaderboard` | None | None | Passed | ☐ |
| `/level reward` | **level** **role** remove | ManageGuild | Passed | ☐ |
| `/level set-xp` | **user** **xp** | ManageGuild | Passed | ☐ |
| `/level ignore` | **channel** remove | ManageGuild | Passed | ☐ |
| `/giveaway create` | **prize** **duration** winners channel required_role | ManageGuild | Passed | ☐ |
| `/giveaway end` | **giveaway** | ManageGuild | Passed | ☐ |
| `/giveaway reroll` | **giveaway** winners | ManageGuild | Passed | ☐ |
| `/giveaway list` | None | ManageGuild | Passed | ☐ |
| `/poll create` | **question** **options** duration multiple | ManageMessages | Passed | ☐ |
| `/poll close` | **message_id** | ManageMessages | Passed | ☐ |
| `/suggest` | **idea** | None | Passed | ☐ |
| `/suggestions setup` | **channel** | ManageGuild | Passed | ☐ |
| `/suggestions approve` | **number** reason | ManageGuild | Passed | ☐ |
| `/suggestions deny` | **number** reason | ManageGuild | Passed | ☐ |
| `/starboard setup` | **channel** threshold emoji self_star | ManageGuild | Passed | ☐ |
| `/starboard off` | None | ManageGuild | Passed | ☐ |
| `/invites user` | user | None | Passed | ☐ |
| `/invites leaderboard` | None | None | Passed | ☐ |
| `/serverstats view` | None | None | Passed | ☐ |
| `/serverstats counter` | **metric** label | ManageChannels | Passed | ☐ |
| `/serverstats counter-remove` | **channel** | ManageChannels | Passed | ☐ |
| `/birthday set` | **month** **day** | None | Passed | ☐ |
| `/birthday remove` | None | None | Passed | ☐ |
| `/birthday upcoming` | None | None | Passed | ☐ |
| `/birthday setup` | **channel** role | ManageGuild | Passed | ☐ |
| `/afk` | reason | None | Passed | ☐ |
| `/challenge setup` | **channel** **verified_role** type kick_after | ManageGuild | Passed | ☐ |
| `/challenge off` | None | ManageGuild | Passed | ☐ |
| `/profile view` | user | None | Passed | ☐ |
| `/profile edit` | None | None | Passed | ☐ |

## General

| Command | Options (bold = required) | User needs | Automated | On Discord |
|---|---|---|---|---|
| `/help` | None | None | Passed | ☐ |
| `/ping` | None | None | Passed | ☐ |
| `/setup` | None | ManageGuild | Passed | ☐ |

## Utility

These also work with `v!`. `tests/integration/utility.test.ts` covers both ways, with a fake Discord.

| Command | Options | Who can use it | Automated | Tested on Discord |
|---|---|---|---|---|
| `/user` | user | Everyone | Passed | ☐ |
| `/avatar` | user | Everyone | Passed | ☐ |
| `/server` | None | Everyone | Passed | ☐ |
| `/roles` | None | Everyone | Passed | ☐ |
| `/moveme` | **channel** | Be in a voice channel, with access to the target | Passed | ☐ |
| `/roll` | dice | Everyone | Passed | ☐ |

## Music

**Automated: Passed** here also covers `tests/integration/music.test.ts`, which plays real audio through the real decoder and audio player. A real Audius track was also played through them. Only Discord's voice servers are missing, so hearing the sound in a voice channel still needs the test below.

| Command | Options | Who can use it | Automated | Tested on Discord |
|---|---|---|---|---|
| `/play` | **song** | Be in a voice channel | Passed | ✅ |
| `/pause` | None | Be in the bot's voice channel | Passed | ☐ |
| `/resume` | None | Be in the bot's voice channel | Passed | ☐ |
| `/skip` | None | Be in the bot's voice channel | Passed | ☐ |
| `/stop` | None | Be in the bot's voice channel | Passed | ☐ |
| `/leave` | None | Be in the bot's voice channel | Passed | ☐ |
| `/queue` | None | None | Passed | ☐ |
| `/nowplaying` | None | None | Passed | ☐ |
| `/volume` | **level** | Be in the bot's voice channel | Passed | ☐ |
| `/loop` | None | Be in the bot's voice channel | Passed | ☐ |
| `/shuffle` | None | Be in the bot's voice channel | Passed | ☐ |
| `/remove` | **position** | Be in the bot's voice channel | Passed | ☐ |
| `/clearqueue` | None | Be in the bot's voice channel | Passed | ☐ |
| `/previous` | None | Be in the bot's voice channel | Passed | ☐ |
| `/seek` | **time** | Be in the bot's voice channel | Passed | ☐ |
| `/lyrics` | song | None | Passed | ☐ |
| `/youtube` | search | None. Watch Together needs a voice channel | Passed | ☐ |

Every command here also works with the `v!` prefix, such as `v!play lofi`.

Suggested test: join a voice channel, run `/play lofi`, and listen. Add a second song, then try each button and command. To test two servers, play in both at once and change the volume in one.
